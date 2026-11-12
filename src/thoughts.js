/**
 * thoughts：我自己的「决定 / 教训 / 线头」。
 *
 * 海马体这块是自动抽的（每轮花一次模型调用，从对话里抽决定和教训），
 * 我们不做自动抽——那既不省钱，也容易把我没真想过的话写成"我推过"。
 * 这里只做**手写 + 到达时带一条**：
 *
 *  - 写：`bin/thought.mjs add "…" --kind 教训`，或者我顺手在夜间巩固里补；
 *  - 读：每个会话「到达」那一次带最新的一条（不额外占每轮上下文）；
 *  - 明标来源：kind 是什么就是什么，不和原话混在一起。
 *
 * 一条一句话，不写小作文。写多了就不是"线头"，是日记。
 */

import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.js?v=3';

const KINDS = new Set(['决定', '教训', '线头', '预测']);
const MAX_LINE = 120;

function thoughtsFile(cwd, env) {
  return path.join(store.seaDir(cwd, env), 'thoughts.jsonl');
}

/** 全部条目，按时间从旧到新。坏行跳掉，不因为一行写坏就整本读不出来。 */
export function loadThoughts(cwd, env = process.env) {
  if (!cwd) return [];
  try {
    const raw = fs.readFileSync(thoughtsFile(cwd, env), 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        const o = JSON.parse(s);
        if (o && typeof o.text === 'string' && o.text.trim()) out.push(o);
      } catch { /* 坏行跳过 */ }
    }
    return out;
  } catch {
    return [];
  }
}

/** 记一条。返回写进去的那条（失败返回 null）。 */
export function addThought(cwd, { text, kind = '线头', sid = '' } = {}, env = process.env) {
  const body = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cwd || !body) return null;
  const item = {
    ts: Date.now(),
    kind: KINDS.has(kind) ? kind : '线头',
    text: body.length > MAX_LINE ? `${body.slice(0, MAX_LINE)}…` : body,
  };
  if (sid) item.sid = String(sid);
  try {
    const file = thoughtsFile(cwd, env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(item)}\n`, 'utf8');
    return item;
  } catch {
    return null;
  }
}

/** 最新的 n 条，从新到旧。 */
export function latestThoughts(cwd, n = 1, env = process.env) {
  const all = loadThoughts(cwd, env);
  return all.slice(-Math.max(0, n)).reverse();
}
