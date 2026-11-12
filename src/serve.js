/**
 * 侧栏面板的「送图」通道。
 *
 * 记忆图是 `bin/graph.mjs` 生成的一张独立 HTML（self-contained，数据内联）。
 * 侧栏没必要再写一遍渲染代码，直接把这个文件通过宿主 Web 服务送出去，
 * 面板里用 <iframe> 装它就行 —— 一份渲染代码，网页版和侧栏看到的是同一片海。
 *
 * 送哪个工作区的图？取最近生成的那一张（mtime 最新），不用客户端传 cwd：
 * 面板本来就只是「看」，不该因为当前会话换了个目录就显示别的海。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { seaRoot } from './store.js';

export const SEA_ROUTE = '/dsh-solaris-sea/sea.html';

/** 所有工作区里最新生成的那张 graph.html；没有就返回 null。 */
export function newestGraphFile(env = process.env) {
  const root = seaRoot(env);
  let dirs = [];
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(root, d.name));
  } catch {
    return null;
  }

  let best = null;
  let bestAt = 0;
  for (const dir of dirs) {
    const file = join(dir, 'graph.html');
    try {
      const st = statSync(file);
      if (st.isFile() && st.mtimeMs > bestAt) {
        best = file;
        bestAt = st.mtimeMs;
      }
    } catch {
      /* 这个工作区还没画过图 */
    }
  }
  return best;
}

function send(res, code, type, body) {
  res.statusCode = code;
  res.setHeader('content-type', type);
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

/**
 * 注册 GET /dsh-solaris-sea/sea.html。
 * 返回 true 表示挂上了；宿主没有 webServer（或版本不认这个 API）时返回 false，面板会显示空的一角。
 */
export function attachWeb(ctx, disposers = []) {
  if (!ctx?.webServer?.register) return false;
  try {
    const off = ctx.webServer.register({
      kind: 'exact',
      path: SEA_ROUTE,
      handler: async (req, res) => {
        if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
          send(res, 405, 'text/plain; charset=utf-8', 'method not allowed');
          return;
        }
        const file = newestGraphFile();
        if (!file) {
          send(
            res,
            404,
            'text/plain; charset=utf-8',
            '还没有生成过记忆图。先跑一次：node bin/graph.mjs --cwd <工作区>',
          );
          return;
        }
        let html = '';
        try {
          html = readFileSync(file, 'utf8');
        } catch (e) {
          send(res, 500, 'text/plain; charset=utf-8', `读不出记忆图：${e?.message ?? e}`);
          return;
        }
        send(res, 200, 'text/html; charset=utf-8', html);
      },
    });
    if (typeof off === 'function') disposers.push(off);
    return true;
  } catch {
    return false;
  }
}
