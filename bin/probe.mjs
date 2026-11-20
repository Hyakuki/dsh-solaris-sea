// 看一条会话现在的段序列，找断层
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dir = path.join(os.homedir(), '.dsh', 'solaris-sea', 'C-Users-Mioko-Documents-deepseek-harness-default-workspace');
const eps = fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const sid = process.argv[2] || 'session-c43b52ab-903c-46df-b446-d6b56dd3a765';
const list = eps.filter(e => e.sid === sid).sort((a, b) => a.from - b.from);
console.log(`${sid.slice(9, 21)} 共 ${list.length} 段`);
console.log(list.map(e => `${e.from}-${e.to}`).join('  '));
const gaps = [];
for (let i = 1; i < list.length; i++) {
  const gap = list[i].from - list[i - 1].to;
  if (gap > 40) gaps.push(`${list[i - 1].to} → ${list[i].from}（空 ${gap}）`);
}
console.log('\n断层:', gaps.length ? gaps.join(' ; ') : '无');
