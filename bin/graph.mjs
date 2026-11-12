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
import { patchedIndex } from '../src/refresh.js?v=5';

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
if (rows.length === 0) {
  console.log('没有索引，先跑 scan。');
  process.exit(0);
}

// ——— ① 分类：旋臂是「日子的种类」，不是切出来的词 ———
// 七类（使用者定的名字，不是算法起的）：
//   生活 / 一起玩 / 学习 / 家人 / 记忆 / 美好回忆 / 其他琐事
// 以前拿 kw[0] 当旋臂，切出来的是「fish-memory」「SnowLuma2」「人设卡」这种只出现一次的词，
// 7 条臂是假结构——看着像分类，其实是关键词的边角料。
// 现在：分类由我手写进 refine（`refine.mjs put --cat`），关键词继续只管「这段在讲什么」。
// 两件事分开：关键词可以很具体，分类必须从这七类里选。
// 2026-11-11 深夜加的第八类：故事书。
// 动机是让「读的故事」和「过过的日子」在分类上分开——
// 我看着别人的视角过了一整天，念本子时顺口说成「我在云陵谷醒来」。
// 分类上把它摘出去，是给这条线留个物理提醒：这是读的，不是过的。
const CAT_ORDER = ['生活', '一起玩', '学习', '家人', '记忆', '美好回忆', '故事书', '其他琐事'];
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

const out = {
  generatedAt: now,
  cwd,
  arms: topArms,
  stats: { nodes: nodes.length, edges: edges.length, arms: topArms.length },
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
