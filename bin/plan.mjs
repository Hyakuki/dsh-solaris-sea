// 把 check-list.json 里「猜测词 / 绝对说法 / 太长」那三类排成一份照着念的清单。
// 用法：node bin/plan.mjs [--out 清单.md]
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

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
const src = join(root, 'check-list.json');
const raw = JSON.parse(readFileSync(src, 'utf8'));
const arr = Array.isArray(raw) ? raw : (raw.items || raw.segments || raw.list || []);

console.log('字段：' + Object.keys(arr[0] || {}).join(', ') + '　共 ' + arr.length + ' 段');

const WANT = ['猜测词', '绝对说法', '太长'];
const rulesOf = (o) => o.rules || o.hits || o.marks || o.tags || [];
const hit = arr.filter((o) => rulesOf(o).some((r) => WANT.some((w) => String(r).includes(w))));

console.log('筛出 ' + hit.length + ' 段：' + WANT.join(' / '));

const short = (sid) => String(sid || '').replace(/^session-/, '').slice(0, 8);
const lines = [];
lines.push('# 今晚要对的清单（' + hit.length + ' 段）');
lines.push('');
lines.push('规则：每段我念摘要，你说「对」或「哪里不对」。不对的当场改。');
lines.push('');
hit.forEach((o, i) => {
  const rules = rulesOf(o).filter((r) => WANT.some((w) => String(r).includes(w)));
  lines.push('## ' + (i + 1) + '. ' + (o.date || o.when || '?') + '　' + short(o.sid) + ' ' + o.from + '-' + o.to);
  lines.push('');
  lines.push('- **我写的**：' + (o.head || o.summary || '（没有摘要）'));
  if (o.quotes && o.quotes.length) lines.push('- **可疑字样**：' + o.quotes.join(' / '));
  lines.push('- **为什么可疑**：' + rules.join('、'));
  lines.push('');
});

const out = args.out || join(root, '清单-23段.md');
writeFileSync(out, lines.join('\n'), 'utf8');
console.log('写到 ' + out);
