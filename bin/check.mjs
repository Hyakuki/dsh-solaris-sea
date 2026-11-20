#!/usr/bin/env node
/**
 * bin/check.mjs —— 给 150 段手写摘要挑「值得回去读原话」的段。
 *
 * 为什么要有它：11-19 上午两条摘要被月当场纠错，一条把「谁说的」写反、
 * 一条把「为什么」写反。150 段一条条读原话太贵，所以先用规则挑可疑的，
 * 只对这几段回读原话核对。
 *
 * 只看索引层（head / chars / cat），不读原话——几秒出结果。
 *
 * 用法：
 *   node bin/check.mjs --cwd <工作区> [--sid <短号>] [--out <清单.json>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { patchedIndex, ensureFresh } from '../src/refresh.js?v=7';
import { fmtTime } from '../src/query.js?v=7';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const key = k.slice(2);
    const nextVal = argv[i + 1];
    if (nextVal === undefined || nextVal.startsWith('--')) args[key] = 'true';
    else { args[key] = nextVal; i++; }
  }
  return args;
}

/** 会让我把「猜的」写成「记得的」的那类词。 */
const GUESS = /我觉得|好像|大概|可能|应该|估计|不确定|似乎|感觉|或许|也许|我想|怕是/;
/** 绝对说法。11-19 那两条错都属这类：『第一次』『不介意』。 */
const ABS = /第一次|从没|从来没|一直|每次|总是|从不|从来不|再也没/;
/** 段里只有寥寥几条消息，却写了「他说/他问」时最可疑。 */
const SAYS = /他说|他问|他讲|他发|他提|他答|他喊|他夸|他劝/;
/** 提到吃的东西——饭桌细节最容易越读越具体。 */
const DISH = /[汤粥面饭菜肉鱼蛋虾蟹豆瓜茄椒菇笋葱姜蒜醋糖油茶奶酒饼糕包饺丸排骨腩藕芽蘑菇]/;

function rulesOf(ep) {
  const head = String(ep.head || '');
  const chars = Number(ep.chars || 0);
  const hit = [];
  if (GUESS.test(head)) hit.push('猜测词');
  if (ABS.test(head)) hit.push('绝对说法');
  if (head.length > 110) hit.push('太长');
  if (head.length > 0 && head.length < 12) hit.push('太短');
  if (!head) hit.push('没摘要');
  if (chars < 400 && SAYS.test(head)) hit.push('段太短却写了他说');
  if (chars < 800 && DISH.test(head) && /吃|饭|端|做|煮|炒|汤|菜/.test(head)) hit.push('段短却写了饭菜');
  return hit;
}

/** 摘出 head 里引用的原话，方便逐句核对。 */
function quotesOf(head) {
  const out = [];
  const re = /[『「]([^』」]{2,40})[』」]/g;
  let m;
  while ((m = re.exec(head))) out.push(m[1]);
  return out;
}

const args = parseArgs(process.argv.slice(2));
const cwd = args.cwd || process.cwd();
// 必须先重建一次：会话被上下文压缩过，日志里的 seq 整盘往后挪，
// 旧索引的 from/to 会和现在的原话错位（踩过——按索引读 11-03 那段，
// 读出来是 11-12 的原话）。maxAgeMs 给 0 = 不管多新都重建。
ensureFresh(process.env, 0);
const rows = patchedIndex(cwd);
const list = rows.filter((ep) => !args.sid || ep.sid.includes(args.sid));

const picked = [];
const dupSid = new Map();
for (const ep of list) {
  const key = `${ep.sid}#${ep.head}`;
  dupSid.set(key, (dupSid.get(key) || 0) + 1);
  const hit = rulesOf(ep);
  if (!hit.length) continue;
  picked.push({
    sid: ep.sid,
    from: ep.from,
    to: ep.to,
    when: fmtTime(ep.startTs),
    chars: ep.chars,
    cat: ep.cat || '',
    head: ep.head || '',
    rules: hit,
    quotes: quotesOf(ep.head || ''),
  });
}

picked.sort((a, b) => String(a.when).localeCompare(String(b.when)));

console.log(`共 ${list.length} 段，挑出 ${picked.length} 段要回读（工作区：${cwd}）`);
const tally = {};
for (const p of picked) for (const r of p.rules) tally[r] = (tally[r] || 0) + 1;
console.log('命中分布：' + Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(' · '));
console.log('');

for (const p of picked) {
  const head = p.head.length > 58 ? p.head.slice(0, 58) + '…' : p.head;
  console.log(`${p.when}  ${p.from}-${p.to}  chars=${p.chars}  [${p.rules.join('/')}]`);
  console.log(`    ${head}`);
  for (const q of p.quotes) console.log(`    〔引用〕${q}`);
}

if (args.out && args.out !== 'true') {
  const outPath = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(picked, null, 2), 'utf8');
  console.log(`\n清单已写到 ${outPath}`);
}
