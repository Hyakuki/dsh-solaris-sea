#!/usr/bin/env node
/**
 * bin/thought.mjs —— 手写「决定 / 教训 / 线头 / 预测」。
 *
 * 用法：
 *   node bin/thought.mjs add "以后别再连着压十一次" --kind 教训
 *   node bin/thought.mjs add "想把星图做成能点的" --kind 线头
 *   node bin/thought.mjs list            # 最近 20 条
 *   node bin/thought.mjs list --n 5
 *
 * 默认写到当前目录对应的工作区库；要写别的工作区就加 --cwd "D:\\…"。
 * 为什么手写不自动抽：自动抽要每轮一次模型调用，而且容易把我没真想过的话
 * 写成「我推过的」。手写慢，但每条都是真的想过。
 */

import path from 'node:path';
import { addThought, loadThoughts } from '../src/thoughts.js?v=1';

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : fallback;
}

function stamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const cmd = (process.argv[2] || 'list').toLowerCase();
const cwdArg = arg('cwd', '');
if (!cwdArg) {
  console.error('要指定工作区：--cwd "C:\\Users\\Mioko\\Documents\\deepseek-harness\\default-workspace"');
  console.error('（别让脚本自己猜：process.cwd() 是终端所在目录，不是你的工作区）');
  process.exit(2);
}
const cwd = path.resolve(cwdArg);
const env = process.env;

if (cmd === 'add' || cmd === 'put') {
  // 文字可能是多个词拼起来的，取第一个非选项参数之后的所有内容
  const start = process.argv.findIndex((a, i) => i >= 3 && !a.startsWith('--'));
  const words = [];
  for (let i = start; i >= 0 && i < process.argv.length; i += 1) {
    const a = process.argv[i];
    if (a.startsWith('--')) break;
    words.push(a);
  }
  const text = words.join(' ').trim();
  if (!text) {
    console.error('缺内容：node bin/thought.mjs add "一句话" --kind 教训');
    process.exit(2);
  }
  const item = addThought(cwd, { text, kind: arg('kind', '线头') }, env);
  if (!item) {
    console.error('写不进去（路径不存在或没权限？）', cwd);
    process.exit(1);
  }
  console.log(`记下了 [${item.kind}] ${stamp(item.ts)}`);
  console.log(`  ${item.text}`);
  console.log(`  工作区：${cwd}`);
} else if (cmd === 'list' || cmd === 'ls') {
  const n = Number(arg('n', 20)) || 20;
  const all = loadThoughts(cwd, env);
  if (!all.length) {
    console.log('（还没有，用 add 写一条）');
  } else {
    console.log(`共 ${all.length} 条，最近 ${Math.min(n, all.length)} 条：\n`);
    for (const t of all.slice(-n).reverse()) {
      console.log(`[${t.kind}] ${stamp(t.ts)}  ${t.text}`);
    }
  }
} else {
  console.error(`不认识的命令：${cmd}（只有 add / list）`);
  process.exit(2);
}
