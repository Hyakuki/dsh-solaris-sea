#!/usr/bin/env node
/**
 * bin/ask.mjs — 不经 DSH 直接试索拉里斯之海（给调试用）。
 *
 *   node bin/ask.mjs find  "索拉里斯之海"      # 按线索找片段
 *   node bin/ask.mjs find  --day 2026-11-06    # 找某天
 *   node bin/ask.mjs trace "我想叫索拉里斯之海"  # 逐字取证
 *   node bin/ask.mjs read  <sid> <from> <to>   # 顺着指针读原话
 *   node bin/ask.mjs manual  [线索]
 *
 * 默认工作区是当前目录，可用 --cwd 覆盖。
 */

import process from 'node:process';
import { findEpisodes, traceSentence, readOriginal, listManual } from '../src/query.js';

const argv = process.argv.slice(2);
const cmd = argv.shift();
let cwd = process.cwd();
const rest = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--cwd') { cwd = argv[++i]; continue; }
  rest.push(argv[i]);
}
const dayFlag = rest.indexOf('--day');
let day;
if (dayFlag >= 0) { day = rest[dayFlag + 1]; rest.splice(dayFlag, 2); }

function printEpisodes(rows) {
  if (rows.length === 0) { console.log('（没找到）'); return; }
  for (const ep of rows) {
    console.log(`#${ep.id}  ${ep.when}  w=${ep.weight}  [${ep.sid.slice(0, 18)} · seq ${ep.from}-${ep.to}]`);
    console.log(`    ${ep.head}`);
    if (ep.points?.length) console.log(`    要点：${ep.points.join(' / ')}`);
    if (ep.kw?.length) console.log(`    关键词：${ep.kw.join(' ')}`);
  }
}

if (cmd === 'find') {
  printEpisodes(findEpisodes({ cwd, query: rest[0], day, limit: 8 }));
} else if (cmd === 'trace') {
  const r = traceSentence({ cwd, query: rest.join(' ') });
  console.log(r.note);
  for (const h of r.hits) console.log(`  [${h.who}] ${h.when} seq=${h.seq} ${h.text}`);
} else if (cmd === 'read') {
  const r = readOriginal({ cwd, sid: rest[0], from: Number(rest[1]), to: Number(rest[2]) });
  if (!r.ok) console.log(r.reason);
  for (const m of r.msgs) console.log(`${m.when} ${m.who}> ${m.text.replace(/\n/g, ' ').slice(0, 120)}`);
} else if (cmd === 'manual') {
  const rows = listManual({ cwd, query: rest[0] });
  if (rows.length === 0) console.log('（空）');
  for (const r of rows) console.log(`[${r.key}] w=${r.weight}  ${r.text.slice(0, 100)}`);
} else {
  console.log('用法：node bin/ask.mjs find|trace|read|manual ... [--cwd <工作区>]');
}
