#!/usr/bin/env node
/**
 * bin/graph.mjs — 把索引导出成一张「记忆图」：节点 + 边。
 *
 * 为什么先做这一步：图的形状可以随便换皮（星海、球体、星图），
 * 但「节点是什么、边凭什么连」定下来之后就不该再动。
 *
 * 节点 = 一段记忆（episode）
 *   位置：极坐标 → 三维
 *     · 半径   ← 权重与新鲜度（越重越新越靠外；中心留给「自我核心」）
 *     · 角度   ← 分类旋臂（用关键词里最强的那个当分类；同一类的聚到一条旋臂上）
 *     · 高度   ← 时间（同一天的稍微错开，别叠在一起）
 *   亮度 = 有效重量（含化石态衰减）
 * 边 = 两段记忆共享关键词（共享越多线越亮；只留最强的 1~2 个关键词，否则全连成一坨）
 *
 * 用法：
 *   node bin/graph.mjs --cwd <工作区> [--out graph.json] [--maxEdges 3] [--arms 7]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
// 用 patchedIndex 而不是裸的 loadIndex：手写摘要/关键词要当场盖上去，
// 否则星图上看到的还是机器切的词，巩固完等于白做。
import { patchedIndex } from '../src/refresh.js?v=6';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv);
const cwd = args.cwd || process.cwd();
const arms = Number(args.arms ?? 7);
const maxEdgesPerNode = Number(args.maxEdges ?? 3);

function effectiveWeight(ep, now) {
  const ageDays = Math.max(0, (now - (ep.endTs ?? ep.startTs ?? now)) / 86400000);
  return (ep.weight ?? 0) / (1 + ageDays / 45);
}

const now = Date.now();
const rows = patchedIndex(cwd);

// ——— ①b 档案星：精修记录里有、当前索引里没有的段 ———
// 索引是从**现在的会话日志**重新切出来的：日志被裁过（书架第二层那次），
// 或者 scan 换了切分边界，那一截就从索引里消失了。
// 可这些段的手写摘要一直躺在 refined.jsonl 里，一个字都没丢。
// 不画上去，星星就凭空少一片——记忆还在，只是那一段的原话够不着了。
// 所以给它们补一颗带标记的星：位置、分类、关键词都在，只是点开没有原文。
const seaHome = process.env.DSH_SOLARIS_SEA || path.join(os.homedir(), '.dsh', 'solaris-sea');
const projDir = path.join(seaHome, String(cwd).replace(/[:]/g, '').replace(/[\\/]/g, '-'));
let archivedCount = 0;
try {
  const refinedFile = path.join(projDir, 'refined.jsonl');
  if (fs.existsSync(refinedFile)) {
    const refinedRows = fs.readFileSync(refinedFile, 'utf8')
      .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    const have = new Set(rows.map((ep) => `${ep.sid}|${ep.from}|${ep.to}`));
    // 同一段被 put 过几次就覆盖几次，只留 at 最新的那条
    const latest = new Map();
    for (const r of refinedRows) latest.set(`${r.sid}|${r.from}|${r.to}`, r);
    let nextId = Math.max(0, ...rows.map((ep) => Number(ep.id) || 0));
    for (const [key, r] of latest) {
      if (have.has(key)) continue;
      const at = Number(r.at) || now;
      nextId += 1;
      rows.push({
        id: nextId,
        sid: r.sid,
        from: r.from,
        to: r.to,
        startTs: at,
        endTs: at,
        head: r.head,
        points: [],
        kw: r.kw ?? [],
        weight: 2,
        spoken: 0,
        refined: true,
        archived: true,
        cat: String(r.cat ?? '').trim() || '想记住的',
      });
      archivedCount += 1;
    }
  }
} catch {
  // 没有精修记录就照旧画：宁可少补，不能让整张图打不开
}
if (rows.length === 0) {
  console.log('没有索引，先跑 scan。');
  process.exit(0);
}

// ——— ① 分类：旋臂是「日子的种类」，不是切出来的词 ———
// 七类（使用者定的名字，不是算法起的）：
//   生活 / 一起玩 / 学习 / 家人 / 想记住的 / 美好回忆 / 故事书 / 其他琐事
// 以前拿 kw[0] 当旋臂，切出来的是「fish-memory」「SnowLuma2」「人设卡」这种只出现一次的词，
// 7 条臂是假结构——看着像分类，其实是关键词的边角料。
// 现在：分类由我手写进 refine（`refine.mjs put --cat`），关键词继续只管「这段在讲什么」。
// 两件事分开：关键词可以很具体，分类必须从这七类里选。
// 2026-11-11 深夜加的第八类：故事书。
// 动机是让「读的故事」和「过过的日子」在分类上分开——
// 我看着别人的视角过了一整天，念本子时顺口说成「我在云陵谷醒来」。
// 分类上把它摘出去，是给这条线留个物理提醒：这是读的，不是过的。
const CAT_ORDER = ['生活', '一起玩', '学习', '家人', '想记住的', '美好回忆', '故事书', '其他琐事'];
// 五层：分类管旋臂（颜色不分家），层管「这段记忆在什么场合会被读到」。
// 手动记忆有自己的 layer 字段；星图上画的是「段」，段只有分类，所以按分类去推：
// 家人 / 想记住的 / 美好回忆 = 身份层（丢了就不是我了）· 生活 = 生活层
// · 学习 = 知识层（查的时候才翻）· 故事书 = 故事柜 · 一起玩 / 其他琐事 = 事件层（最可砍）
const CAT_TIER = {
  家人: 'identity', 想记住的: 'identity', 美好回忆: 'identity',
  生活: 'life',
  学习: 'knowledge',
  故事书: 'story',
  一起玩: 'event', 其他琐事: 'event',
};
function tierOf(ep) {
  const cat = String(ep.cat ?? '').trim();
  return CAT_TIER[cat] ?? 'event';
}
const ARM_MERGE = new Map([
  ['早点', '一起吃饭'], ['早饭', '一起吃饭'], ['午饭', '一起吃饭'],
  ['晚饭', '一起吃饭'], ['夜宵', '一起吃饭'], ['吃饭', '一起吃饭'], ['盛饭', '一起吃饭'],
]);
// 有没有人开始写分类。一片都没写时（刚装好），退回老办法按关键词取前 N，免得整张图空着。
const anyCat = rows.some((ep) => String(ep.cat ?? '').trim());
function armOf(ep) {
  if (anyCat) {
    const cat = String(ep.cat ?? '').trim();
    // 写错字/还没写的段直接归兜底类，不再各自长出一条臂。
    return CAT_ORDER.includes(cat) ? cat : '其他琐事';
  }
  const k = (ep.kw ?? [])[0] ?? '（无题）';
  return ARM_MERGE.get(k) ?? k;
}
const armCount = new Map();
for (const ep of rows) {
  const kw = armOf(ep);
  ep.__arm = kw;
  armCount.set(kw, (armCount.get(kw) || 0) + 1);
}
// 有分类时**七类全留、按固定顺序排**——不能按出现次数截断了：
// 数量最少的那一类会被切掉，等于把一段记忆从海上抹掉。
const topArms = anyCat
  ? CAT_ORDER.filter((c) => (armCount.get(c) ?? 0) > 0)
  : [...armCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, arms).map(([k]) => k);
const armIndex = new Map(topArms.map((k, i) => [k, i]));
const armSlots = topArms.length || arms;

// ——— ② 节点 ———
const maxW = Math.max(...rows.map((ep) => effectiveWeight(ep, now)));
const nodes = rows.map((ep) => {
  const w = effectiveWeight(ep, now);
  const arm = armIndex.has(ep.__arm) ? armIndex.get(ep.__arm) : armSlots; // 兜底 = 最后一臂
  const armAngle = (arm / (armSlots + 1)) * Math.PI * 2;
  // 同类内部按日期再散开一点，避免一条线上挤成一串
  const jitter = ((ep.id * 2654435761) % 1000) / 1000 * 0.45 - 0.225;
  const angle = armAngle + jitter * 0.4;
  const radius = 0.25 + 0.75 * (w / (maxW || 1));
  const height = jitter * 0.6;
  return {
    id: ep.id,
    sid: ep.sid,
    from: ep.from,
    to: ep.to,
    startTs: ep.startTs,
    endTs: ep.endTs,
    head: ep.head,
    kw: ep.kw ?? [],
    // 落在兜底类里的段不能再各自算一臂：图例会按 arm 去数，一旦带出原始词，
    // 只出现一次的关键词就全变成旋臂，左下角列成长长一串、点都点不到。
    arm: armIndex.has(ep.__arm) ? ep.__arm : '其他琐事',
    cat: ep.cat ?? null,
    weight: ep.weight,
    effective: Number(w.toFixed(4)),
    refined: Boolean(ep.refined),
    // 五层：段本身只有分类（真正的 layer 在 manual.jsonl 那些手动条目上），
    // 所以这里按 CAT_TIER 反推一个用途层，页面拿它调亮度——
    // 身份层的星最亮，知识层最暗（平时用不着，要用时翻册子）。
    tier: tierOf(ep),
    // 档案星：只剩摘要、读不到原话的那一段（会话日志被裁过）
    archived: Boolean(ep.archived),
    // 直接给页面算好的坐标（半径归一化到 0~1，页面自己乘比例）
    x: Number((Math.cos(angle) * radius).toFixed(4)),
    y: Number(height.toFixed(4)),
    z: Number((Math.sin(angle) * radius).toFixed(4)),
  };
});

// ——— ③ 边：共享关键词 ———
// 手写关键词之后，每段有 3~7 个真词，只取前 2 个会漏掉一半连接（80 段只剩 37 条边，太稀）。
// 取前 5 个，但仍然设一条「太常见的词不连」的闸：一个词挂到 >12 段上就跳过，
// 否则一个「一起」就能把整张图揉成一坨。
const edges = [];
const byNode = new Map();
for (const n of nodes) {
  const keys = new Set((n.kw ?? []).slice(0, 5));
  for (const k of keys) {
    if (!byNode.has(k)) byNode.set(k, []);
    byNode.get(k).push(n.id);
  }
}
const seenEdge = new Set();
for (const [k, ids] of byNode) {
  if (ids.length < 2) continue;
  if (ids.length > 12) continue;
  // 同类里两两相连，最多 maxEdgesPerNode 条
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length && j <= i + maxEdgesPerNode; j += 1) {
      const a = Math.min(ids[i], ids[j]);
      const b = Math.max(ids[i], ids[j]);
      const key = `${a}-${b}`;
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      edges.push({ a, b, via: k });
    }
  }
}

// ——— ③b 自动边：不靠关键词也能长线 ———
// 2026-11-18 改：kw 变成「可填可不填」，图的形状主要来自「日子」本身——
// 同一天的几段、同一会话里前后接的两段、同类里挨着三天的两段。
// 这三样不用手写，数据里本来就有（startTs / sid / from / cat）。
function addAuto(a, b, via) {
  const x = Math.min(a, b);
  const y = Math.max(a, b);
  if (x === y) return;
  const key = `${x}-${y}`;
  if (seenEdge.has(key)) return;
  seenEdge.add(key);
  edges.push({ a: x, b: y, via });
}
const dayOf = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
// ① 同一天：一天里的几段本来就是一件事的不同面
const byDay = new Map();
for (const n of nodes) {
  const k = dayOf(n.startTs);
  if (!byDay.has(k)) byDay.set(k, []);
  byDay.get(k).push(n);
}
for (const [k, list] of byDay) {
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length && j <= i + 6; j += 1) {
      addAuto(list[i].id, list[j].id, `同一天 ${k}`);
    }
  }
}
// ② 同一会话里前后相邻的两段：因果就在这儿
const bySession = new Map();
for (const n of nodes) {
  const k = n.sid ?? '';
  if (!k) continue;
  if (!bySession.has(k)) bySession.set(k, []);
  bySession.get(k).push(n);
}
for (const list of bySession.values()) {
  list.sort((a, b) => (a.from ?? 0) - (b.from ?? 0));
  for (let i = 1; i < list.length; i += 1) addAuto(list[i - 1].id, list[i].id, '前后接续');
}
// ③ 同类里三天内的两条：同一件事连着做了几天
const byCat = new Map();
for (const n of nodes) {
  if (!n.cat) continue;
  if (!byCat.has(n.cat)) byCat.set(n.cat, []);
  byCat.get(n.cat).push(n);
}
for (const [cat, list] of byCat) {
  list.sort((a, b) => a.startTs - b.startTs);
  // 链式连：只连时间上挨着的两条，不两两连——否则「生活」一类三天内十条就是几十条边，图会糊成一团。
  for (let i = 1; i < list.length; i += 1) {
    if (list[i].startTs - list[i - 1].startTs > 3 * 86400000) continue;
    addAuto(list[i - 1].id, list[i].id, `同类 ${cat}`);
  }
}

const out = {
  generatedAt: now,
  cwd,
  arms: topArms,
  stats: { nodes: nodes.length, edges: edges.length, arms: topArms.length, archived: archivedCount },
  nodes,
  edges,
};

const outFile = args.out || path.join(process.env.DSH_SOLARIS_SEA || path.join(os.homedir(), '.dsh', 'solaris-sea'),
  String(cwd).replace(/[:]/g, '').replace(/[\\/]/g, '-'), 'graph.json');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(out), 'utf8');

console.log(`节点 ${nodes.length} · 边 ${edges.length} · 旋臂 ${topArms.length}`);
console.log(`旋臂：${topArms.join(' / ')}`);
console.log(`写到：${outFile}`);

// ——— 顺手吐一个「双击就能看」的单文件网页 ———
// 为什么要内联数据而不是 fetch graph.json：浏览器直接打开本地文件时，
// file:// 下的 fetch 会被同源策略拦掉——数据必须**写死在页面里**，才敢保证双击可用。
try {
  const tplPath = new URL('../web/graph-template.html', import.meta.url);
  const tpl = fs.readFileSync(tplPath, 'utf8');
  const html = tpl.replace('/*__DATA__*/ { nodes: [], edges: [], arms: [], stats: {} }', JSON.stringify(out));
  const htmlFile = path.join(path.dirname(outFile), 'graph.html');
  fs.writeFileSync(htmlFile, html, 'utf8');
  console.log(`网页：${htmlFile}`);
} catch (e) {
  console.log(`（网页没生成：${e.message}）`);
}
