// 显示层：把检索结果拼成人看的文字。
//
// 为什么单独一个文件：这段文字以前写在 index.js 的 tool.execute 里，而 execute 是
// 工具注册时定死的——改一行措辞就得整个 DSH 重启。挪到这里以后，index.js 每次
// 执行都 await hot('./show.js') 重新载入，改字随手就生效（跟 query.js 一样）。

/** 一段一条：摘要/要点/原话/关键词/指针。 */
export function oneEpisode(ep) {
  return [
    `#${ep.id} ${ep.when} 重量 ${ep.weight}${ep.rawHit ? `　〔原话命中：${ep.matched}〕` : ''}${ep.match === 'weak' ? '　〔弱匹配：只沾边，别当原话用〕' : ''}`,
    `  摘要：${ep.head}`,
    ep.points?.length ? `  要点：${ep.points.join(' / ')}` : '',
    (ep.rawLines ?? []).map((l) => `  原话：${l}`).join('\n'),
    ep.kw?.length ? `  关键词：${ep.kw.join(' ')}` : '',
    `  指针：${ep.sid} seq ${ep.from}-${ep.to}`,
  ].filter(Boolean).join('\n');
}

/** sea_recall 的正文。 */
export function recall({ rows, query, day }) {
  if (!rows || rows.length === 0) {
    return `索拉里斯之海里没找到「${query ?? day ?? ''}」相关的片段。`;
  }
  return `找到 ${rows.length} 段：\n${rows.map(oneEpisode).join('\n')}`;
}

/** sea_trace 的正文。 */
export function trace({ note, hits }) {
  const lines = (hits ?? []).map((h) => `[${h.who}] ${h.when} seq=${h.seq}\n  ${h.text}`);
  return [note, ...lines].join('\n');
}
