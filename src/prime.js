/**
 * prime.js — 「忽然想起来」。
 *
 * 每轮往上下文里放两三行旧事。这是整套东西里**最像活着**的部分：
 * 其它插件都在做「检索」（你问我才给），没人负责「主动冒一句」。
 *
 * 三条不做的原则（都是被现成那套教育出来的）：
 *   · **不刷屏**：默认 3 行，宁可少。
 *   · **不重复**：同一个片段一天只浮一次（记在 prime.json）。
 *   · **不假装有把握**：只给日期 + 摘要 + 指针，不编细节、不加评价。
 *
 * 挑选是**按天轮换**的确定性抽样（同一天内稳定，第二天换一批），
 * 不是每次随机——否则同一句话会在两轮之间跳来跳去，反而显得神经质。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// 用进废退：被想起来过的段落，下次更容易再浮上来（见 rehearse.js）。
// 带 ?v=1 是因为宿主对同一 specifier 有模块缓存，改了依赖要换 URL 才生效。
import * as rehearse from './rehearse.js?v=1';

function seaRoot(env) {
  return env?.DSH_SOLARIS_SEA || path.join(os.homedir(), '.dsh', 'solaris-sea');
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function dayKey(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmt(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${dayKey(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 稳定散列：同一天同一段总是排在同一个位置。 */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

/**
 * 中文不切词也能比「像不像」：取相邻两字的组合。
 * 「去江边吃烤红薯」→ {'去江','江边','边吃','吃烤','烤红','红薯'}
 */
function bigrams(s) {
  const t = String(s ?? '').replace(/[\s，。、！？；：""''（）()《》〈〉…—\-·,.!?;:'"]/g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2));
  return out;
}

function loadAllEpisodes(env) {
  const root = seaRoot(env);
  if (!fs.existsSync(root)) return [];
  const all = [];
  for (const key of fs.readdirSync(root)) {
    const file = path.join(root, key, 'index.jsonl');
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { all.push({ ...JSON.parse(t), ws: key }); } catch { /* 坏行跳过 */ }
    }
  }
  return all;
}

/**
 * 化石态：旧的不删，只是**慢慢变暗**。
 *
 * 重量不会永远是当初那个数——一个月的旧事和一个钟头前的旧事，浮上来的资格不一样。
 * 折算：`有效重量 = 原始重量 / (1 + 天数/45)`。
 * 半衰期大约一个半月：45 天前的段落只剩一半分量，90 天前只剩三分之一。
 * 注意**只是不再浮上来**，索引里的原始重量一个字都没改——想找还是找得到。
 *
 * 另一头是「用进废退」：被检索命中过的段落乘一个正反馈（最多 ×2，见 rehearse.js）。
 * 两股力气方向相反——旧的往下沉，常被想起的往上抬——合起来才像「记忆」。
 */
function effectiveWeight(ep, now = Date.now(), cwd = '', env = process.env) {
  const ageDays = Math.max(0, (now - (ep.endTs ?? ep.startTs ?? now)) / 86400000);
  const fossil = (ep.weight ?? 0) / (1 + ageDays / 45);
  return fossil * rehearse.boostOf(cwd, ep, env);
}

/**
 * 生成这一轮要浮上来的那几行。
 * @param {object} opts
 * @param {object} [opts.env]
 * @param {number} [opts.limit] 浮几条，默认 3
 * @param {number} [opts.minWeight] 太轻的不浮，默认 0.55
 * @param {string} [opts.cwd] 只从这个工作区里浮（会话自己的工作区）。
 *   **不给就全部合并**——但合并会把 QQ / 代理那几路的卡片混进来，
 *   所以能拿到 cwd 的时候一定要传。
 */
export function buildPrimeText({ env = process.env, limit = 3, minWeight = 0.55, cwd } = {}) {
  const today = dayKey();
  const stateFile = path.join(seaRoot(env), 'prime.json');
  const state = readJson(stateFile, { day: today, shown: [] });
  if (state.day !== today) { state.day = today; state.shown = []; }

  // 调试用：`text()` 到底有没有被调到、拿到了几行。
  // 只写一次（一个进程一次），免得每轮都往磁盘上蹭。
  if (!globalThis.__solarisPrimeLogged) {
    globalThis.__solarisPrimeLogged = true;
    try {
      fs.mkdirSync(seaRoot(env), { recursive: true });
      fs.writeFileSync(path.join(seaRoot(env), 'prime-call.log'),
        `${new Date().toISOString()} buildPrimeText 被调用\n`, 'utf8');
    } catch { /* 写不了就算 */ }
  }

  const seen = new Set(state.shown);
  // 只在会话自己的工作区里挑；拿不到 cwd（或那个工作区还没建索引）才退回全部。
  const onlyKey = cwd ? String(cwd).replace(/[:]/g, '').replace(/[\\/]/g, '-') : null;
  const now = Date.now()
  const all = loadAllEpisodes(env).filter((ep) => (onlyKey ? ep.ws === onlyKey : true));

  // 2026-11-18：让「忽然浮起来」沾一点**当前话题**。
  // 注入点拿不到这轮用户说了什么（`text()` 是同步的、在拼 prompt 之前被调用），
  // 所以退一步用「最近 8 条」的摘要当作「现在在聊什么」的近似。
  // 匹配只做加分、不做过滤——全按话题挑就不是「忽然」了，只剩检索。
  const recent = all
    .slice()
    .sort((a, b) => (b.endTs ?? b.startTs ?? 0) - (a.endTs ?? a.startTs ?? 0))
    .slice(0, 8);
  const recentGrams = new Set();
  for (const ep of recent) for (const g of bigrams(ep.head)) recentGrams.add(g);
  const affinity = (ep) => {
    let hit = 0;
    for (const g of bigrams(ep.head)) if (recentGrams.has(g)) hit += 1;
    return hit;
  };
  // 日期种子保证同一天稳定；affinity 最多把排序提前 0.45，压不过「重量」那条线。
  const score = (ep) => hash(`${today}|${ep.ws}#${ep.id}`) - Math.min(0.45, affinity(ep) * 0.05);

  const eligible = (minW) => all
    .filter((ep) => effectiveWeight(ep, now, cwd, env) >= minW)
    .filter((ep) => !seen.has(`${ep.ws}#${ep.id}`))
    // 按「日期种子 + 片段身份」排序：同一天稳定，第二天换一批；沾话题的提前
    .sort((a, b) => score(a) - score(b));

  let pool = eligible(minWeight);
  // 一天里浮着浮着会浮完（实测：正常玩一上午就能把够重的段全浮一遍）。
  // 浮完不能就不出声了——**先放宽门槛，再不行就把「今天已浮」重置**。
  // 宁可重浮一条旧的，也不要忽然安静下来。
  if (pool.length === 0) pool = eligible(Math.max(0.3, minWeight - 0.2));
  if (pool.length === 0) { state.shown = []; seen.clear(); pool = eligible(0.4); }

  const picked = pool.slice(0, limit);
  if (picked.length === 0) return '';

  state.shown.push(...picked.map((ep) => `${ep.ws}#${ep.id}`));
  if (state.shown.length > 200) state.shown = state.shown.slice(-100);
  try {
    fs.mkdirSync(seaRoot(env), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state), 'utf8');
  } catch { /* 写不进去就下次再浮同一批，不至于报错 */ }

  // 只给日期 + 一句话。
  // 以前还带「（当时在说：…）」，但那是**另一条消息**的首句，
  // 和摘要拼在一起会读成「一起看看视频吧（当时在说：好，帮我删下）」这种前后不搭的东西。
  // 少给一句，比给一句串味的强。
  const lines = picked.map((ep) => `· ${fmt(ep.startTs)} ${ep.head}`);
  return ['【索拉里斯之海 · 忽然浮起来】', ...lines,
    '（要原话就顺着日期翻；想不起细节就说记不清，别拿像的凑。）'].join('\n');
}
