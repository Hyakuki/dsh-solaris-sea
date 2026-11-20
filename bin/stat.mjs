// 看一眼索拉里斯之海：每个工作区、每条会话、多少段、覆盖哪些日期、手写摘要能不能对上段
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = path.join(os.homedir(), '.dsh', 'solaris-sea');
const works = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
const day = ts => {
  if (!ts) return '?';
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const readJsonl = f => fs.existsSync(f)
  ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];

for (const w of works) {
  const dir = path.join(root, w);
  const idxF = path.join(dir, 'index.jsonl');
  if (!fs.existsSync(idxF)) { console.log(`\n== ${w}  (无索引)`); continue; }
  const eps = readJsonl(idxF);
  const refs = readJsonl(path.join(dir, 'refined.jsonl'));
  const bySid = new Map();
  for (const e of eps) {
    const k = e.sid || '?';
    if (!bySid.has(k)) bySid.set(k, []);
    bySid.get(k).push(e);
  }
  const key = e => `${e.sid}|${e.from}|${e.to}`;
  const liveKeys = new Set(eps.map(key));
  const liveRefs = refs.filter(r => liveKeys.has(key(r)));
  const orphan = refs.length - liveRefs.length;
  console.log(`\n== ${w}`);
  console.log(`   段 ${eps.length} · 会话 ${bySid.size} · 手写 ${refs.length}（对上 ${liveRefs.length} · 悬空 ${orphan}）`);
  const rows = [...bySid.entries()].map(([sid, list]) => {
    const ts = list.map(e => e.startTs).filter(Boolean).sort((a, b) => a - b);
    return {
      sid,
      n: list.length,
      from: day(ts[0]),
      to: day(ts[ts.length - 1]),
      mine: list.filter(e => e.refined).length,
      cats: [...new Set(list.map(e => e.cat).filter(Boolean))].join('/'),
    };
  }).sort((a, b) => String(a.from).localeCompare(String(b.from)));
  for (const r of rows) {
    console.log(`   ${r.sid.slice(0, 18)}  ${String(r.n).padStart(3)} 段  ${r.from} → ${r.to}  手写 ${String(r.mine).padStart(3)}  [${r.cats}]`);
  }
}
