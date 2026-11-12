/**
 * refresh.js — 让索引自己跟上，不用我记着去跑 scan。
 *
 * 实测全量重建 **0.6 秒**（3 个会话 / 933 条真人消息），所以「按需重建」完全不亏：
 * 每次检索前看一眼索引是不是旧的，旧了就当场重建。
 *
 * 判旧的标准：**索引的 builtAt 早于会话日志的最新 mtime**。
 * 加上 maxAgeMs 兜底（默认 2 分钟），避免频繁重建。
 *
 * 注意这里直接按**工作区 key** 落盘（sessions 目录名去掉前后的 `--` 就是 key），
 * 不经过 store.js 那套 cwd 接口——因为插件里 cwd 不可靠（见 query.js 的注释）。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// `/v=` 后缀是为了热更新：不带后缀会命中启动时加载的旧模块，
// 表现成 `does not provide an export named 'listAllSessions'`。
// **改 logs.js / segment.js 时把这里和后缀一起 +1。**
import { listAllSessions, readSessionMessages } from './logs.js?v=3';
import { segmentSession } from './segment.js?v=10';

function seaRoot(env) {
  return env?.DSH_SOLARIS_SEA || path.join(os.homedir(), '.dsh', 'solaris-sea');
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** 一个工作区里所有会话的最新修改时间。 */
function newestMtime(sessions) {
  let newest = 0;
  for (const s of sessions) {
    try { newest = Math.max(newest, fs.statSync(s.file).mtimeMs); } catch { /* 读不到就算了 */ }
  }
  return newest;
}

/**
 * 「我自己写的」那一层：`refined.jsonl`。
 *
 * 为什么需要它：索引是**自动重建**的，机器切的摘要在重建时会被重新算一遍。
 * 如果我把亲手写的摘要直接写进 index.jsonl，下一次重建就冲没了——
 * 这正是「夜间巩固」里最要紧的那一半（由我而不是算法来写摘要和关键词）。
 *
 * 所以：手写的放**另一个文件**，重建时读出来覆盖上去。键用 `sid + from + to`，
 * 因为重建后片段编号（id）会重排，索引编号不能当键。
 *
 * **还要读一份全局的**：`~/.dsh/solaris-sea/refined-global.jsonl`。
 * 起因是「会话迁移」——会话日志会整个目录搬到别的工作区，而工作区自己的
 * refined.jsonl 留在原地；只读本地那份的话，**搬走的会话手写摘要就丢了**。
 * 全局那份按 sid 走，搬到哪儿都在。
 */
function loadRefined(dir, env) {
  const map = new Map();
  const files = [path.join(seaRoot(env), 'refined-global.jsonl'), path.join(dir, 'refined.jsonl')];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const r = JSON.parse(t);
        if (!r?.sid || r.from == null || r.to == null) continue;
        map.set(`${r.sid}#${r.from}#${r.to}`, r);
        // 再按「起点」存一份兜底：**当天最后一段会随对话继续往后长**，
        // 它的 `to` 每轮都在变；只按 sid#from#to 认的话，手写摘要写下去当场就失效
        // （第一次跑巩固就踩到了：17:06 那段写的时候 to=12202，几分钟后变成 12321）。
        // 起点 seq 是稳的，所以 to 对不上时退回到起点匹配。
        const loose = `${r.sid}#${r.from}#*`;
        const old = map.get(loose);
        if (!old || (r.at ?? 0) >= (old.at ?? 0)) map.set(loose, r);
      } catch { /* 坏行跳过 */ }
    }
  }
  return map;
}

/** 先按精确的 sid#from#to 找，找不到再按 sid#from 兜底。 */
function pickRefined(map, ep) {
  return map.get(`${ep.sid}#${ep.from}#${ep.to}`) || map.get(`${ep.sid}#${ep.from}#*`) || null;
}

/**
 * 读索引，并**当场**把手写覆盖盖上去。
 *
 * 为什么要在这里盖，而不是只在重建时盖：`ensureFresh` 只在「会话日志变新」或
 * 「索引超过 maxAge」时才重建；我手写一条摘要，并不改变任何会话日志的 mtime，
 * 于是索引不重建、手写的那句就**看不见**——第一次跑巩固时就是这样，
 * `refine.mjs list` 显示的还是机器头，差点以为没写进去。
 * 读的时候盖一遍，写下就立刻生效，不用等重建。
 */
export function patchedIndex(cwd, env = process.env) {
  const key = String(cwd).replace(/[:]/g, '').replace(/[\\/]/g, '-');
  const dir = path.join(seaRoot(env), key);
  const file = path.join(dir, 'index.jsonl');
  if (!fs.existsSync(file)) return [];
  const refined = loadRefined(dir, env);
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { rows.push(JSON.parse(t)); } catch { /* 坏行跳过 */ }
  }
  for (const ep of rows) {
    const o = pickRefined(refined, ep);
    if (!o) continue;
    if (o.head) ep.head = o.head;
    if (Array.isArray(o.kw) && o.kw.length) ep.kw = o.kw;
    // 分类是我自己给的，不是算法切出来的词——星图的旋臂要用它（见 bin/graph.mjs）。
    if (o.cat) ep.cat = o.cat;
    ep.refined = true;
  }
  return rows;
}

function rebuild(workspaceKey, sessions, env) {
  const dir = path.join(seaRoot(env), workspaceKey);
  fs.mkdirSync(dir, { recursive: true });
  const refined = loadRefined(dir, env);
  const all = [];
  let nextId = 1;
  const perSession = {};
  for (const s of sessions) {
    const msgs = readSessionMessages(s);
    if (msgs.length === 0) continue;
    const eps = segmentSession({ sid: s.sid, msgs });
    for (const ep of eps) {
      const override = pickRefined(refined, ep);
      if (override) {
        if (override.head) ep.head = override.head;
        if (Array.isArray(override.kw) && override.kw.length) ep.kw = override.kw;
        if (override.cat) ep.cat = override.cat;
        ep.refined = true;
      }
      all.push({ id: nextId++, ...ep });
    }
    perSession[s.sid] = { messages: msgs.length, episodes: eps.length };
  }
  all.sort((a, b) => a.startTs - b.startTs);
  all.forEach((ep, i) => { ep.id = i + 1; });

  const body = all.map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(path.join(dir, 'index.jsonl'), body ? `${body}\n` : '', 'utf8');

  const topics = {};
  for (const ep of all) for (const k of ep.kw ?? []) (topics[k] ||= []).push(ep.id);
  fs.writeFileSync(path.join(dir, 'topics.json'), JSON.stringify(topics), 'utf8');

  const state = {
    builtAt: Date.now(),
    sessions: perSession,
    counts: { sessions: Object.keys(perSession).length, episodes: all.length },
    source: 'auto',
  };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2), 'utf8');
  return state;
}

/**
 * 保证索引是新的。返回这次做了什么（给调试用）。
 * @param {object} env
 * @param {number} maxAgeMs 索引最大容忍年龄
 */
export function ensureFresh(env, maxAgeMs = 120_000) {
  const sessions = listAllSessions(env);
  const groups = new Map(); // key → sessions[]
  for (const s of sessions) {
    const key = String(s.workspace ?? '').replace(/^--/, '').replace(/--$/, '');
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  const actions = [];
  for (const [key, list] of groups) {
    const dir = path.join(seaRoot(env), key);
    const state = readJson(path.join(dir, 'state.json'), null);
    const builtAt = state?.builtAt ?? 0;
    const fresh = newestMtime(list);
    const tooOld = Date.now() - builtAt > maxAgeMs;
    if (!state || builtAt < fresh || tooOld) {
      const next = rebuild(key, list, env);
      actions.push({ key, action: state ? 'rebuilt' : 'created', episodes: next.counts.episodes });
    }
  }

  // 工作区里的会话被**整个搬空**（装了「会话迁移」插件以后真会发生）时，
  // 这个工作区就不在任何 group 里了 —— 于是它的索引永远不会再重建，
  // 残段会一直躺在库里，跟新工作区里的同一段形成「重复记忆」。
  // 所以对「有索引但已经没有会话」的工作区，也要清一次。
  try {
    for (const key of fs.readdirSync(seaRoot(env))) {
      if (groups.has(key)) continue;
      const dir = path.join(seaRoot(env), key);
      try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
      const indexFile = path.join(dir, 'index.jsonl');
      if (!fs.existsSync(indexFile)) continue;
      if (fs.statSync(indexFile).size === 0) continue;
      const cleared = rebuild(key, [], env);
      actions.push({ key, action: 'cleared (no sessions)', episodes: cleared.counts.episodes });
    }
  } catch { /* 清不掉也不影响正常重建 */ }

  return actions;
}
