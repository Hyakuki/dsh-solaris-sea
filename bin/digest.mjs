#!/usr/bin/env node
// 把索引摊开成「一段一块」的样子，给人看、也给我自己写摘要时看。
// 用法：
//   node bin/digest.mjs --cwd <工作区> [--day 2026-11-06] [--from 2026-11-01 --to 2026-11-05] [--only todo] [--limit 20]
// 只用读，不改任何东西。

import { patchedIndex } from '../src/refresh.js?v=6';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    out[k] = v;
  }
  return out;
}

const fmt = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const dayOf = (ts) => fmt(ts).slice(0, 10);

const args = parseArgs(process.argv.slice(2));
if (!args.cwd) {
  console.error('用法：node bin/digest.mjs --cwd <工作区> [--day 2026-11-06] [--from ...] [--to ...] [--only todo|done|all] [--limit N]');
  process.exit(1);
}

let rows = patchedIndex(args.cwd).slice().sort((a, b) => a.startTs - b.startTs);
if (args.day) rows = rows.filter((r) => dayOf(r.startTs) === args.day);
if (args.from) rows = rows.filter((r) => dayOf(r.startTs) >= args.from);
if (args.to) rows = rows.filter((r) => dayOf(r.startTs) <= args.to);
const only = args.only || 'all';
if (only === 'todo') rows = rows.filter((r) => !r.refined);
if (only === 'done') rows = rows.filter((r) => r.refined);
if (args.limit) rows = rows.slice(0, Number(args.limit));

let lastDay = '';
for (const r of rows) {
  const d = dayOf(r.startTs);
  if (d !== lastDay) {
    console.log(`\n=== ${d} ===`);
    lastDay = d;
  }
  const tag = r.refined ? '[手写]' : '[机器]';
  console.log(`\n#${r.id} ${fmt(r.startTs)} ${tag} ${String(r.sid).slice(0, 20)} ${r.from}-${r.to}`);
  console.log(`  头：${r.head}`);
  // 只取头尾各一条要点之外的，全部给太长；给最多 4 条，中间跳过
  const pts = r.points || [];
  const show = pts.length <= 4 ? pts : [pts[0], pts[1], pts[pts.length - 2], pts[pts.length - 1]];
  if (show.length) console.log(`  点：${show.map((p) => '「' + p + '」').join(' ')}${pts.length > show.length ? `（共${pts.length}条）` : ''}`);
  if (r.kw?.length) console.log(`  词：${r.kw.join(' ')}`);
}

console.log(`\n共 ${rows.length} 段（${rows.filter((r) => r.refined).length} 段已手写）`);
