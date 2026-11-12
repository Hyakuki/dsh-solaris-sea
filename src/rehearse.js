/**
 * 用进废退（rehearsals）—— 哪一段被「想起来」过，就更容易再被想起。
 *
 * 海马体管这个叫 rehearsals：它记「这段被检索命中过几次」，检索时乘一个正反馈。
 * 我们原来只有时间衰减（越旧越淡），没有「常被想起→更容易冒出来」这一路，
 * 结果是：最该浮上来的那几段反而和陌生段一个待遇。这次补上。
 *
 * 口径：
 *  - 只在 sea_recall / sea_trace 真的**命中**时记一笔，纯浏览不记；
 *  - 加权是温和的：1 + min(log(1+n)/4, 1)，最多 ×2，不会让一段永远霸屏；
 *  - 存 `hits.json`（seaDir 下），键和手写摘要用同一套 `sid#from#to`，
 *    所以搬会话、重建索引都不会错位。
 */

import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.js?v=3';

const MAX_KEYS = 4000;
const CACHE_MS = 60_000;
const cache = new Map(); // key -> { at, data }

function hitsFile(cwd, env) {
  return path.join(store.seaDir(cwd, env), 'hits.json');
}

function keyOf(ep) {
  if (!ep || !ep.sid || ep.from == null || ep.to == null) return '';
  return `${ep.sid}#${ep.from}#${ep.to}`;
}

function load(cwd, env) {
  const k = `${store.seaDir(cwd, env)}`;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  let data = {};
  try {
    const obj = JSON.parse(fs.readFileSync(hitsFile(cwd, env), 'utf8'));
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) data = obj;
  } catch { /* 没有就当空的 */ }
  cache.set(k, { at: Date.now(), data });
  return data;
}

function save(cwd, env, data) {
  try {
    const keys = Object.keys(data);
    if (keys.length > MAX_KEYS) {
      keys.sort((a, b) => (Number(data[a]) || 0) - (Number(data[b]) || 0));
      for (const k of keys.slice(0, keys.length - MAX_KEYS)) delete data[k];
    }
    const file = hitsFile(cwd, env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data), 'utf8');
    cache.set(`${store.seaDir(cwd, env)}`, { at: Date.now(), data });
    return true;
  } catch {
    return false;
  }
}

/** 这几段刚被想起来：各 +1。返回记下的条数。 */
export function bump(cwd, eps, env = process.env) {
  if (!cwd || !Array.isArray(eps) || !eps.length) return 0;
  try {
    const data = load(cwd, env);
    let n = 0;
    for (const ep of eps) {
      const k = keyOf(ep);
      if (!k) continue;
      data[k] = (Number(data[k]) || 0) + 1;
      n += 1;
    }
    if (!n) return 0;
    save(cwd, env, data);
    return n;
  } catch {
    return 0;
  }
}

/** 加权系数：没被想起过是 1，想起越多越大，封顶 2。 */
export function boostOf(cwd, ep, env = process.env) {
  if (!cwd || !ep) return 1;
  try {
    const k = keyOf(ep);
    if (!k) return 1;
    const n = Number(load(cwd, env)[k]) || 0;
    if (n <= 0) return 1;
    return 1 + Math.min(Math.log1p(n) / 4, 1);
  } catch {
    return 1;
  }
}

/** 给 CLI / 自检看：某段被想起过几次。 */
export function countOf(cwd, ep, env = process.env) {
  try {
    const k = keyOf(ep);
    return k ? (Number(load(cwd, env)[k]) || 0) : 0;
  } catch {
    return 0;
  }
}
