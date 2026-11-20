/**
 * bin/audit.mjs —— 把「我写的摘要」和「这段原话的头几行」并排摆出来，让我自己扫一遍。
 *
 * 为什么要有它：check.mjs 只能从索引层猜哪里可疑，真正的判据是原话。
 * 把段太短却写了菜、段短却写了「他说」的那一批摊开来对比，
 * 才能看出摘要是不是我照着 head 想当然补出来的。
 *
 * 只处理清单里不含 猜测词 / 绝对说法 / 太长 的段——那三类留给晚上和月一起看。
 * readOriginal 返回的是 { ok, reason, msgs }，每条 msg 是 { when, who, text }，
 * who 已经是 '他' / '我' / '工具'——这个结构是踩过一次空数组才记住的。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { ensureFresh } from '../src/refresh.js?v=7';
import { readOriginal } from '../src/query.js?v=7';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i];
  if (!k.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) args[k.slice(2)] = 'true';
  else { args[k.slice(2)] = next; i++; }
}

const cwd = args.cwd || 'C:\\Users\\Mioko\\Documents\\deepseek-harness\\default-workspace';
const listFile = args.list || 'check-list.json';
const outFile = args.out || 'audit-out.txt';
const SKIP = new Set(['猜测词', '绝对说法', '太长']);

ensureFresh(process.env, 0);

const all = JSON.parse(readFileSync(listFile, 'utf8'));
const todo = all.filter((e) => !(e.rules || []).some((r) => SKIP.has(r)));

const lines = [];
lines.push(`要自己对原话的段：${todo.length} 段（清单共 ${all.length} 段）`);
lines.push('');

let failed = 0;
for (const e of todo) {
  let msgs = [];
  try {
    const res = readOriginal({ cwd, sid: e.sid, from: Number(e.from), to: Number(e.to) });
    if (!res.ok) {
      failed += 1;
      lines.push(`${e.when}  ${e.from}-${e.to}  读不到：${res.reason}`);
      lines.push('');
      continue;
    }
    msgs = res.msgs || [];
  } catch (err) {
    failed += 1;
    lines.push(`${e.when}  ${e.from}-${e.to}  读原话抛错：${err.message}`);
    lines.push('');
    continue;
  }

  lines.push(`${e.when}  ${e.from}-${e.to}  chars=${e.chars}  [${(e.rules || []).join('/')}]`);
  lines.push(`  摘要：${e.head}`);

  const said = msgs
    .map((m) => ({ who: m.who || '?', txt: String(m.text ?? '').replace(/\s+/g, ' ').trim() }))
    .filter((m) => m.txt.length > 6);
  // 摘要容易把「段尾」的东西（菜名、告别）写得比段头重，所以两头都要抓。
  const his = said.filter((m) => m.who === '他');
  let picks = his.length <= 5 ? his : [...his.slice(0, 2), ...his.slice(-3)];
  if (!picks.length) picks = said.slice(0, 4);
  for (const m of picks) lines.push(`  原话·${m.who}：${m.txt.slice(0, 70)}`);
  if (!picks.length) lines.push('  原话：这一段里没有像样的话（只有工具调用或注入）');
  lines.push('');
}

writeFileSync(outFile, lines.join('\n'), 'utf8');
console.log(lines.slice(0, 8).join('\n'));
console.log(`…共 ${lines.length} 行，写到 ${outFile}；读不到 ${failed} 段`);
