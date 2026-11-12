/**
 * logs.js — 把会话日志读成「一条条消息」。
 *
 * 为什么不能直接 readFile：
 *   日志是 **一串独立 zstd 帧**（一帧一条记录，追加写入）。node 的
 *   `zstdDecompressSync` / 流式解压**只解第一帧就停**，拿到的永远只有
 *   文件开头那一行 `type:"session"`。这是这块地基上最容易踩的坑：
 *   表现是「明明有几千行，只读出 1 行」，而且不报错。
 *
 * 做法：扫描 zstd 帧魔数 `28 B5 2F FD`，从每个候选偏移单独解压；
 * 解出来的东西必须能 JSON.parse 成带 `type` 的对象才算数。
 * 压缩数据里也可能出现这 4 个字节（假阳性），所以**只信能解析的**，
 * 并按 `type+seq+time` 去重。
 *
 * 坐标系：这里返回的 `seq` 就是日志里的 seq，索拉里斯之海的「指针」
 * 就是 `sid + seq 区间`——原话不另存，回头照这个坐标重读。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/** 会话根目录（可用 DSH_SOLARIS_SESSIONS 覆盖，主要给测试用）。 */
export function sessionsRoot(env = process.env) {
  return env.DSH_SOLARIS_SESSIONS || path.join(os.homedir(), '.dsh', 'sessions');
}

/**
 * 把工作区路径编码成 `~/.dsh/sessions/` 下的目录名。
 * 实测规则（差点写错）：**冒号是删掉的，不是换成 `-`**，反斜杠/斜杠才换成 `-`。
 *   `C:\Users\x` → `--C-Users-x--`（只有一个连字符，不是两个）。
 */
export function workspaceDirName(cwd) {
  const slashed = String(cwd).replace(/[:]/g, '').replace(/[\\/]/g, '-');
  return `--${slashed}--`;
}

/** 列出某个工作区下的会话：`[{ sid, file, dir }]`（只收存在日志文件的）。 */
export function listSessions(cwd, env = process.env) {
  const dir = path.join(sessionsRoot(env), workspaceDirName(cwd));
  return sessionsInDir(dir);
}

/**
 * 列出**所有工作区**下的会话（用在工作区不确定的时候）。
 *
 * 这是踩过的坑：插件里 `process.cwd()` 是 **DSH 进程的目录**，不是会话的工作区。
 * 第一版拿它当默认值，于是工具永远在一个空目录里找索引，表现成「什么都找不到」。
 * 所以默认行为改成「全都要」，而不是猜一个 cwd。
 */
export function listAllSessions(env = process.env) {
  const root = sessionsRoot(env);
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const workspace of fs.readdirSync(root)) {
    const dir = path.join(root, workspace);
    try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
    for (const s of sessionsInDir(dir)) out.push({ ...s, workspace });
  }
  return out;
}

function sessionsInDir(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const sub = path.join(dir, name);
    let st;
    try { st = fs.statSync(sub); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of ['session.v4.jsonl.zstd', 'session.jsonl.zstd', 'session.jsonl']) {
      const file = path.join(sub, f);
      if (fs.existsSync(file)) { out.push({ sid: name, dir: sub, file }); break; }
    }
  }
  return out;
}

/** 解出文件里所有能解析的记录（多帧扫描）。 */
export function readRecords(file) {
  // 缓存：同一个文件（大小+mtime 没变）解一次就够。
  // 一次原话回溯要扫三个会话（15MB + 6.8MB + 0.9MB），不缓存的话每次都重解。
  try {
    const st = fs.statSync(file);
    const key = `${file}|${st.size}|${st.mtimeMs}`;
    const hit = RECORD_CACHE.get(key);
    if (hit) return hit;
    const out = readRecordsRaw(file);
    RECORD_CACHE.set(key, out);
    while (RECORD_CACHE.size > 6) RECORD_CACHE.delete(RECORD_CACHE.keys().next().value);
    return out;
  } catch {
    return readRecordsRaw(file);
  }
}

const RECORD_CACHE = new Map();

function readRecordsRaw(file) {
  const buf = fs.readFileSync(file);
  if (buf.length >= 4 && buf[0] === 0x7b /* '{' —— 已是明文 jsonl */) {
    return buf.toString('utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  }
  const offsets = [];
  for (let i = 0; i <= buf.length - 4; i += 1) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1]
      && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) offsets.push(i);
  }
  // 兜底：如果魔数一个都没扫到，仍然按「整个文件是一帧」试一次。
  if (offsets.length === 0) offsets.push(0);

  const seen = new Set();
  const records = [];
  for (let i = 0; i < offsets.length; i += 1) {
    const off = offsets[i];
    // **一定要切到下一帧开头再解**：拿 buf.subarray(off)（剩下整个文件）去解，
    // 解码器要处理到文件末尾，几百上千帧叠起来就是 O(n²)——曾经把整个查询卡死过。
    const end = offsets[i + 1] ?? buf.length;
    let text;
    try {
      text = zlib.zstdDecompressSync(buf.subarray(off, end)).toString('utf8');
    } catch {
      try {
        text = zlib.zstdDecompressSync(buf.subarray(off)).toString('utf8');
      } catch { continue; }
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let rec;
      try { rec = JSON.parse(trimmed); } catch { continue; }
      if (!rec || typeof rec !== 'object' || !rec.type) continue;
      const key = `${rec.type}#${rec.seq ?? ''}#${rec.time ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      records.push(rec);
    }
  }
  records.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || (a.time ?? 0) - (b.time ?? 0));
  return records;
}

/** 从一个 message 记录里抽出纯文本（content 可能是数组）。 */
export function textOf(record) {
  const content = record?.data?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block) continue;
    if (typeof block === 'string') { parts.push(block); continue; }
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    // 图片/附件：只留一个占位，别把 base64 读进来。
    else if (block.type === 'image') parts.push('[图]');
  }
  return parts.join('\n').trim();
}

/**
 * 把记录过滤成「消息流」：`[{ seq, time, role, text, kind }]`
 *   role: 'user' | 'assistant' | 'tool'
 *   kind: 'user' | 'assistant' | 'tool'
 *
 * **只收 `source.kind === 'user'` 的 user 消息。** 这一条是必须的：
 * 日志里同一个 `user/message` 类型还装着大量**注入物**——`runtime-context`
 * `time-context` `skill-catalog` `compact-checkpoint` `tool-jobs` `schedule`……
 * 实测某条线的 1384 条消息里，真人说话只有 627 条，剩下全是这些。
 * 不过滤的后果是：索引里全是"Current runtime context. This snapshot supersedes…"，
 * 搜什么都能搜到它，等于没索引。
 */
export function extractMessages(records) {
  const out = [];
  for (const rec of records) {
    if (rec.type === 'user/message') {
      const from = rec?.data?.source?.kind;
      if (from && from !== 'user') continue; // 注入物，不是人说的话
      const text = textOf(rec);
      if (!text) continue;
      out.push({ seq: rec.seq, time: rec.time, role: 'user', kind: 'user', text });
    } else if (rec.type === 'assistant/message') {
      const text = textOf(rec);
      if (!text) continue;
      out.push({ seq: rec.seq, time: rec.time, role: 'assistant', kind: 'assistant', text });
    } else if (rec.type === 'tool/result') {
      const text = textOf(rec);
      if (!text) continue;
      out.push({ seq: rec.seq, time: rec.time, role: 'tool', kind: 'tool', text });
    }
  }
  return out;
}

/** 读一个会话的全部消息。 */
export function readSessionMessages(session) {
  return extractMessages(readRecords(session.file));
}

/** 读某个会话里 seq 落在 [from, to] 的原话（供 recall/trace 回读）。 */
export function readRange(session, from, to) {
  return readSessionMessages(session).filter((m) => m.seq >= from && m.seq <= to);
}
