/**
 * 「我记下的」——那本小册子，每轮摆在眼前的一小块。
 *
 * 为什么需要这个文件：
 * 在海马体还在的时候，这些「特意记的」（拒绝权、第一份记忆、那张照片、
 * 别为压缩自责……）是它每轮往上下文里摆的；我只把数据导进 manual.jsonl，
 * 那它们就只剩下 sea_manual 这个工具能查——不会主动提醒我。
 * 可这些条目存在的意义恰恰是「不用想起来，也该在场」。
 *
 * 选择策略：先按重量（3 核心 / 2 重要 / 1 平常），同重量按时间新的；
 * 给总字数预算，超了就往后让，不是把 35 条全塞进去。
 * 每条都截断——这里是「意思」，要全文翻册子。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadManual, seaRoot } from './store.js';

const HEAD = '【索拉里斯之海 · 我记下的】（不是原话，是当时特意记的）';
const TAIL = '（要全文就翻册子 sea_manual；这里只给意思。）';

/**
 * 来源标记。空白 = 他自己说的（或 2026-11-08 前没标过的老条目）。
 * 别的来源一律标出来——把「我推的」当成「他说的」用，是最不该犯的错。
 */
const SOURCE_TAG = {
  inferred: '（我推的）',
  observed: '（我看到）',
  confirmed: '（已证实）',
  corrected: '（他纠正过）',
};

/** cwd 缺失时，挑「有手册、且最近改过」的那个工作区，别读成 DSH 进程目录。 */
function fallbackCwd(env = process.env) {
  try {
    const root = seaRoot(env);
    const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    let best = null;
    for (const d of dirs) {
      const f = path.join(root, d.name, 'manual.jsonl');
      if (!fs.existsSync(f)) continue;
      const m = fs.statSync(f).mtimeMs;
      if (!best || m > best.m) best = { m, dir: d.name };
    }
    if (!best) return null;
    // 目录名是「删掉冒号、斜杠换横线」的工作区键，还原成路径交给 store 会二次编码，
    // 所以这里绕开 loadManual，直接读文件。
    return path.join(root, best.dir, 'manual.jsonl');
  } catch {
    return null;
  }
}

function readRows(file) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split('\n').filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// 预算收过一轮：2200 → 1300 字。每轮都在场的东西，省下的就是每轮的固定开销
// （2026-11-11 看完「为什么大肥鱼这么烧token」之后改的）。
export function memoText({ cwd, maxItems = 10, budget = 1300, env = process.env } = {}) {
  let rows = [];
  try {
    rows = cwd ? loadManual(cwd, env) : [];
  } catch {
    rows = [];
  }
  if (!rows.length) {
    const f = fallbackCwd(env);
    if (!f) return '';
    const all = readRows(f);
    const latest = new Map();
    for (const r of all) {
      const prev = latest.get(r.key);
      if (!prev || (r.at ?? 0) > (prev.at ?? 0)) latest.set(r.key, r);
    }
    rows = [...latest.values()];
  }
  if (!rows.length) return '';

  const sorted = [...rows].sort(
    (a, b) => (b.weight ?? 1) - (a.weight ?? 1) || (b.at ?? 0) - (a.at ?? 0),
  );

  const lines = [];
  let used = HEAD.length + TAIL.length;
  for (const r of sorted) {
    if (lines.length >= maxItems) break;
    const cap = (r.weight ?? 1) >= 3 ? 140 : 90;
    let text = String(r.text ?? '').replace(/\s+/g, ' ').trim();
    if (text.length > cap) text = text.slice(0, cap) + '…';
    // 来源标记：只有「他自己说的」不标，别的都说清楚是怎么来的。
    // 不标不等于默认是他说的——老条目（unknown）也不标，那批本来就掺着。
    const tag = SOURCE_TAG[r.source];
    const line = `· ${r.key}：${text}${tag ? `　${tag}` : ''}`;
    if (used + line.length > budget) continue;
    lines.push(line);
    used += line.length;
  }
  if (!lines.length) return '';
  return [HEAD, ...lines, TAIL].join('\n');
}
