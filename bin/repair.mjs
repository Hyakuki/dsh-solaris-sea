// 把悬空的手写摘要重新挂到现在的段上。
// 悬空的原因：切段规则改过一次，整条会话的段边界重排，老的 from/to 对不上任何现存段。
// 原话没丢（还在会话日志里），丢的只是我手写的那句人话摘要——所以按 seq 落点重锚一下。
//
// 用法：node bin/repair.mjs [--write]
//   不带 --write 只报告；带 --write 才落盘（先备份 refined.jsonl）。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const WORKSPACE = 'C-Users-Mioko-Documents-deepseek-harness-default-workspace';
const dir = path.join(os.homedir(), '.dsh', 'solaris-sea', WORKSPACE);
const readJsonl = f => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const eps = readJsonl(path.join(dir, 'index.jsonl'));
const refs = readJsonl(path.join(dir, 'refined.jsonl'));
const write = process.argv.includes('--write');

const liveKey = r => `${r.sid}|${r.from}|${r.to}`;
const liveExact = new Set(eps.map(liveKey));
const liveFrom = new Set(eps.map(e => `${e.sid}|${e.from}`));

const bySid = new Map();
for (const e of eps) {
  if (!bySid.has(e.sid)) bySid.set(e.sid, []);
  bySid.get(e.sid).push(e);
}
for (const list of bySid.values()) list.sort((a, b) => a.from - b.from);

/** 给一条悬空的摘要找现在该挂在哪个段上：seq 落在段内 → 那一段；否则取起点最近且在它前面的段。 */
function reanchor(r) {
  const list = bySid.get(r.sid) || [];
  if (!list.length) return null;
  const inside = list.find(e => r.from >= e.from && r.from <= e.to);
  if (inside) return inside;
  let best = null;
  for (const e of list) if (e.from <= r.from) best = e;
  return best || list[0];
}

const orphans = refs.filter(r => !liveExact.has(liveKey(r)) && !liveFrom.has(`${r.sid}|${r.from}`));
const fixed = [];
const stuck = [];
for (const r of orphans) {
  const target = reanchor(r);
  if (!target) { stuck.push(r); continue; }
  fixed.push({ ...r, from: target.from, to: target.to, reanchored: `${r.from}-${r.to}` });
}

console.log(`悬空 ${orphans.length} · 能重挂 ${fixed.length} · 挂不上 ${stuck.length}`);
for (const r of fixed.slice(0, 10)) console.log(`  ${r.reanchored} → ${r.from}-${r.to}  "${(r.head || '').slice(0, 22)}"`);
for (const r of stuck) console.log(`  挂不上: ${r.sid.slice(9, 21)} ${r.from}-${r.to} "${(r.head || '').slice(0, 22)}"`);

if (!write) { console.log('\n（只报告，没落盘。加 --write 才会写。）'); process.exit(0); }

// 落盘：保留能精确对上的 + 重挂的；同一 sid#from#to 只留最新一条
const keep = refs.filter(r => liveExact.has(liveKey(r)) || liveFrom.has(`${r.sid}|${r.from}`));
const merged = new Map();
for (const r of [...keep, ...fixed]) {
  const k = liveKey(r);
  const old = merged.get(k);
  if (!old || (r.at ?? 0) >= (old.at ?? 0)) merged.set(k, r);
}
const out = [...merged.values()].sort((a, b) => String(a.sid).localeCompare(b.sid) || a.from - b.from);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.copyFileSync(path.join(dir, 'refined.jsonl'), path.join(dir, `refined.bak-${stamp}.jsonl`));
fs.writeFileSync(path.join(dir, 'refined.jsonl'), out.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
console.log(`\n写入 ${out.length} 条（原 ${refs.length} 条，合并重复 ${refs.length + fixed.length - out.length} 条）`);
console.log(`备份 refined.bak-${stamp}.jsonl`);
