#!/usr/bin/env node
/**
 * bin/backfill.mjs — 给已有的手写摘要补一个**时间锚** `ts`。
 *
 * 为什么要有这个：`from/to` 是会话日志里的记录序号，上下文压缩会把被折叠的那一段
 * 从日志里换掉，序号整体往后缩——一条会话压一次，所有 seq 全漂。11-19 梳理老会话时
 * 才发现 181 条手写摘要里有 58 条挂空，就是因为这个。
 * 时间戳不会被压缩改写，所以从现在起每条摘要都顺手存一份 `ts`（段的 startTs），
 * 漂了还能按时间找回来（见 src/refresh.js 的 pickRefined）。
 *
 * 这个脚本是给**存量**补的：只给那些现在还找得到对应段的条目补，挂空的补不了
 * （它们要等梳理到那些日子时重写）。
 *
 * 用法：
 *   node bin/backfill.mjs --cwd <工作区> [--write]
 * 不给 --write 只报告，不落盘。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { patchedIndex } from '../src/refresh.js?v=6';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    // --write 这种开关不带值：后面没有东西、或者紧跟另一个 --xxx，就当成 true。
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { args[a.slice(2)] = 'true'; } else { args[a.slice(2)] = argv[++i]; }
    } else { args._.push(a); }
  }
  return args;
}

const args = parseArgs(process.argv);
const cwd = args.cwd || process.cwd();
const write = args.write !== undefined && args.write !== 'false';

const root = process.env.DSH_SOLARIS_SEA || path.join(os.homedir(), '.dsh', 'solaris-sea');
const key = String(cwd).replace(/[:]/g, '').replace(/[\\/]/g, '-');
const localFile = path.join(root, key, 'refined.jsonl');
const globalFile = path.join(root, 'refined-global.jsonl');

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* 坏行跳过 */ }
  }
  return out;
}

function fmt(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const rows = patchedIndex(cwd);
const byKey = new Map();
const byStart = new Map();
for (const ep of rows) {
  byKey.set(`${ep.sid}#${ep.from}#${ep.to}`, ep);
  if (!byStart.has(`${ep.sid}#${ep.from}`)) byStart.set(`${ep.sid}#${ep.from}`, ep);
}

function fill(list, label) {
  let filled = 0;
  let already = 0;
  let missed = 0;
  for (const r of list) {
    if (r.ts != null) { already += 1; continue; }
    const ep = byKey.get(`${r.sid}#${r.from}#${r.to}`) || byStart.get(`${r.sid}#${r.from}`);
    if (!ep) { missed += 1; continue; }
    r.ts = ep.startTs;
    filled += 1;
  }
  console.log(`${label}: 补上 ${filled} · 本来就有 ${already} · 找不到段 ${missed}（共 ${list.length}）`);
  return { filled, missed };
}

const local = readJsonl(localFile);
const global = readJsonl(globalFile);
const a = fill(local, '工作区那份');
const b = fill(global, '全局那份');

if (!write) {
  console.log('（只报告，没写盘。加 --write 才真写。）');
} else {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const [file, list] of [[localFile, local], [globalFile, global]]) {
    if (!fs.existsSync(file)) continue;
    fs.copyFileSync(file, `${file}.bak-${stamp}`);
    fs.writeFileSync(file, list.map((r) => JSON.stringify(r)).join('\n') + (list.length ? '\n' : ''), 'utf8');
  }
  console.log(`写好了（备份 *.bak-${stamp}）`);
  console.log(`还挂空的：工作区 ${a.missed} 条 · 全局 ${b.missed} 条 —— 这些要等梳理到那些日子时重写。`);
}
