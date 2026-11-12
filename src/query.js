/**
 * query.js — 三个能力的实现（工具层只负责包壳）：
 *
 *   findEpisodes  按线索找片段（关键词 / 日期 / 原话片段）→ 给摘要 + 指针
 *   traceSentence 逐字取证：这句话在不在线上，是谁说的
 *   readOriginal  顺着指针回读原话
 *
 * 「逐字」这件事要老实：trace 用的是**去掉空白和标点后精确包含**的比较，
 * 不做同义、不做模糊。像「很像的一段」那种东西**不许**出现在取证结果里。
 */

/**
 * 依赖的 `/v=` 后缀是**热更新用的**，不是写着玩：
 * 插件启动后，我改 logs.js / store.js 里新增的导出，跑着的进程里还是老模块——
 * `hot()` 只能让 query.js 自己重新加载，它的静态 import 仍然走 node 缓存。
 * 给依赖也带上版本后缀，就能让整条链一起换新。
 * **改这两个文件时把版本号 +2 一下**（写错不会崩，只会用到旧的）。
 */
import { listAllSessions, listSessions, readSessionMessages } from './logs.js?v=3';
import { loadIndex, loadIndexAt, loadTopics, loadTopicsAt, loadManual, listWorkspaces } from './store.js?v=3';
import { ensureFresh } from './refresh.js?v=5';

/** 会话来源：给了 cwd 就只看那个工作区，否则全都要（插件里 cwd 常常是空的）。 */
function sessionsFor(cwd, env) {
  if (cwd) {
    const rows = listSessions(cwd, env);
    if (rows.length) return rows;
  }
  return listAllSessions(env);
}

const norm = (s) => String(s || '')
  .replace(/\[表情:[^\]]*\]/g, '')
  .replace(/[\s\u3000]+/g, '')
  .replace(/[，。！？、；：""''（）()《》〈〉…—\-~!?,.;:"'`]+/g, '');

function dayKey(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${dayKey(ts)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 按线索找片段。
 * @param {object} o
 * @param {string} o.cwd 工作区
 * @param {string} [o.query] 线索：关键词或一句话
 * @param {string} [o.day] 只找某天（YYYY-MM-DD）
 * @param {number} [o.limit]
 * @param {string} [o.session] 只找某个会话
 */
/**
 * 决定「看哪些工作区」。
 *
 * 这里要防一种特别坑的情况：插件里传给我们的 `cwd` 常常是 **DSH 进程的目录**
 * （不是会话的工作区）。如果照着它去找，只会得到一个空索引，然后一路「什么都没找到」。
 * 所以：**给了 cwd 但那里没数据，就退回「全部工作区」**——
 * 宁可多看一点，也不要静悄悄地什么都找不到。
 */
function resolveIndex(cwd, env) {
  let index = [];
  const topicsList = [];
  if (cwd) {
    index = loadIndex(cwd, env);
    if (index.length) {
      topicsList.push(loadTopics(cwd, env));
      return { index, topicsList };
    }
    index = [];
  }
  for (const key of listWorkspaces(env)) {
    const rows = loadIndexAt(key, env).map((ep) => ({ ...ep, ws: key }));
    if (rows.length === 0) continue;
    index.push(...rows);
    topicsList.push(loadTopicsAt(key, env));
  }
  return { index, topicsList };
}

/**
 * 索引里没命中时的兜底：直接下去翻原话。
 *
 * 为什么非要有这一层：索引只比 head / points / kw。head 是我手写的一句话，
 * 写的是「当时在干嘛」，往往会把这个词本身说丢——比如 11-01 早上那句
 * 原句里的说法被改写得太远，关键词就对不上，于是零命中。
 * **索引里没有，不等于线上没有。** 这种情况回答「没找到」是撒谎，
 * 代价也不大：只有零命中时才扫原话（一次 0.6 秒左右）。
 *
 * 返回的段带 rawHit / rawLines，让人一眼看出这是原话命中、不是摘要命中。
 */
/**
 * 原话里找词，必须容许「中间插了字」：
 * 搜「做噩梦」，线上原话是「做了个噩梦」——纯 includes 永远不中。
 * 所以字面命中算 1；否则按「单字覆盖 + 相邻双字覆盖」打折算分，过 0.6 才算。
 * 只在零命中兜底时用，宁可宽一点，也别再说一次「没找到」。
 */
function looseScore(text, term) {
  const t = norm(term);
  const s = norm(text);
  if (!t || !s) return 0;
  if (s.includes(t)) return 1;
  if (!/[\u4e00-\u9fff]/.test(t)) return 0;
  const chars = [...t];
  const hitChars = chars.filter((c) => s.includes(c)).length / chars.length;
  let bigrams = 0;
  for (let i = 0; i < chars.length - 1; i += 1) {
    if (s.includes(chars[i] + chars[i + 1])) bigrams += 1;
  }
  const biCov = chars.length > 1 ? bigrams / (chars.length - 1) : 1;
  const score = 0.6 * hitChars + 0.4 * biCov;
  return score >= 0.6 ? score : 0;
}

function rawEpisodes(index, sessions, terms, limit, { session, day }) {
  const bySid = new Map();
  for (const ep of index) {
    if (session && ep.sid !== session) continue;
    if (day && dayKey(ep.startTs) !== day) continue;
    const arr = bySid.get(ep.sid) ?? [];
    arr.push(ep);
    bySid.set(ep.sid, arr);
  }
  const found = new Map();
  for (const s of sessions) {
    const eps = bySid.get(s.sid);
    if (!eps || eps.length === 0) continue;
    for (const msg of readSessionMessages(s)) {
      const text = norm(msg.text);
      if (!text) continue;
      let best = 0;
      let bestTerm = '';
      for (const t of terms) {
        const sc = looseScore(text, t);
        if (sc > best) { best = sc; bestTerm = t; }
      }
      if (!best) continue;
      const ep = eps.find((e) => msg.seq >= e.from && msg.seq <= e.to);
      if (!ep) continue;
      const cur = found.get(ep.id) ?? { ep, lines: [], term: bestTerm, score: 0 };
      if (best > cur.score) { cur.score = best; cur.term = bestTerm; }
      if (cur.lines.length < 3) {
        const who = msg.role === 'user' ? '他' : msg.role === 'assistant' ? '我' : '工具';
        cur.lines.push(`${fmtTime(msg.time)} ${who}：${msg.text.replace(/\s+/g, ' ').slice(0, 70)}`);
      }
      found.set(ep.id, cur);
    }
  }
  return [...found.values()]
    .sort((a, b) => b.score - a.score || b.lines.length - a.lines.length || b.ep.weight - a.ep.weight)
    .slice(0, limit)
    .map(({ ep, lines, term, score }) => ({
      ...ep,
      when: fmtTime(ep.startTs),
      day: dayKey(ep.startTs),
      score,
      rawHit: true,
      matched: term,
      rawLines: lines,
    }));
}

export function findEpisodes({ cwd, query, day, limit = 6, session }, env) {
  // 先保证索引是新的：全量重建实测 0.6~1 秒，第二次调用 2 毫秒（不重建）。
  // 这一步放在这里，就不用再指望「谁记得去跑 scan」。
  try { ensureFresh(env); } catch { /* 刷新失败也要能检索旧索引 */ }
  const { index, topicsList } = resolveIndex(cwd, env);

  // 线索要**拆成词**再比：一句「缓存 token 计费」整体拿去比 keywords，
  // 永远比不上（没有哪个关键词等于这一整句）。第一版就栽在这儿。
  // 拆开之后按「命中几个词」打分排序，才知道哪段最贴。
  const terms = String(query || '')
    .split(/[\s,，。、；;：:!！?？/|]+/)
    .map(norm)
    .filter((t) => t.length >= 2);
  const allTerms = terms.length ? terms : [];

  const score = new Map();
  const bump = (id, n = 1) => score.set(id, (score.get(id) || 0) + n);

  for (const topics of topicsList) {
    for (const [kw, ids] of Object.entries(topics)) {
      const k = norm(kw);
      if (!k) continue;
      for (const term of allTerms) {
        if (k.includes(term) || term.includes(k)) {
          const w = k === term ? 2 : 1; // 完全相等比"沾边"更值钱
          for (const id of ids) bump(id, w);
        }
      }
    }
  }
  for (const ep of index) {
    const hay = norm([ep.head, ...(ep.points ?? [])].join(''));
    for (const term of allTerms) if (hay.includes(term)) bump(ep.id, 2);
  }

  const rows = index.filter((ep) => {
    if (session && ep.sid !== session) return false;
    if (day && dayKey(ep.startTs) !== day) return false;
    if (allTerms.length === 0) return true;
    return score.has(ep.id);
  });

  if (rows.length === 0) {
    // 索引里零命中，不等于线上没有——下去翻原话再说。
    if (allTerms.length === 0) return [];
    return rawEpisodes(index, sessionsFor(cwd, env), allTerms, limit, { session, day });
  }
  if (allTerms.length === 0) {
    // 只给日期（没给线索）时，要的是「这一天按时间排开的全貌」，
    // 不是「最重的五段」——第一版就按重量排，结果 11-04 晚上那几段被挤掉了。
    return [...rows]
      .sort((a, b) => a.startTs - b.startTs)
      .map((ep) => ({ ...ep, when: fmtTime(ep.startTs), day: dayKey(ep.startTs), score: 0 }));
  }
  rows.sort((a, b) => {
    const sa = score.get(a.id) ?? 0;
    const sb = score.get(b.id) ?? 0;
    return sb - sa || b.weight - a.weight || b.startTs - a.startTs;
  });
  return rows.slice(0, limit).map((ep) => ({
    ...ep,
    when: fmtTime(ep.startTs),
    day: dayKey(ep.startTs),
    score: score.get(ep.id) ?? 0,
  }));
}

/**
 * 逐字取证。
 * @returns {{query:string, hits:Array, note:string}}
 */
export function traceSentence({ cwd, query, limit = 10 }, env) {
  const target = norm(query);
  if (!target) return { query, hits: [], note: '空查询' };
  const hits = [];
  for (const s of sessionsFor(cwd, env)) {
    for (const msg of readSessionMessages(s)) {
      if (!norm(msg.text).includes(target)) continue;
      hits.push({
        sid: s.sid,
        seq: msg.seq,
        when: fmtTime(msg.time),
        // 归属只能来自这里：user / assistant / tool
        who: msg.role === 'user' ? '他说的' : msg.role === 'assistant' ? '我说的' : '工具输出',
        text: msg.text.replace(/\s+/g, ' ').slice(0, 160),
      });
      if (hits.length >= limit) break;
    }
    if (hits.length >= limit) break;
  }
  return {
    query,
    hits,
    note: hits.length === 0
      ? '这条线上一个字都没有。别拿「很像的一段」当证据。'
      : `逐字命中 ${hits.length} 处（去掉空白标点后精确包含）。`,
  };
}

/** 顺着指针回读原话。 */
export function readOriginal({ cwd, sid, from, to, limit = 60 }, env) {
  const session = sessionsFor(cwd, env).find((s) => s.sid === sid);
  if (!session) return { ok: false, reason: `找不到会话 ${sid}`, msgs: [] };
  const msgs = readSessionMessages(session)
    .filter((m) => m.seq >= from && m.seq <= to)
    .slice(0, limit)
    .map((m) => ({ seq: m.seq, when: fmtTime(m.time), who: m.role, text: m.text }));
  return { ok: true, msgs };
}

/** 读特意记的那本。 */
export function listManual({ cwd, query }, env) {
  const rows = loadManual(cwd, env);
  if (!query) return rows;
  const q = norm(query);
  return rows.filter((r) => norm(r.key).includes(q) || norm(r.text).includes(q));
}

export { dayKey, fmtTime, norm };
