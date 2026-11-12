#!/usr/bin/env node
// 批量写手写摘要（或只补分类）。
//
// 用法：
//   node bin/refine-batch.mjs <cwd> <entries.json>            只出计划，不写
//   node bin/refine-batch.mjs <cwd> <entries.json> --apply    真写
//
// 为什么默认不写：改摘要等于改「我怎么说过去那件事」。先看到「哪几段、
// 从什么改成什么」，确认完再动手——这一步花不了几秒，省掉的是改错以后回滚的麻烦。
//
// JSON 每项：{ "sid": "...", "from": 123, "to": 456, "head": "一句话", "kw": "词1,词2", "cat": "生活" }
// `head` 可以不给——只传 cat 时，原来写好的摘要和关键词会原样保留（见 refine.mjs put）。
// 为什么不用 shell 循环：中文参数过 shell 容易被编码搞坏，这里直接 spawn 传数组。

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const rest = argv.filter((a) => a !== '--apply');
const [cwd, jsonPath] = rest;
if (!cwd || !jsonPath) {
  console.error('用法：node bin/refine-batch.mjs <cwd> <entries.json> [--apply]');
  process.exit(1);
}

const entries = JSON.parse(readFileSync(jsonPath, 'utf8'));

// 现有索引（含手写覆盖），用来给计划补上「原来是第几段、原来写的是什么」
let rows = [];
try {
  const { patchedIndex } = await import('../src/refresh.js');
  rows = patchedIndex(cwd) ?? [];
} catch { /* 读不到就只显示新内容，不影响写入 */ }

function findOld(e) {
  const exact = rows.find((r) => r.sid === e.sid && r.from === e.from && r.to === e.to);
  if (exact) return exact;
  // 当天最后一段的 to 每轮都在往后长：同一个 from、同一天里最近的那条就是它
  return rows
    .filter((r) => r.sid === e.sid && r.from === e.from)
    .sort((a, b) => (b.to ?? 0) - (a.to ?? 0))[0];
}

const clip = (s, n = 46) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

let ok = 0;
for (const e of entries) {
  const old = findOld(e);
  const before = old?.head ?? '（原来没有摘要，是机器切的）';
  const catBefore = old?.cat ?? '（未分类）';
  console.log(`${e.from}-${e.to}${e.cat ? ` [${e.cat}]` : ''}`);
  console.log(`  旧：${clip(before)}`);
  if (e.head) console.log(`  新：${clip(e.head)}`);
  if (e.cat && e.cat !== catBefore) console.log(`  分类：${catBefore} → ${e.cat}`);
  if (e.kw) console.log(`  词：${clip(old?.kw?.join(' ') ?? '（无）', 30)} → ${clip(e.kw, 40)}`);

  if (!apply) continue;

  const args = [
    join(here, 'refine.mjs'),
    'put',
    '--cwd', cwd,
    '--sid', e.sid,
    '--from', String(e.from),
    '--to', String(e.to),
  ];
  if (e.head) args.push('--head', e.head);
  if (e.kw) args.push('--kw', e.kw);
  if (e.cat) args.push('--cat', e.cat);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  if (r.status === 0) {
    ok++;
    console.log('  ✓ 写进去了');
  } else {
    console.log(`  ERR ${(r.stderr || r.stdout || '').trim()}`);
  }
}

if (!apply) {
  console.log(`\n计划 ${entries.length} 条，**还没写**。看着对，就加 --apply 再跑一次。`);
} else {
  console.log(`\n完成 ${ok}/${entries.length}`);
}
