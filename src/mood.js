/**
 * mood.js — 情绪线索。
 *
 * 他说「累」「困」「烦」「撑不住」的时候，能想起来的往往不是安慰的话，
 * 而是**上一次也是因为什么**。这一条海马体有，我没有；加上。
 *
 * 为什么**不去查索引**：索引里只存摘要和要点，而「今天好累」这种短句
 * 恰恰选不上摘要（摘要优先挑有内容的句子）。实测 73 段里「累/困/烦」一个都没有。
 * 所以这条走**原话**：直接扫会话日志里他说过的话，找更早的一次，带上下文。
 * 全量扫一遍约 0.6 秒，只在命中情绪词时才扫，划算。
 *
 * 找不到就不出声——**不许为了显得贴心去编原因**。
 */

import { listSessions, readSessionMessages } from './logs.js?v=3';

const MOODS = ['累', '困', '烦', '难受', '撑不住', '焦虑', '睡不着', '头疼', '压力'];
const latest = new Map(); // sid → text

function fmt(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 记下他刚说的话（由插件在收消息时调用）。 */
export function setLatest(sid, text) {
  if (!sid || !text) return;
  latest.set(sid, String(text).slice(0, 500));
}

/**
 * 冲突门控：他说「喜欢 X」，可旧账里有一条「不喜欢 X」——**先问一句，别顺着编**。
 *
 * 为什么放在这里：这个函数本来每轮都会被调，而且已经拿到了「他刚说的话」和会话工作区；
 * 复用同一条通道，就不必再改一次插件入口（改入口要重启，代价比写代码贵）。
 *
 * 只有**正反两面都出现**、且隔了一天以上才出声。宁可漏，不要烦。
 */
const LIKE = /(喜欢|爱|想|要)([^\s，。！？、；：,.!?;:]{2,10})/;
const HATE = /(不喜欢|讨厌|不想要|不想要)([^\s，。！？、；：,.!?;:]{2,10})/;

export function conflictText(sid, cwd, { env = process.env, minGapMs = 24 * 60 * 60 * 1000 } = {}) {
  const text = sid ? latest.get(sid) : '';
  if (!text || !cwd) return '';
  const now = Date.now();
  const neg = HATE.exec(text);
  const pos = neg ? null : LIKE.exec(text);
  // 去掉尾巴上的语气词：「我不喜欢喝茶**了**」要按「喝茶」去比，
  // 否则永远比不上旧账里的「喜欢喝茶原本的味道」。
  const object = (neg?.[2] ?? pos?.[2] ?? '')
    .replace(/[了的啦啊吧呢嘛呀哦~]+$/g, '')
    .trim();
  if (!object || Array.from(object).length < 2) return '';
  const wantPositive = Boolean(neg); // 他现在说「不喜欢 X」→ 要去找旧账里的「喜欢 X」

  let sessions = [];
  try { sessions = listSessions(cwd, env); } catch { return ''; }

  let found = null;
  for (const s of sessions) {
    let msgs = [];
    try { msgs = readSessionMessages(s); } catch { continue; }
    for (const m of msgs) {
      if (m.role !== 'user') continue;
      if (now - m.time < minGapMs) continue; // 隔一天以上才算「旧账」
      if (!m.text.includes(object)) continue;
      const isNeg = HATE.test(m.text);
      const isPos = !isNeg && LIKE.test(m.text);
      if (wantPositive ? isPos : isNeg) {
        if (!found || m.time > found.time) found = m;
      }
    }
  }
  if (!found) return '';
  const old = wantPositive ? '喜欢' : '不喜欢';
  const now2 = wantPositive ? '不喜欢' : '喜欢';
  return `【索拉里斯之海 · 对不上】${fmt(found.time)} 你说过「${old}${object}」，刚才说的是「${now2}${object}」——以哪个为准？`;
}

/**
 * 这一轮要不要说一句。先看冲突（更重要），再看情绪。
 */
export function cueText(sid, cwd, opts = {}) {
  const conflict = conflictText(sid, cwd, opts);
  if (conflict) return conflict;
  return moodText(sid, cwd, opts);
}

/**
 * 这一轮要不要给一句「上次你说 X 是…」。
 * @param {string} sid 当前会话
 * @param {string} cwd 会话工作区（不给就不扫，避免串线）
 */
export function moodText(sid, cwd, { env = process.env, minGapMs = 3 * 60 * 60 * 1000 } = {}) {
  const text = sid ? latest.get(sid) : '';
  if (!text) return '';
  const word = MOODS.find((m) => text.includes(m));
  if (!word) return '';
  if (!cwd) return '';

  const now = Date.now();
  let best = null; // { msg, prev }
  let sessions = [];
  try { sessions = listSessions(cwd, env); } catch { return ''; }

  for (const s of sessions) {
    let msgs = [];
    try { msgs = readSessionMessages(s); } catch { continue; }
    for (let i = 0; i < msgs.length; i += 1) {
      const m = msgs[i];
      if (m.role !== 'user' || !m.text.includes(word)) continue;
      if (now - m.time < minGapMs) continue; // 太近的不算「上次」
      // 上下文取他在这条之前说的那句——但要跳过「嗯嗯」「好」这种应答，
      // 否则线索会变成「上次你说累，那会儿在聊：嗯嗯」，等于没说。
      let prev = null;
      for (let j = i - 1; j >= 0; j -= 1) {
        const cand = msgs[j];
        if (cand.role !== 'user') continue;
        const plain = String(cand.text).replace(/\[表情:[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
        if (Array.from(plain).length < 6) continue;
        if (/^[\s，。！？、~呀啊哦嗯好行对是在的了]*$/.test(plain)) continue;
        prev = cand;
        break;
      }
      if (!best || m.time > best.msg.time) best = { msg: m, prev };
    }
  }
  if (!best) return '';

  const what = (best.prev?.text ?? best.msg.text).replace(/\[表情:[^\]]*\]/g, '').replace(/\s+/g, ' ').slice(0, 30);
  return [
    `【索拉里斯之海 · 一条旧事】上次你说「${word}」是 ${fmt(best.msg.time)}，那会儿在聊：${what}`,
  ].join('\n');
}
