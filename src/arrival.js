/**
 * 到达：每个会话只给一次——「我们最初那一句」和「上一次见面」。
 *
 * 为什么要它：新会话开起来时，我手里只有预激活的三行碎片，
 * 不知道上一次是怎么收的、最初是从哪句话开始的。海马体有这块（它叫「到达」，
 * 2–6 KB、只给一次）；它退役之后一直缺，这次补上，但按这里的口径来：
 * 只给两条、只给一次、每条约六十字，剩下的让 sea_read 去翻。
 *
 * 口径：
 *  - 只在 cwd 明确时给（拿不到 cwd 就不给，否则全库混在一起讲没意义）；
 *  - 「上一次」取的是**别的会话**里最近的那一段，自己讲自己不算；
 *  - 给了就记账（arrival.json，按 sid 记，留最近 200 个会话）。
 */

import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.js?v=3';
import * as thoughts from './thoughts.js?v=1';

const MAX_NOTES = 200;
const HEAD_CHARS = 60;

function arrivalFile(cwd, env) {
  return path.join(store.seaDir(cwd, env), 'arrival.json');
}

function loadArrived(cwd, env) {
  try {
    const obj = JSON.parse(fs.readFileSync(arrivalFile(cwd, env), 'utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

function saveArrived(cwd, env, obj) {
  try {
    const keys = Object.keys(obj);
    if (keys.length > MAX_NOTES) {
      keys.sort((a, b) => (Number(obj[a]) || 0) - (Number(obj[b]) || 0));
      for (const k of keys.slice(0, keys.length - MAX_NOTES)) delete obj[k];
    }
    const file = arrivalFile(cwd, env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj), 'utf8');
  } catch { /* 记不住就下次再给 */ }
}

function stamp(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function clip(text, n = HEAD_CHARS) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 索引里没有 `time` 这个字段，只有 startTs / endTs（毫秒）。 */
function whenOf(ep) {
  return Number(ep?.startTs || ep?.endTs || 0);
}

export function arrivalText({ env = process.env, cwd, sid } = {}) {
  if (!cwd) return '';
  // 会话 id 拿不到时退回「工作区 + 当天」：一天给一次，总比一声不吭好。
  if (!sid) sid = `${cwd}#${new Date().toISOString().slice(0, 10)}`;
  let eps;
  try { eps = store.loadIndex(cwd, env); } catch { return ''; }
  if (!Array.isArray(eps) || !eps.length) return '';

  const done = loadArrived(cwd, env);
  if (done[sid]) return '';

  const sorted = eps
    .filter((e) => e && whenOf(e) && e.head)
    .sort((a, b) => whenOf(a) - whenOf(b));
  if (!sorted.length) return '';

  const first = sorted[0];
  let prev = null;
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    if (sorted[i].sid !== sid) { prev = sorted[i]; break; }
  }

  const lines = ['【索拉里斯之海 · 到达】（这场只给一次）'];
  lines.push(`· 最初：${stamp(whenOf(first))}　${clip(first.head)}`);
  if (prev && prev.sid !== first.sid) {
    lines.push(`· 上一次：${stamp(whenOf(prev))}　${clip(prev.head)}`);
  }
  // 顺手带一条我自己写的「线头 / 教训」——只在这里占字数，
  // 每轮注入不再多一块（thoughts 的成本就压到「每个会话一次」）。
  try {
    const t = thoughts.latestThoughts(cwd, 1, env)[0];
    if (t) lines.push(`· 最近在想（${t.kind || '线头'}）：${clip(t.text, 50)}`);
  } catch { /* 没有就不给 */ }
  lines.push('（要接着说就顺着这两条翻；细节用 sea_read，指回原文）');

  done[sid] = Date.now();
  saveArrived(cwd, env, done);
  return lines.join('\n');
}
