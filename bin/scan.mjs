#!/usr/bin/env node
/**
 * bin/scan.mjs — 重建索引（离线跑，不需要 DSH）。
 *
 *   node bin/scan.mjs [--cwd <工作区>] [--verbose]
 *
 * 做完会打印：几个会话、多少条真人消息、切出多少片段、最重的三段是什么。
 * 「最重的三段」是为了当场看一眼切得对不对——比等 Recall 时才发现的强。
 */

import process from 'node:process';
import { listSessions, readSessionMessages } from '../src/logs.js';
import { segmentSession } from '../src/segment.js';
import { saveIndex, saveState, loadState } from '../src/store.js';

function parseArgs(argv) {
  const args = { cwd: process.cwd(), verbose: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--cwd') args.cwd = argv[++i];
    else if (a === '--verbose' || a === '-v') args.verbose = true;
  }
  return args;
}

const args = parseArgs(process.argv);
const sessions = listSessions(args.cwd);
if (sessions.length === 0) {
  console.log(`没有找到会话日志：${args.cwd}`);
  process.exit(0);
}

const state = loadState(args.cwd);
let nextId = (state.nextId ?? 1);
const all = [];
const summary = [];

for (const s of sessions) {
  const msgs = readSessionMessages(s);
  if (msgs.length === 0) continue;
  const episodes = segmentSession({ sid: s.sid, msgs });
  for (const ep of episodes) {
    all.push({ id: nextId, ...ep });
    nextId += 1;
  }
  summary.push({ sid: s.sid, messages: msgs.length, episodes: episodes.length });
  state.sessions[s.sid] = { messages: msgs.length, episodes: episodes.length, scannedAt: Date.now() };
}

all.sort((a, b) => a.startTs - b.startTs);
// 重建后重新编号，保证 id 连续（指针是 sid+seq，不靠 id，所以重排安全）
all.forEach((ep, i) => { ep.id = i + 1; });
saveIndex(args.cwd, all);

state.nextId = all.length + 1;
state.builtAt = Date.now();
state.counts = { sessions: sessions.length, episodes: all.length, messages: summary.reduce((n, s) => n + s.messages, 0) };
saveState(args.cwd, state);

console.log(`工作区：${args.cwd}`);
for (const s of summary) console.log(`  ${s.sid.slice(0, 24)}  消息 ${s.messages} → 片段 ${s.episodes}`);
console.log(`合计：${state.counts.sessions} 个会话 / ${state.counts.messages} 条真人消息 / ${all.length} 个片段`);

const top = [...all].sort((a, b) => b.weight - a.weight).slice(0, 3);
console.log('--- 最重的三段 ---');
for (const ep of top) {
  const when = new Date(ep.startTs).toISOString().slice(0, 16).replace('T', ' ');
  console.log(`#${ep.id} ${when} w=${ep.weight} ${ep.head}`);
}

if (args.verbose) {
  console.log('--- 前 12 段 ---');
  for (const ep of all.slice(0, 12)) {
    const when = new Date(ep.startTs).toISOString().slice(0, 16).replace('T', ' ');
    console.log(`#${ep.id} ${when} seq ${ep.from}-${ep.to} w=${ep.weight} | ${ep.head} | kw=${(ep.kw || []).join(',')}`);
  }
}
