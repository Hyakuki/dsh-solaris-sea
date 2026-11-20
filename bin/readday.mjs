// 夜间巩固用：把某天「还没有手写摘要」的段，连同它们原话的头尾几行，一起摊出来。
// 用法：node bin/readday.mjs [--day 2026-11-19] [--cwd 工作区] [--max 6]
import { patchedIndex, ensureFresh } from '../src/refresh.js?v=7';
import { readOriginal } from '../src/query.js?v=7';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const n = argv[i + 1];
    if (n === undefined || n.startsWith('--')) out[k] = 'true';
    else { out[k] = n; i++; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const cwd = args.cwd || 'C:\\Users\\Mioko\\Documents\\deepseek-harness\\default-workspace';
const maxLines = Number(args.max || 6);
ensureFresh(process.env, 0);

const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const day = args.day || `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const key = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const hm = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const rows = patchedIndex(cwd).filter((ep) => key(ep.startTs) === day && !ep.refined);
console.log(day + ' 缺手写 ' + rows.length + ' 段');

for (const ep of rows) {
  console.log('');
  console.log(`=== ${hm(ep.startTs)}-${hm(ep.endTs)}  ${String(ep.sid).slice(8, 16)} ${ep.from}-${ep.to}  ${ep.chars}字`);
  const r = readOriginal({ cwd, sid: ep.sid, from: ep.from, to: ep.to });
  if (!r.ok) { console.log('（读不到：' + r.reason + '）'); continue; }
  // who 实际给的是 user / assistant（不是 他 / 我），两种都认。
  const isHis = (w) => w === '他' || w === 'user';
  const his = r.msgs.filter((m) => isHis(m.who));
  const mine = r.msgs.filter((m) => !isHis(m.who));
  if (!his.length) for (const m of r.msgs.slice(0, maxLines)) console.log('  ·' + m.who + ' ' + String(m.text || '').replace(/\s+/g, ' ').slice(0, 90));
  const pick = (arr) => (arr.length <= maxLines ? arr : [...arr.slice(0, 3), ...arr.slice(-(maxLines - 3))]);
  for (const m of pick(his)) console.log('  他 ' + String(m.text).replace(/\s+/g, ' ').slice(0, 90));
  console.log('  ——');
  for (const m of pick(mine).slice(0, 3)) console.log('  我 ' + String(m.text).replace(/\s+/g, ' ').slice(0, 60));
}
