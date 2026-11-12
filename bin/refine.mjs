#!/usr/bin/env node
/**
 * bin/refine.mjs — 手写「加固摘要/关键词」那一层（夜间巩固用）。
 *
 * 索引是自动重建的，机器切的摘要在重建时会被重算；手写的必须放另一个文件，
 * 重建时覆盖上去。这就是「由我而不是算法来写摘要」的落点。
 *
 * 用法：
 *   node bin/refine.mjs list --cwd <工作区> [--day 2026-11-07]   把那天切出来的段列出来（带指针）
 *   node bin/refine.mjs put  --cwd <工作区> --sid <会话> --from <seq> --to <seq> \
 *                             --head "一句话：这段在干什么" [--kw "词1,词2,词3"]
 *   node bin/refine.mjs drop --cwd <工作区> --sid <会话> --from <seq> --to <seq>
 *
 * 键是 `sid + from + to`，不是 id——重建后 id 会重排。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { patchedIndex } from '../src/refresh.js?v=5';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) { args[a.slice(2)] = argv[++i]; } else { args._.push(a); }
  }
  return args;
}

const args = parseArgs(process.argv);
const cmd = args._[0];
const cwd = args.cwd || process.cwd();

function seaDirOf(cwdPath) {
  const root = process.env.DSH_SOLARIS_SEA || path.join(os.homedir(), '.dsh', 'solaris-sea');
  const key = String(cwdPath).replace(/[:]/g, '').replace(/[\\/]/g, '-');
  return path.join(root, key);
}

const dir = seaDirOf(cwd);
const refinedFile = path.join(dir, 'refined.jsonl');

function readRefined() {
  if (!fs.existsSync(refinedFile)) return [];
  const out = [];
  for (const line of fs.readFileSync(refinedFile, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* 跳过坏行 */ }
  }
  return out;
}

function fmt(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

if (cmd === 'list') {
  const rows = patchedIndex(cwd)
    .filter((ep) => !args.day || fmt(ep.startTs).startsWith(args.day))
    .sort((a, b) => a.startTs - b.startTs);
  console.log(`共 ${rows.length} 段（${cwd}）`);
  for (const ep of rows) {
    console.log(`${fmt(ep.startTs)}  ${ep.sid.slice(0, 18)} ${ep.from}-${ep.to}${ep.refined ? ' [手写]' : ''}`);
    console.log(`    ${ep.head}`);
  }
} else if (cmd === 'put') {
  if (!args.sid || !args.from || !args.to) {
    console.log('缺参数：--sid --from --to');
    process.exit(1);
  }
  const sid = args.sid;
  const from = Number(args.from);
  const to = Number(args.to);
  // 允许「只补一件事」：只传 --cat 时，原来写好的 head/kw 不能被冲掉。
  // （分类是后加的字段；80 段的手写摘要是先写的，补分类不能顺手把摘要抹了。）
  const all = readRefined();
  // 先按精确键找；找不到再按「起点」找——当天最后一段每轮都在往后长，
  // 它的 `to` 早就不等于当初写摘要时的值了（loadRefined 里也有同样的兜底）。
  const prev = all.find((r) => r.sid === sid && r.from === from && r.to === to)
    || all.filter((r) => r.sid === sid && r.from === from)
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0]
    || {};
  const row = {
    sid,
    from,
    to,
    head: args.head !== undefined ? args.head : prev.head,
    kw: args.kw !== undefined
      ? String(args.kw).split(/[,，]/).map((s) => s.trim()).filter(Boolean)
      : prev.kw,
    cat: args.cat !== undefined ? args.cat : prev.cat,
    at: Date.now(),
  };
  if (!row.head) {
    console.log('缺参数：--head（这一条还没有摘要，第一次写必须给）');
    process.exit(1);
  }
  const rows = readRefined().filter((r) => !(r.sid === row.sid && r.from === row.from && r.to === row.to));
  rows.push(row);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(refinedFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  // 再写一份**全局**的（~/.dsh/solaris-sea/refined-global.jsonl）。
  // 理由：会话被「会话迁移」插件整个目录搬到别的工作区时，工作区自己的 refined.jsonl
  // 留在原地——只写本地那份的话，搬走的会话手写摘要会悄悄丢掉。全局按 sid 走，搬到哪儿都在。
  const globalFile = path.join(process.env.DSH_SOLARIS_SEA || path.join(os.homedir(), '.dsh', 'solaris-sea'), 'refined-global.jsonl');
  const globalRows = [];
  if (fs.existsSync(globalFile)) {
    for (const line of fs.readFileSync(globalFile, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { globalRows.push(JSON.parse(t)); } catch { /* 跳过坏行 */ }
    }
  }
  const kept = globalRows.filter((r) => !(r.sid === row.sid && r.from === row.from && r.to === row.to));
  kept.push(row);
  fs.mkdirSync(path.dirname(globalFile), { recursive: true });
  fs.writeFileSync(globalFile, kept.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  console.log(`写好了：${row.sid.slice(0, 18)} ${row.from}-${row.to} → ${row.head}`);
  console.log('已同时写进工作区和全局（会话搬到别的分组也不会丢）。');
} else if (cmd === 'drop') {
  const rows = readRefined().filter((r) => !(r.sid === args.sid && r.from === Number(args.from) && r.to === Number(args.to)));
  fs.writeFileSync(refinedFile, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  console.log('删掉了那一条手写覆盖。');
} else {
  console.log('用法：node bin/refine.mjs list|put|drop --cwd <工作区> ...');
}
