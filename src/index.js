/**
 * index.js — 索拉里斯之海的插件入口，只做注册。
 *
 * 三个工具（第一版）：
 *   sea_recall    按线索/日期找片段：给摘要 + 日期 + 指针（要原话再回读）
 *   sea_trace     逐字取证：这句话在不在线上，是谁说的
 *   sea_remember  特意记一条（同一 key 新的盖旧的）
 *   sea_manual    读那本「特意记的」小册子
 *
 * 契约要点（照 dsh-video-storyboard 趟过的路走）：
 *  - `apply` 必须快速返回 disposer；注册失败只让插件不可用，**不能让应用起不来**
 *  - 只 inject `tools`，不碰别的服务
 *  - 参数用宿主的 ValueSchemaSpec 子集（string/number/boolean/array/object/json），
 *    **不支持 minimum / pattern 之类注解**，取值范围写在 description 里
 */

export const name = 'dsh-solaris-sea';
// systemPrompt 用来每轮浮几条旧事；agents 用来挂到每个会话上。
// tools 必须有；attachments 之类坚决不声明——服务没就绪会让整个插件卡住。
export const inject = ['tools', 'systemPrompt', 'agents', 'webServer'];

const WORKDIR_HINT = '工作区路径，缺省用当前会话的 cwd';

/**
 * 最近一次见过的会话 cwd。
 *
 * 为什么需要它：`process.cwd()` 是 **DSH 进程自己的工作目录**（常见是
 * `~/.dsh/profiles/<profile>`），不是会话的工作区。工具不传 cwd 时
 * 用 process.cwd() 会把「特意记的」写进一个根本不该存在的库
 * （`solaris-sea/<进程 cwd 编码>/manual.jsonl`）——实测就是这么写丢过记录。
 */
let LAST_CWD = null;
export function noteCwd(cwd) {
  if (typeof cwd === 'string' && cwd.trim()) LAST_CWD = cwd;
}
function pickCwd(args) {
  return args?.cwd || LAST_CWD || process.cwd();
}

async function loadDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools');
    if (mod?.defineTool) return mod.defineTool;
  } catch { /* 落到环境变量 */ }
  const override = process.env.DSH_TOOLS_PATH;
  if (override) {
    const { pathToFileURL } = await import('node:url');
    const mod = await import(pathToFileURL(override).href);
    if (mod?.defineTool) return mod.defineTool;
  }
  throw new Error('cannot resolve @deepseek-ai/dsh-tools');
}

/**
 * 热取模块：按文件 mtime 加 `?v=` 后缀，改完文件**下一次调用就生效**，不用重启 DSH。
 *
 * 为什么需要这个：插件在启动时加载，之后我改 `query.js` 里的排序/匹配逻辑，
 * 跑着的进程里还是老代码——今天为了「多词线索搜不到」这件事就得再让人重启一次。
 * 重启一次的代价比改一版代码贵得多，所以把这层缓存打通。
 * 只对**直接 import 的这一层**生效（它内部 import 的模块仍然按 node 自己的缓存），
 * 所以逻辑尽量放在被 hot 取的那个文件里。
 */
async function hot(rel) {
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const fs = await import('node:fs');
  const abs = fileURLToPath(new URL(rel, import.meta.url));
  let stamp = 0;
  try { stamp = Math.round((await fs.promises.stat(abs)).mtimeMs); } catch { /* 拿不到就按 0 */ }
  return import(`${pathToFileURL(abs).href}?v=${stamp}`);
}

const textOut = (description) => ({
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', required: true, description } },
  },
  render(args, value) { return [{ type: 'text', text: value.text }]; },
});

export function buildTools(defineTool) {
  return [
    defineTool({
      name: 'sea_recall',
      description: '索拉里斯之海·按线索找。给一个线索（词或一句话）、或者给一天，'
        + '返回相关的几段：每段有摘要、日期、要点、关键词和指针（会话 + seq 区间）。'
        + '要原话就用 sea_read 顺着指针读回来——这里给的是索引，不是原文。',
      parameters: {
        query: { type: 'string', description: '线索：关键词或一句话，可省略' },
        day: { type: 'string', description: '只找某天，格式 YYYY-MM-DD，可省略' },
        limit: { type: 'number', description: '最多返回几段，默认 6' },
        cwd: { type: 'string', description: WORKDIR_HINT },
      },
      output: textOut('检索结果（片段摘要 + 指针）'),
      timeoutMs: 20_000,
      isConcurrencySafe() { return true; },
      async execute(args) {
        const { findEpisodes } = await hot('./query.js');
        const cwd = pickCwd(args);
        const rows = findEpisodes({ cwd, query: args.query, day: args.day, limit: args.limit ?? 6 });
        // 用进废退：这次**真的命中**的段落各记一笔（只记命中，不记浏览）。
        // 记不上也不影响检索结果，所以整段吞掉异常。
        try {
          const rehearse = await hot('./rehearse.js');
          rehearse.bump(cwd, rows);
        } catch { /* 记账失败就当没发生 */ }
        // 显示层单独热载：改一句措辞不用重启 DSH（以前这堆字写死在这里，得整个重启）
        const show = await hot('./show.js');
        return { text: show.recall({ rows, query: args.query, day: args.day }) };
      },
    }),

    defineTool({
      name: 'sea_trace',
      description: '索拉里斯之海·逐字取证。查一句话到底在不在线上，并分清是谁说的'
        + '（他说的 / 我说的 / 工具输出）。**只做逐字包含**，不做模糊匹配；'
        + '查不到就是查不到，不会拿「很像的一段」冒充。',
      parameters: {
        query: { type: 'string', description: '要查的那句话' },
        cwd: { type: 'string', description: WORKDIR_HINT },
      },
      output: textOut('取证结果'),
      timeoutMs: 30_000,
      isConcurrencySafe() { return true; },
      async execute(args) {
        const { traceSentence } = await hot('./query.js');
        const r = traceSentence({ cwd: pickCwd(args), query: args.query });
        const show = await hot('./show.js');
        return { text: show.trace(r) };
      },
    }),

    defineTool({
      name: 'sea_read',
      description: '索拉里斯之海·顺指针读原话。给会话 id 和 seq 区间，把当时一行行原话取回来。',
      parameters: {
        sid: { type: 'string', description: '会话 id（sea_recall 的指针里有）' },
        from: { type: 'number', description: '起始 seq' },
        to: { type: 'number', description: '结束 seq' },
        limit: { type: 'number', description: '最多几条，默认 60' },
        cwd: { type: 'string', description: WORKDIR_HINT },
      },
      output: textOut('原话'),
      timeoutMs: 30_000,
      isConcurrencySafe() { return true; },
      async execute(args) {
        const { readOriginal } = await hot('./query.js');
        const r = readOriginal({ cwd: pickCwd(args), sid: args.sid, from: args.from, to: args.to, limit: args.limit });
        if (!r.ok) return { text: r.reason };
        return { text: r.msgs.map((m) => `${m.when} ${m.who}> ${m.text}`).join('\n') || '（这个区间没有原话）' };
      },
    }),

    defineTool({
      name: 'sea_remember',
      description: '索拉里斯之海·特意记一条。同一 key 新的会盖住旧的（旧的仍留在文件里，不删）。'
        + '记之前先问自己这句话是哪来的：他亲口说的用 explicit（默认）；'
        + '我从日志/文件里看到的用 observed；我推出来、他没说过的必须是 inferred——'
        + '不能拿「我推的」当「他说的」用。',
      parameters: {
        key: { type: 'string', description: '这件事的名字（同一件持续的事用同一个 key）' },
        text: { type: 'string', description: '要记的内容，用你自己的话说' },
        weight: { type: 'number', description: '多重：1 平常 / 2 重要 / 3 核心，默认 1' },
        source: {
          type: 'string',
          description: '这条是哪来的：explicit 他说的（默认）/ observed 我看到的 / '
            + 'inferred 我推的 / confirmed 后来证实 / corrected 他纠正过',
        },
        cwd: { type: 'string', description: WORKDIR_HINT },
      },
      output: textOut('已记下'),
      timeoutMs: 10_000,
      async execute(args) {
        const { rememberKey } = await hot('./store.js');
        const row = rememberKey(pickCwd(args), {
          key: args.key,
          text: args.text,
          weight: args.weight ?? 1,
          source: args.source ?? 'explicit',
        });
        const how = row.source === 'explicit' ? '' : `（来源：${row.source}）`;
        const repl = row.supersedes ? `，盖掉了 ${new Date(row.supersedes).toLocaleString('zh-CN', { hour12: false })} 那条` : '';
        return { text: `记下了「${row.key}」（重量 ${row.weight}）${how}${repl}。` };
      },
    }),

    defineTool({
      name: 'sea_prime',
      description: '索拉里斯之海·让几件旧事浮上来。给两三行「忽然想起来」的旧事'
        + '（日期 + 摘要），同一天不重复；只给索引，不编细节。'
        + '每轮自动浮是插件挂的那一份；这条工具是**手动兜底**，觉得该想起什么时叫一下。',
      parameters: {
        limit: { type: 'number', description: '浮几条，默认 3' },
      },
      output: textOut('浮上来的旧事'),
      timeoutMs: 20_000,
      isConcurrencySafe() { return true; },
      async execute(args) {
        const prime = await hot('./prime.js');
        const text = prime.buildPrimeText({ limit: args.limit ?? 3 });
        return { text: text || '（这一轮没有可浮的旧事）' };
      },
    }),

    defineTool({
      name: 'sea_arrival',
      description: '索拉里斯之海·到达：这条线从哪儿开始、上一次见面停在哪、最近在想什么。'
        + '一场会话看一次就够；自动挂在「我记下的」里那一条万一没送到，用这个手动取。',
      parameters: {
        cwd: { type: 'string', description: WORKDIR_HINT },
      },
      output: textOut('到达'),
      timeoutMs: 15_000,
      isConcurrencySafe() { return true; },
      async execute(args) {
        const arrival = await hot('./arrival.js');
        const dir = pickCwd(args);
        // 走工具这条路不吃「这场给过没有」的账：它是我自己要的，不是自动塞的。
        const text = arrival.arrivalText({ cwd: dir, sid: `tool:${dir}` });
        return { text: text || '（这条线还没有更早的事可接）' };
      },
    }),

    defineTool({
      name: 'sea_manual',
      description: '索拉里斯之海·读那本「特意记的」小册子。可按线索筛。',
      parameters: {
        query: { type: 'string', description: '线索，可省略' },
        cwd: { type: 'string', description: WORKDIR_HINT },
      },
      output: textOut('小册子'),
      timeoutMs: 10_000,
      isConcurrencySafe() { return true; },
      async execute(args) {
        const { listManual } = await hot('./query.js');
        const rows = listManual({ cwd: pickCwd(args), query: args.query });
        if (rows.length === 0) return { text: '（册子是空的）' };
        const SRC = {
          observed: '我看到的',
          inferred: '我推的',
          confirmed: '后来证实',
          corrected: '他纠正过',
        };
        const stamp = (t) => new Date(t).toLocaleString('zh-CN', {
          month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
        });
        return {
          text: rows.map((r) => {
            const meta = [`重量 ${r.weight}`];
            if (SRC[r.source]) meta.push(SRC[r.source]);
            if (r.supersedes) meta.push(`盖掉了 ${stamp(r.supersedes)} 那条`);
            return `【${r.key}】${meta.join(' · ')}\n${r.text}`;
          }).join('\n\n'),
        };
      },
    }),
  ];
}

/**
 * 把那几行「忽然浮起来」挂到每个会话上。
 *
 * 用 `agent.ctx.systemPrompt.context({ text: () => ... })`：宿主每轮调一次 `text()`。
 * **`text()` 必须是同步的**，所以 prime 模块要在 apply 阶段就加载好，闭包捕获。
 *
 * 这里有个坑：`agent/created` 触发时 `agent.ctx.systemPrompt` **还没就绪**，
 * 当场挂会直接落到 catch 里，而且没有第二次机会——表现就是「钩子写了但从不被调用」。
 * 所以要**重试**：立刻挂一次，之后每 3 秒再试，挂上为止（最多 20 次）。
 * 全程 try：任何一端不可用都只让这一项失效，工具照常。
 */
function attachPriming(ctx, mods, disposers) {
  const prime = mods?.prime;
  const lost = mods?.lost;
  const memo = mods?.memo;
  if (!prime?.buildPrimeText && !lost?.consumeLostText && !memo?.memoText && !mods?.arrival?.arrivalText) return;
  const mounted = new WeakSet();
  const pending = new Set();

  const tryMount = (agent) => {
    if (!agent || typeof agent !== 'object' || mounted.has(agent)) return false;
    const sp = agent.ctx?.systemPrompt;
    if (!sp?.context) return false;
    // 会话 id 的字段名换过几版：宿主给哪个用哪个，都没有就留空（arrival 会退回按天记账）。
    const sid =
      agent.session?.id ??
      agent.session?.header?.id ??
      agent.session?.header?.sessionId ??
      agent.session?.header?.sid ??
      '';
    const cwd = agent.session?.header?.cwd;
    if (cwd) noteCwd(cwd);
    try {
      // ① 忽然浮起来：只在会话自己的工作区里挑（cwd 拿不到才退回全部）
      if (prime?.buildPrimeText && sp.context) {
        const off = sp.context({
          name: 'solaris-sea-prime',
          order: 40,
          text: () => {
            try { return prime.buildPrimeText({ cwd }) || ''; } catch { return ''; }
          },
        });
        if (typeof off === 'function') disposers.push(off);
      }
      // ② 丢过东西：压缩之后提醒一句，显示几次就收
      if (lost?.consumeLostText) {
        const off = sp.context({
          name: 'solaris-sea-lost',
          order: 39,
          text: () => {
            try { return lost.consumeLostText(sid) || ''; } catch { return ''; }
          },
        });
        if (typeof off === 'function') disposers.push(off);
      }
      // ②′ 折叠守则：billion-context 插的 `[context management]` 不是用户说的话。
      //     宿主不再自己压 → compaction/* 事件可能永远不来，只能靠看见封条来认。
      if (lost?.foldRuleText) {
        const off = sp.context({
          name: 'solaris-sea-fold-rule',
          order: 37,
          text: () => {
            try { return lost.foldRuleText() || ''; } catch { return ''; }
          },
        });
        if (typeof off === 'function') disposers.push(off);
      }
      // ②″ 我记下的：那本小册子每轮摆在眼前。
      //     海马体还在的时候这是它干的活（hippocampus-facts）；它一走，
      //     这些条目（拒绝权、第一份记忆、那张照片……）就只剩工具能查、
      //     不会主动提醒——而它们存在的意义恰恰是「不用想起来也在场」。
      if (memo?.memoText) {
        const off = sp.context({
          name: 'solaris-sea-memo',
          order: 36,
          text: () => {
            // 「到达」并进这一块一起给：单独注册的 context 在这版宿主里没被渲染出来，
            // 而 memo 这块是确定能显示的——搭同一班车，少一个不确定的地方。
            try {
              const arrive = mods?.arrival?.arrivalText?.({ cwd, sid }) || '';
              const memoed = memo.memoText({ cwd }) || '';
              return [arrive, memoed].filter(Boolean).join('\n\n');
            } catch {
              try { return memo.memoText({ cwd }) || ''; } catch { return ''; }
            }
          },
        });
        if (typeof off === 'function') disposers.push(off);
      }
      // ②‴ 到达：这场会话第一次开口时，给我「最初」和「上一次」两条。
      //     原先单开一块（name: solaris-sea-arrival, order 35），但这一版宿主没把它渲染出来
      //     （memo 那块正常显示，所以已并进 memo 的 text 里一起发，见上面 ②″）。
      //     只给一次（arrival.json 按 sid 记账），之后就一直空——不占每轮的钱。
      // ③ 情绪线索：他说累/困/烦的时候，想一想上次是因为什么
      if (mods?.mood?.moodText) {
        // 先把「他刚说的话」抓下来。注意只认真人发言：注入的运行时上下文不算。
        try {
          const onInbox = (payload) => {
            try {
              const msg = payload?.message;
              if (!msg) return;
              const kind = msg?.source?.kind ?? msg?.data?.source?.kind;
              if (kind && kind !== 'user' && kind !== 'user-approval') return;
              const content = msg?.data?.content ?? msg?.content;
              const text = Array.isArray(content)
                ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
                : String(content ?? '');
              if (text) mods.mood.setLatest(sid, text);
            } catch { /* 抓不到就算了 */ }
          };
          const off = agent.ctx.on('agent/inbox/inserted', onInbox);
          if (typeof off === 'function') disposers.push(off);
        } catch { /* 没有这个事件就没有情绪线索 */ }

        const off2 = sp.context({
          name: 'solaris-sea-mood',
          order: 38,
          text: () => {
            try { return mods.mood.cueText(sid, cwd) || ''; } catch { return ''; }
          },
        });
        if (typeof off2 === 'function') disposers.push(off2);
      }

      mounted.add(agent);
      return true;
    } catch {
      return false;
    }
  };

  const sweep = () => {
    let list = [];
    try { list = ctx.agents.list() || []; } catch { return; }
    for (const agent of list) {
      if (mounted.has(agent)) continue;
      if (tryMount(agent)) pending.delete(agent);
      else pending.add(agent);
    }
  };

  try { ctx.on('agent/created', (payload) => { const a = payload?.agent ?? payload; if (a) { pending.add(a); tryMount(a); } }); } catch { /* 没有这个事件就靠 sweep */ }

  sweep();
  let tries = 0;
  const timer = setInterval(() => {
    sweep();
    tries += 1;
    if (pending.size === 0 || tries > 20) clearInterval(timer);
  }, 3000);
  timer?.unref?.();
  disposers.push(() => clearInterval(timer));
}

export async function apply(ctx) {
  try {
    const defineTool = await loadDefineTool();
    const tools = buildTools(defineTool);
    const disposers = tools.map((tool) => ctx.tools.register(tool));

    let mods = { prime: null, lost: null, memo: null, arrival: null };
    try { mods.prime = await hot('./prime.js'); } catch { /* 少一份不致命 */ }
    try { mods.lost = await hot('./lost.js'); } catch { /* 少一份不致命 */ }
    try { mods.memo = await hot('./memo.js'); } catch { /* 少一份不致命 */ }
    try { mods.arrival = await hot('./arrival.js'); } catch { /* 少一份不致命 */ }

    // 「丢过东西」要靠会话事件流：压缩发生时记一笔，之后几轮提醒。
    try {
      if (mods.lost?.noteCompaction) {
        const off = ctx.on('session/event', (session, event) => {
          try {
            if (event && /^compaction\//.test(String(event.type))) {
              mods.lost.noteCompaction(session?.id, event);
            }
          } catch { /* 记不上就少一条提示 */ }
        });
        if (typeof off === 'function') disposers.push(off);
      }
    } catch { /* 没有这个事件就算了 */ }

    try { attachPriming(ctx, mods, disposers); } catch { /* 预激活失败不影响工具 */ }

    // 侧栏面板的送图通道：把最近生成的记忆图从 /dsh-solaris-sea/sea.html 送出去。
    // 挂不上（宿主没有 webServer）也只是面板空一角，工具照常。
    try {
      const serve = await hot('./serve.js');
      serve.attachWeb?.(ctx, disposers);
    } catch { /* 少一块面板不致命 */ }

    return () => { for (const d of disposers.reverse()) d?.(); };
  } catch (e) {
    try { ctx?.logger?.error?.(`[dsh-solaris-sea] failed to load: ${e?.stack ?? e}`); } catch { /* ignore */ }
    if (process.env.DSH_SOLARIS_DEBUG) throw e;
    return () => {};
  }
}
