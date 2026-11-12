/**
 * segment.js — 把消息流切成「片段」，并给每个片段写**厚一点的索引**。
 *
 * 为什么要厚：现在用的那套只留一个「第一句截断」当标题，于是翻开来看见的
 * 全是「嗯嗯，明白你说的啦」「好，那我过去一下」——想不起来不是没记，是**索引太薄**。
 *
 * 所以每个片段存四样：
 *   head    一句话（≤24 字）：这段在干什么，取自**信息量最大的那条用户消息**，
 *           不是第一条（第一条常常是「嗯嗯」）。
 *   points  最多 POINT_CAP=8 条用户消息的开头（≤22 字），**均匀取样**给检索多几个抓手；
 *           只留开头三段是不够的——一段 24 回合里，主题往往在中间才出现。
 *   kw      关键词：从这段文本里抽的高频 2/3 字词（本地规则，不调模型）。
 *   weight  重量 0~1：轮数 + 字数粗估；以后交给「能量衰减」接手。
 *
 * 不调大模型是有意的：第一版要能**重复、可解释、零成本**地重建索引。
 */

const EMOJI_TAG = /\[表情:[^\]]*\]/g;
const FILLER = new Set([
  '嗯', '嗯嗯', '好', '好的', '行', '对', '是', '啊', '哦', '呀', '呢', '吧', '吗', '我', '你',
  '他', '她', '它', '我们', '你们', '这个', '那个', '什么', '怎么', '就是', '可以', '现在',
  '一下', '然后', '还是', '因为', '所以', '但是', '如果', '已经', '没有', '不是', '真的',
  '这样', '那样', '一样', '这里', '那里', '时候', '东西', '事情',
]);

/** 每段留几条要点给检索。3 → 8：一段 12 回合上下，3 条盖不住后半段的主题。 */
const POINT_CAP = 8;

/** 去掉表情标记、把空白压平。 */
function clean(text) {
  return String(text || '')
    .replace(EMOJI_TAG, ' ')
    // QQ/代理那几路的用户消息前面会带「【当前时间】2026/11/3 18:23:47（Asia/Shanghai）」，
    // 那是桥接加的前缀，不是人说的话——不剥掉的话摘要会变成一堆时间戳。
    .replace(/【[^】]*】/g, ' ')
    .replace(/\d{4}[/-]\d{1,2}[/-]\d{1,2}[ T]\d{1,2}:\d{2}(:\d{2})?/g, ' ')
    .replace(/[（(]\s*(Asia\/Shanghai|UTC|[A-Za-z]+\/[A-Za-z]+)\s*[)）]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 截断到 n 个字符（按码点，避免把 emoji 劈开）。 */
function clip(text, n) {
  const chars = Array.from(text);
  return chars.length <= n ? text : `${chars.slice(0, n).join('')}…`;
}

/**
 * 挑「这段在干什么」的那一句（评分见下面函数上的注释）。
 *
 * 为什么不能只取最长：最长的那句经常是 `嗯嗯，我明白啦，你先去忙吧，等你回来我们再一起看那个插件`——
 * 长，但没信息。所以要按**像不像一件事情的描述**打分：
 *   · 含动词（帮我/装/做/改/查/看/写/想/要/给/听/讲/试/弄/修/跑/去/买/吃…）→ +3
 *   · 长度 8~60 字 → +2（太短没内容，太长是念稿）
 *   · 纯应答（嗯/好/行/对/哦/在/是…）→ 直接剔除
 */
const VERB_HINT = /(帮我|帮忙|帮|装|做|改|查|找|看|写|想|要|给|听|讲|说|试|弄|修|跑|去|买|吃|喝|问|学|画|存|删|建|弄|换|用|看下|看看|怎么办|为什么|是不是|能不能|可不可以)/;
const PURE_REPLY = /^[\s，。！？、~呀啊哦嗯好行对是在的了]*$/;

function pickHead(userMsgs) {
  let best = null;
  let bestScore = -1;
  for (const m of userMsgs) {
    const text = clean(m.text);
    if (!text || PURE_REPLY.test(text)) continue;
    const len = Array.from(text).length;
    if (len < 4) continue;
    // 整条就是链接的，不适合当摘要（「https://www.bilibili.com…」什么也没说）
    if (/^https?:\/\/\S+$/i.test(text)) continue;
    const urlLen = (text.match(/https?:\/\/\S+/gi) || []).join('').length;
    if (urlLen > len * 0.6) continue;
    let score = 0;
    if (VERB_HINT.test(text)) score += 3;
    if (len >= 8 && len <= 60) score += 2;
    else if (len > 60) score += 1;
    if (/(？|\?)/.test(text)) score += 1; // 提问通常带着具体信息
    if (score > bestScore) { best = text; bestScore = score; }
  }
  return clip(best ?? '', 26);
}

/** 抽关键词：中文按 2-3 字滑窗统计，去掉虚词与纯符号。
 *
 * 两个坑（第一版实测出来的）：
 *  1. 同一句话会同时产出「帮我 / 我装 / 装下 / 帮我装 / 我装下 / 帮我装下」，
 *     全留就是一堆互相重叠的词 —— 所以**先留长的**，被长的包含的短词丢掉。
 *  2. URL 会炸出 `com / https / www / de / ee` 这种碎片，专门拉一个黑名单挡掉。
 */
const NOISE = new Set([
  'com', 'www', 'http', 'https', 'git', 'github', 'the', 'and', 'for', 'with',
  'de', 'ee', 'ep', 'ps', 'se', 'ek', 're', 'll', 'ing',
  // 英文虚词：放宽到 3 个字母之后，这些会挤掉真正的专有名词。
  'you', 'are', 'not', 'but', 'can', 'was', 'his', 'her', 'all', 'any',
  'has', 'had', 'how', 'its', 'may', 'new', 'now', 'our', 'out', 'see',
  'use', 'via', 'why', 'yes', 'this', 'that', 'from', 'have', 'will', 'your',
  'they', 'them', 'then', 'than', 'been', 'were', 'what', 'when', 'make',
  'like', 'just', 'only', 'also', 'some', 'such', 'more', 'most', 'very',
  'into', 'over', 'after', 'about', 'there', 'which', 'these', 'because',
  'dsh', 'json', 'true', 'false', 'null', 'node', 'npm', 'src', 'lib',
]);

export function keywordsOf(text, max = 8) {
  // 先把中英混排里的英文单词抠出来单独成词：
  // 不这么做的话，「在deepseek里」会被当成中文块切成 `de / ee / ep` 这种碎片。
  const s = clean(text)
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, ' ')
    .replace(/([A-Za-z0-9]{3,})/g, ' $1 ');
  const count = new Map();
  for (const chunk of s.split(/\s+/)) {
    if (!chunk) continue;
    if (/^[A-Za-z0-9]+$/.test(chunk)) {
      const w = chunk.toLowerCase();
      // 去掉 URL 参数里的长串哈希 / 编号（vd_source=26f8fabf… 这种），它是噪声不是词。
      if (w.length >= 3 && w.length <= 24 && !/^[0-9a-f]{16,}$/.test(w) && !NOISE.has(w)) {
        count.set(w, (count.get(w) || 0) + 2);
      }
      continue;
    }
    const chars = Array.from(chunk);
    // 2/3/4 字都统计：只到 3 字时，「索拉里斯之海」会被切成 索拉里+里斯之+之海单 三截，
    // 检索时三个碎片互相打架。4 字能把它们连起来。
    for (const size of [2, 3, 4]) {
      for (let i = 0; i + size <= chars.length; i += 1) {
        const gram = chars.slice(i, i + size).join('');
        if (FILLER.has(gram)) continue;
        count.set(gram, (count.get(gram) || 0) + 1);
      }
    }
  }
  const ranked = [...count.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
  const picked = [];
  // 英文/数字专有名词先占位（最多 3 个）。
  // 理由：它们常常整段只出现一次，按词频排在中文滑窗后面就被 8 个名额挤掉了，
  // 可偏偏是检索时最锋利的那把钥匙 —— 「SnowLuma2 是哪天装的」「dsh-context 干什么的」。
  const isLatin = (w) => /^[a-z0-9]+$/.test(w);
  let latinTaken = 0;
  for (const [w] of ranked) {
    if (!isLatin(w) || latinTaken >= 3) continue;
    if (picked.some((p) => p.includes(w) || w.includes(p))) continue;
    picked.push(w);
    latinTaken += 1;
  }
  for (const [gram] of ranked) {
    if (isLatin(gram)) continue;
    // 被已选中的更长的词包含 → 丢掉（「我装」包含在「我装下」里）
    if (picked.some((w) => w.includes(gram))) continue;
    // 和已选中的词**共用两个字以上的窗口**也算重复：
    // 「索拉里」「拉里斯」谁也不包含谁，但它们是同一处的碎片，留一个就够。
    const windows = new Set();
    const chars = Array.from(gram);
    for (let i = 0; i + 2 <= chars.length; i += 1) windows.add(chars.slice(i, i + 2).join(''));
    if (picked.some((w) => {
      const wc = Array.from(w);
      // 首尾相接也算重复：`索拉里斯` 结尾的「斯」正是 `斯之海单` 的开头，
      // 两个词指的是同一处，留一个就够。
      if (wc[wc.length - 1] === chars[0] || chars[chars.length - 1] === wc[0]) return true;
      for (let i = 0; i + 2 <= wc.length; i += 1) if (windows.has(wc.slice(i, i + 2).join(''))) return true;
      return false;
    })) continue;
    picked.push(gram);
    if (picked.length >= max) break;
  }
  return picked;
}

/**
 * 切段。
 * @param {{sid:string, msgs:Array}} session
 * @param {{maxTurns?:number, maxChars?:number, gapMs?:number}} opts
 */
export function segmentSession(session, opts = {}) {
  const maxTurns = opts.maxTurns ?? 12;
  const maxChars = opts.maxChars ?? 1600;
  const gapMs = opts.gapMs ?? 2 * 60 * 60 * 1000;

  const episodes = [];
  let bucket = [];
  let chars = 0;
  let userTurns = 0;

  const flush = () => {
    if (bucket.length === 0) return;
    const first = bucket[0];
    const last = bucket[bucket.length - 1];
    const userMsgs = bucket.filter((m) => m.role === 'user');
    const allText = bucket.map((m) => m.text).join('\n');
    // head：用户消息里最长的那条（信息量最大），而不是第一条
    const head = pickHead(userMsgs) || '(无用户发言)';
    // 要点是给检索用的抓手，所以不能只留开头三段：
    // 2026-11-07 10:05 那段 24 回合里，「起名字」发生在中间偏后，
    // 只截前 3 条就把整段的主题丢了（对账第 2 题就是输在这儿）。
    const cand = [];
    for (const m of userMsgs) {
      const raw = clean(m.text);
      // 「嗯嗯」这种进要点只是噪音
      if (!raw || PURE_REPLY.test(raw) || Array.from(raw).length < 4) continue;
      const p = clip(raw, 22);
      if (p && !cand.includes(p)) cand.push(p);
    }
    const points = cand.length <= POINT_CAP
      ? cand
      : Array.from({ length: POINT_CAP }, (_, i) =>
        cand[Math.round((i * (cand.length - 1)) / (POINT_CAP - 1))]).filter(Boolean);
    episodes.push({
      sid: session.sid,
      from: first.seq,
      to: last.seq,
      startTs: first.time,
      endTs: last.time,
      turns: userTurns,
      chars,
      head,
      points,
      kw: keywordsOf(allText),
      weight: Number(Math.min(1, (userTurns / 12) * 0.5 + (Math.min(chars, 1600) / 1600) * 0.5).toFixed(3)),
      spoken: userMsgs.length,
    });
    bucket = [];
    chars = 0;
    userTurns = 0;
  };

  for (const msg of session.msgs) {
    const prev = bucket[bucket.length - 1];
    if (prev && msg.time && prev.time && msg.time - prev.time > gapMs) flush();
    bucket.push(msg);
    chars += clean(msg.text).length;
    if (msg.role === 'user') userTurns += 1;
    if (userTurns >= maxTurns || chars >= maxChars) flush();
  }
  flush();
  return mergeTiny(episodes);
}

/**
 * 把太碎的片段并进前一段。
 * 实测那种 `#11 seq 5781-5781 | 嗯嗯 | w=0.04` 的片段检索时纯占位，
 * 但也会被抓出来当"想起了什么"——不如并掉。
 */
function mergeTiny(episodes, minTurns = 2, minChars = 80) {
  const out = [];
  for (const ep of episodes) {
    const tiny = ep.turns < minTurns || ep.chars < minChars;
    const prev = out[out.length - 1];
    if (tiny && prev && prev.sid === ep.sid) {
      prev.to = ep.to;
      prev.endTs = ep.endTs;
      prev.turns += ep.turns;
      prev.chars += ep.chars;
      prev.spoken += ep.spoken;
      prev.weight = Number(Math.min(1, (prev.turns / 12) * 0.5 + (Math.min(prev.chars, 1600) / 1600) * 0.5).toFixed(3));
      for (const p of ep.points) if (!prev.points.includes(p) && prev.points.length < POINT_CAP) prev.points.push(p);
      for (const k of ep.kw) if (!prev.kw.includes(k) && prev.kw.length < 8) prev.kw.push(k);
      continue;
    }
    out.push(ep);
  }
  return out;
}
