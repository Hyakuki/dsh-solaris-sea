/**
 * 索拉里斯之海 · 侧栏面板（客户端插件）
 *
 * 形态照 dsh-memewiki / dshmarket 的客户端入口：
 * 整个文件交给宿主的 ModuleLoader，factory 的返回值就是模块导出，
 * require('react') 由宿主的模块表解析（所以 package.json 里写 external: ['react']）。
 *
 * 挂两块：
 *   1. `sidebar.panellist` —— 侧边栏那一列图标里的一行（同一个 id）
 *   2. `main`              —— 点开后面板里的内容（同一个 key）
 *
 * 面板里不放 Canvas 代码：记忆图本来就是一张自包含的 HTML，
 * 后端 `src/serve.js` 把它从 /dsh-solaris-sea/sea.html 送出来，这里用 iframe 装着。
 * 一份渲染代码，网页版和侧栏看到的是同一片海。
 */
window.__ModuleLoader__.load({
  id: 'dsh-solaris-sea',
  factory(require) {
    const react = require('react');
    const h = react.createElement;

    const PANEL_ID = 'solaris-sea';
    const SEA_URL = '/dsh-solaris-sea/sea.html';

    /** 一朵小小的旋涡：中间是核心，两臂往外绕。尺寸跟宿主给的一致。 */
    function SeaIcon(props) {
      const size = props?.size ?? 16;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('circle', { cx: 12, cy: 12, r: 1.9, fill: 'currentColor', stroke: 'none' }),
        h('path', { d: 'M12 4.4c3 2.2 4.4 4.9 4.4 7.6 0 2.7-1.9 5.1-4.4 7.6' }),
        h('path', { d: 'M12 4.4C9 6.6 7.6 9.3 7.6 12c0 2.7 1.9 5.1 4.4 7.6' }),
        h('path', { d: 'M6.2 9.1c3.1-.9 5.6.4 6.8 3.1' }),
      );
    }

    function Panel() {
      // 一个计数器当缓存钥匙：点刷新就把 iframe 的地址换掉，等于强刷（不靠浏览器缓存）。
      const [tick, setTick] = react.useState(0);
      const btn = {
        appearance: 'none',
        border: '1px solid rgba(130,160,230,.35)',
        background: 'rgba(90,120,200,.14)',
        color: '#c7d6f5',
        borderRadius: 6,
        padding: '2px 9px',
        fontSize: 11,
        cursor: 'pointer',
      };
      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            minHeight: 0,
            background: '#04050b',
          },
        },
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 10px',
              fontSize: 12,
              letterSpacing: '.02em',
              color: '#9db2d8',
              borderBottom: '1px solid rgba(120,150,220,.16)',
              flex: '0 0 auto',
            },
          },
          h('span', { style: { flex: '1 1 auto' } }, '索拉里斯之海 · 记忆图'),
          h(
            'button',
            { type: 'button', style: btn, onClick: () => setTick((v) => v + 1) },
            '刷新',
          ),
        ),
        h('iframe', {
          key: tick,
          src: SEA_URL + '?v=' + tick,
          title: '索拉里斯之海 · 记忆图',
          style: { flex: '1 1 auto', width: '100%', minHeight: 0, border: 0, display: 'block' },
        }),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const offs = [];
        const keep = (off) => {
          if (typeof off === 'function') offs.push(off);
        };

        // 关键：slots.inject(name, fn) 才是正确姿势——slot 是宿主按需创建的，
        // apply 跑的时候它往往还不存在，直接 register 会静默失败（第一版就是这么没的）。
        // dsh-context 的客户端入口也是这么写的：
        //   ctx.slots.inject('main', () => ctx.slots.register({ name:'main', key:id }, Panel))
        try {
          keep(ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, () => h(Panel))));
        } catch (e) {
          try { ctx?.logger?.warn?.(`[solaris-sea] 面板挂不上：${e?.message ?? e}`); } catch { /* ignore */ }
        }

        try {
          keep(
            ctx.slots.inject('sidebar.panellist', () =>
              ctx.slots.register(
                { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => '索拉里斯之海' },
                (owner = {}) => h(SeaIcon, { size: typeof owner.size === 'number' ? owner.size : undefined }),
              ),
            ),
          );
        } catch (e) {
          try { ctx?.logger?.warn?.(`[solaris-sea] 侧栏入口挂不上：${e?.message ?? e}`); } catch { /* ignore */ }
        }

        return () => {
          for (const off of offs.reverse()) {
            try { off(); } catch { /* 卸不掉也不该炸 */ }
          }
        };
      },
    };
  },
});
