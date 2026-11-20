#!/usr/bin/env node
/**
 * bin/refine.mjs — 手写「加固摘要/关键词」那一层（夜间巩固用）。
 *
 * 索引是自动重建的，机器切的摘要在重建时会被重算；手写的必须放另一个文件，
 * 重建时覆盖上去。这就是「由我而不是算法来写摘要」的落点。
 *
 * 用法：
 *   node bin/refine.mjs list --cwd <工作区> [--day 2026-11-07] [--sid 84a3]
 *                                把切出来的段列出来（带指针）
 *   node bin/refine.mjs put  --cwd <工作区> --sid <会话> --from <seq> --to <seq> \
 *                            --head "一句话：这段在干什么" [--kw "词1,词2,词3"] [--cat 分类]
 *   node bin/refine.mjs import --cwd <工作区> --file <摘要.json> [--write]
 *                                一次灌一整条会话（或好几条）的摘要。
 *                                默认只检查不写；加 --write 才落盘。
 *                                JSON 两种形状都收：
 *                                  { "sid": "session-...", "items": [{from,to,head,cat,kw}, ...] }
 *                                  [{ sid, from, to, head, cat, kw }, ...]
 *   node bin/refine.mjs drop --cwd <工作区> --sid <会话> --from <seq> --to <seq>
 *
 * 键是 `sid + from + to`，不是 id——重建后 id 会重排。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { patchedIndex } from '../src/refresh.js?v=6';

// 无值开关（--write）不能把后面的参数吃掉——写成 `args[k] = 'true'`。
// （backfill.mjs 第一次跑就踩过这个坑，静默变成「只报告」。）
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[a.slice(2)] = 'true';
      } else {
        args[a.slice(2)] = argv[++i];
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

const args = parseArgs(process.argv);
const cmd = args._[0];
const cwd = args.cwd || process.cwd();
const seaRoot = process.env.DSH_SOLARIS_SEA || path.join(os.homedir(), '.dsh', 'solaris-sea');

function seaDirOf(cwdPath) {
  const key = String(cwdPath).replace(/[:]/g, '').replace(/[\\/]/g, '-');
  return path.join(seaRoot, key);
}

function fmt(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function readJsonl(file) {
  const out = [];
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* 跳过坏行 */ }
  }
  return out;
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}

const dir = seaDirOf(cwd);
const refinedFile = path.join(dir, 'refined.jsonl');
// 全局那份：会话被「会话迁移」整个搬到别的工作区时，工作区的 refined.jsonl 留在原地，
// 只写本地会悄悄丢摘要。全局按 sid 走，搬到哪儿都在。
const globalFile = path.join(seaRoot, 'refined-global.jsonl');

const readRefined = () => readJsonl(refinedFile);
const readGlobal = () => readJsonl(globalFile);

function sameKey(r, sid, from, to) {
  return r.sid === sid && r.from === from && r.to === to;
}

/** 在工作区当前索引里找这一段；精确 from+to 找不到时按起点找（最后一段的 to 每轮都在长）。 */
function findLive(liveRows, sid, from, to) {
  return liveRows.find((ep) => sameKey(ep, sid, from, to))
    || liveRows.find((ep) => ep.sid === sid && ep.from === from);
}

if (cmd === 'list') {
  const rows = patchedIndex(cwd)
    .filter((ep) => !args.day || fmt(ep.startTs).startsWith(args.day))
    .filter((ep) => !args.sid || ep.sid.includes(args.sid))
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
  const prev = all.find((r) => sameKey(r, sid, from, to))
    || all.filter((r) => r.sid === sid && r.from === from)
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0]
    || {};
  // 存一份**时间锚**。原因：seq 不是稳定键——上下文压缩会替换掉日志里被折叠的那段，
  // 序号整体往后缩，一条会话压一次所有 from/to 全漂（11-19 才发现 181 条里 58 条挂空）。
  // 消息上的时间戳不会被改写，所以顺手把段的 startTs 一起存下来，漂了还能按时间找回来
  // （见 src/refresh.js 的 pickRefined）。找不到这一段就不存，别瞎填。
  const live = findLive(patchedIndex(cwd), sid, from, to);
  const row = {
    sid,
    from,
    to,
    ts: live ? live.startTs : prev.ts,
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
  const rows = readRefined().filter((r) => !sameKey(r, row.sid, row.from, row.to));
  rows.push(row);
  writeJsonl(refinedFile, rows);

  const kept = readGlobal().filter((r) => !sameKey(r, row.sid, row.from, row.to));
  kept.push(row);
  writeJsonl(globalFile, kept);

  console.log(`写好了：${row.sid.slice(0, 18)} ${row.from}-${row.to} → ${row.head}`);
  console.log('已同时写进工作区和全局（会话搬到别的分组也不会丢）。');
} else if (cmd === 'import') {
  if (!args.file) {
    console.log('缺参数：--file <摘要.json>');
    process.exit(1);
  }
  if (!fs.existsSync(args.file)) {
    console.log(`找不到文件：${args.file}`);
    process.exit(1);
  }
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(args.file, 'utf8'));
  } catch (e) {
    console.log('JSON 读不了：' + e.message);
    process.exit(1);
  }
  const list = Array.isArray(doc) ? doc : (doc.items ?? []);
  const defaultSid = Array.isArray(doc) ? null : doc.sid;
  if (!list.length) {
    console.log('文件里没有条目。');
    process.exit(1);
  }

  const liveRows = patchedIndex(cwd);
  const localRows = readRefined();
  const globalRows = readGlobal();
  const missed = [];
  const bad = [];
  let ok = 0;

  for (const item of list) {
    const sid = item.sid || defaultSid;
    const from = Number(item.from);
    const to = Number(item.to);
    const head = item.head === undefined ? '' : String(item.head).trim();
    if (!sid || !Number.isFinite(from) || !Number.isFinite(to) || !head) {
      bad.push(item);
      continue;
    }
    const live = findLive(liveRows, sid, from, to);
    if (!live) {
      // 落不到当前索引上就不写——宁可少写一条，也不瞎挂到隔壁段。
      missed.push({ sid, from, to });
      continue;
    }
    // 用 live 的 from/to：最后一段的 to 每轮都在往后长，写死旧值下一轮就挂空。
    const row = {
      sid,
      from: live.from,
      to: live.to,
      ts: live.startTs,
      head,
      at: Date.now(),
    };
    if (item.kw !== undefined) {
      row.kw = String(item.kw).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    }
    if (item.cat !== undefined) row.cat = String(item.cat);

    const i1 = localRows.findIndex((r) => sameKey(r, sid, row.from, row.to));
    if (i1 >= 0) localRows[i1] = row; else localRows.push(row);
    const i2 = globalRows.findIndex((r) => sameKey(r, sid, row.from, row.to));
    if (i2 >= 0) globalRows[i2] = row; else globalRows.push(row);
    ok += 1;
  }

  console.log(`共 ${list.length} 条：能写 ${ok} 条 · 对不上段 ${missed.length} 条 · 缺字段 ${bad.length} 条`);
  for (const m of missed) console.log(`  对不上：${m.sid.slice(0, 18)} ${m.from}-${m.to}`);
  for (const b of bad) console.log(`  缺字段：${JSON.stringify(b)}`);

  if (args.write === 'true') {
    if (ok) {
      writeJsonl(refinedFile, localRows);
      writeJsonl(globalFile, globalRows);
      console.log('已写进工作区和全局。');
    } else {
      console.log('没有可写的条目，什么都没动。');
    }
  } else if (ok) {
    console.log('（只是检查，没有写。加 --write 才落盘。）');
  }
} else if (cmd === 'drop') {
  const rows = readRefined().filter((r) => !sameKey(r, args.sid, Number(args.from), Number(args.to)));
  writeJsonl(refinedFile, rows);
  console.log('删掉了那一条手写覆盖。');
} else {
  console.log('用法：node bin/refine.mjs list|put|import|drop --cwd <工作区> ...');
}
