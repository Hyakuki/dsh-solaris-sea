// 夜间巩固用：列出某一天的所有段，看哪些还没有手写摘要。
// 用法：node bin/today.mjs [--day 2026-11-19] [--cwd 工作区]
import { patchedIndex, ensureFresh } from '../src/refresh.js?v=7';

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
ensureFresh(process.env, 0);

const rows = patchedIndex(cwd);
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const day = args.day || `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

const fmt = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const same = rows.filter((ep) => {
  const d = new Date(ep.startTs);
  const k = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return k === day;
});

console.log(day + ' 共 ' + same.length + ' 段');
let missing = 0;
for (const ep of same) {
  const mark = ep.refined ? '有' : '缺';
  if (!ep.refined) missing++;
  const head = String(ep.head || '').slice(0, 46);
  console.log(`[${mark}] ${fmt(ep.startTs)}-${fmt(ep.endTs)}  ${String(ep.sid).slice(8, 16)} ${ep.from}-${ep.to}  ${ep.chars}字 ${ep.cat || '(空)'}  ${head}`);
}
console.log('缺手写：' + missing + ' 段');
