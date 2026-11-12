/**
 * store.js — 索拉里斯之海落盘的那几样东西。
 *
 * 目录（每个工作区一份，纯文本，坏了能手改）：
 *   ~/.dsh/solaris-sea/<工作区>/index.jsonl   每段一行：摘要/要点/关键词/重量/指针
 *   ~/.dsh/solaris-sea/<工作区>/topics.json   关键词 → 片段编号
 *   ~/.dsh/solaris-sea/<工作区>/manual.jsonl  特意记的（remember）
 *   ~/.dsh/solaris-sea/<工作区>/state.json    水位与统计
 *
 * 原则：**原话不抄**。index 里只有摘要与指针（sid + seq 区间），
 * 要原话就回会话日志里读。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function seaRoot(env = process.env) {
  return env.DSH_SOLARIS_SEA || path.join(os.homedir(), '.dsh', 'solaris-sea');
}

export function workspaceKey(cwd) {
  return String(cwd).replace(/[:]/g, '').replace(/[\\/]/g, '-');
}

export function seaDir(cwd, env = process.env) {
  const dir = path.join(seaRoot(env), workspaceKey(cwd));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 已经建过索引的工作区（目录名 = 编码后的工作区路径）。 */
export function listWorkspaces(env = process.env) {
  const root = seaRoot(env);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((name) => {
    try { return fs.statSync(path.join(root, name)).isDirectory(); } catch { return false; }
  });
}

const p = (...parts) => path.join(...parts);

export function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* 坏行跳过，别整包作废 */ }
  }
  return out;
}

export function appendJsonl(file, obj) {
  fs.appendFileSync(file, `${JSON.stringify(obj)}\n`, 'utf8');
}

export function writeJsonl(file, rows) {
  const body = rows.map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(file, body ? `${body}\n` : '', 'utf8');
}

/** 读全部片段（可按工作区聚合时循环调用）。 */
export function loadIndex(cwd, env) {
  return readJsonl(p(seaDir(cwd, env), 'index.jsonl'));
}

/** 按**已编码的工作区 key** 读索引（不创建目录，用来遍历所有工作区）。 */
export function loadIndexAt(key, env = process.env) {
  return readJsonl(p(seaRoot(env), key, 'index.jsonl'));
}

export function loadTopicsAt(key, env = process.env) {
  const file = p(seaRoot(env), key, 'topics.json');
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

/** 用新的片段替换整份索引（重建）。 */
export function saveIndex(cwd, episodes, env) {
  const dir = seaDir(cwd, env);
  writeJsonl(p(dir, 'index.jsonl'), episodes);
  // 主题表：关键词 → 片段 id 列表
  const topics = {};
  episodes.forEach((ep) => {
    for (const k of ep.kw ?? []) {
      (topics[k] ||= []).push(ep.id);
    }
  });
  fs.writeFileSync(p(dir, 'topics.json'), JSON.stringify(topics, null, 0), 'utf8');
  return episodes.length;
}

export function loadTopics(cwd, env) {
  const file = p(seaDir(cwd, env), 'topics.json');
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

export function loadState(cwd, env) {
  const file = p(seaDir(cwd, env), 'state.json');
  if (!fs.existsSync(file)) return { builtAt: 0, sessions: {}, counts: {} };
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { builtAt: 0, sessions: {}, counts: {} }; }
}

export function saveState(cwd, state, env) {
  fs.writeFileSync(p(seaDir(cwd, env), 'state.json'), JSON.stringify(state, null, 2), 'utf8');
}

/**
 * 这条记忆是哪来的。**不是分类癖**——它决定我能不能把一句话当成「他说过」。
 *   explicit  他自己说的（原话可查）
 *   observed  我直接看到的（日志、文件、工具输出）
 *   inferred  我推的（不能当他说过用）
 *   confirmed 后来被证实/被纠正过的
 *   corrected 他明确纠正过的（旧说法作废）
 *   unknown   2026-11-08 之前的老条目，没标过来源
 */
export const SOURCES = ['explicit', 'observed', 'inferred', 'confirmed', 'corrected', 'unknown'];

/**
 * 特意记的那本小册子。同一 key 新的盖旧的（旧的留在文件里，不删）。
 *
 * `supersedes` 记下被它盖掉的那条的 `at`：这样「你说的」和「你现在说的」之间
 * 有时间线，不是只剩最后一句。老的留着小改时还能看出变化。
 */
export function rememberKey(
  cwd,
  { key, text, weight = 1, at = Date.now(), source = 'explicit', supersedes },
  env,
) {
  const file = p(seaDir(cwd, env), 'manual.jsonl');
  const src = SOURCES.includes(source) ? source : 'unknown';
  let prevAt = supersedes;
  if (prevAt === undefined) {
    // 同 key 上一条 → 记成「被它取代」
    const prior = readJsonl(file).filter((r) => r.key === key);
    if (prior.length) prevAt = prior[prior.length - 1].at;
  }
  const row = { key, text, weight, at, source: src };
  if (prevAt !== undefined) row.supersedes = prevAt;
  appendJsonl(file, row);
  return row;
}

export function loadManual(cwd, env) {
  const rows = readJsonl(p(seaDir(cwd, env), 'manual.jsonl'));
  // 同 key 只保留最新一条
  const latest = new Map();
  for (const r of rows) {
    if (!latest.has(r.key) || (r.at ?? 0) >= (latest.get(r.key).at ?? 0)) latest.set(r.key, r);
  }
  return [...latest.values()]
    .map((r) => ({ ...r, source: SOURCES.includes(r.source) ? r.source : 'unknown' }))
    .sort((a, b) => b.at - a.at);
}
