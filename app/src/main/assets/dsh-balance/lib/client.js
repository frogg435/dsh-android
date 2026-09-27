window.__ModuleLoader__.load({
  id: 'dsh-balance',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const jsxRuntime = require('react/jsx-runtime');
    const h = jsxRuntime.jsx;
    const hf = jsxRuntime.jsxs;

    /** Namespace for the plugin's own stylesheet. */
    const NS = 'dsh-balance';
    /** Same-origin route served by the host half of this plugin. The `/api`
     * prefix belongs to the connection plugin's authenticated RPC channel, so
     * this widget uses its own top-level namespace instead. */
    const ENDPOINT = '/dsh-balance';
    /** localStorage key remembering the last successful snapshot. */
    const CACHE_KEY = 'dsh-balance:snapshot';
    /** How often the mounted widget re-reads when the tab is visible. */
    const POLL_MS = 60_000;

    const CSS = `
.dsh-balance-root{display:flex;flex-direction:column;gap:6px;width:100%}
.dsh-balance-pill{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;
  padding:8px 10px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l3);
  background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-primary);
  font-size:13px;line-height:18px;cursor:pointer;text-align:left;font-family:inherit}
.dsh-balance-pill:hover{background:var(--dsw-alias-button-floating-hover)}
.dsh-balance-pill[data-state=failed]{border-color:var(--dsw-alias-border-l3)}
.dsh-balance-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-caption)}
.dsh-balance-dot[data-ok="1"]{background:#22c55e}
.dsh-balance-dot[data-ok="0"]{background:#ef4444}
.dsh-balance-dot[data-warn="1"]{background:#f59e0b}
.dsh-balance-label{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-balance-amount{flex:none;font-weight:600;font-variant-numeric:tabular-nums}
.dsh-balance-rail{display:flex;justify-content:center;align-items:center;width:36px;height:36px;
  border-radius:50%;border:none;background:0 0;cursor:pointer;color:var(--dsw-alias-label-primary);
  font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;padding:0;font-family:inherit}
.dsh-balance-rail:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-balance-panel{margin:4px 2px 8px;padding:10px;border-radius:12px;
  border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-button-elevated-fill);
  color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}
.dsh-balance-row{display:flex;justify-content:space-between;gap:10px;padding:2px 0}
.dsh-balance-row dt{color:var(--dsw-alias-label-caption);min-width:0}
.dsh-balance-row dd{margin:0;font-variant-numeric:tabular-nums;text-align:right}
.dsh-balance-total{font-size:17px;font-weight:600}
.dsh-balance-error{color:#ef4444;word-break:break-word}
.dsh-balance-actions{display:flex;gap:6px;margin-top:8px}
.dsh-balance-btn{flex:1;padding:6px 8px;border-radius:8px;cursor:pointer;font-family:inherit;
  border:.5px solid var(--dsw-alias-border-l3);background:0 0;
  color:var(--dsw-alias-label-primary);font-size:12px}
.dsh-balance-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-balance-btn:disabled{opacity:.5;cursor:default}
.dsh-balance-meta{margin-top:6px;color:var(--dsw-alias-label-caption);font-size:11px}
`;

    /** Inject the stylesheet once per document. */
    function ensureStyles() {
      if (typeof document === 'undefined') return;
      const id = `${NS}:css`;
      if (document.getElementById(id)) return;
      const style = document.createElement('style');
      style.id = id;
      style.setAttribute('data-plugin-css', NS);
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    /** Currency symbol for the compact display. */
    function symbolOf(currency) {
      if (currency === 'CNY') return '¥';
      if (currency === 'USD') return '$';
      return `${currency} `;
    }

    /**
     * Format the headline figure from a snapshot.
     * @param snapshot - normalized snapshot, or undefined before the first read.
     * @returns e.g. `¥36.28`, or `--` when unknown.
     */
    function headline(snapshot) {
      const info = snapshot && Array.isArray(snapshot.infos) ? snapshot.infos[0] : undefined;
      if (!info) return '--';
      // Quota vendors (MiniMax, 智谱) report a percentage, not money.
      if (typeof info.percent === 'number') return `${info.percent.toFixed(0)}%`;
      if (typeof info.total !== 'number') return '--';
      return `${symbolOf(info.currency)}${info.total.toFixed(2)}`;
    }

    /** The provider's display name, so the widget is not DeepSeek-specific. */
    function providerName(snapshot) {
      return (snapshot && snapshot.providerName) || 'DeepSeek';
    }

    /** Compact money for one field. */
    function money(value, currency) {
      if (typeof value !== 'number') return '--';
      return `${symbolOf(currency)}${value.toFixed(2)}`;
    }

    /** Read the localStorage cache so the widget never flashes empty. */
    function readCache() {
      try {
        const raw = window.localStorage.getItem(CACHE_KEY);
        return raw ? JSON.parse(raw) : undefined;
      } catch {
        return undefined;
      }
    }

    /** Persist the last successful snapshot. */
    function writeCache(snapshot) {
      try {
        window.localStorage.setItem(CACHE_KEY, JSON.stringify(snapshot));
      } catch {
        /* storage may be unavailable; the widget still works in memory */
      }
    }

    /**
     * Fetch the balance snapshot from the host route.
     * @param force - bypass the host's cache window.
     * @returns the normalized snapshot.
     */
    async function load(force) {
      const response = await fetch(force ? `${ENDPOINT}?force=1` : ENDPOINT, {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin'
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const snapshot = await response.json();
      if (snapshot && snapshot.ok) writeCache(snapshot);
      return snapshot;
    }

    /** Track a snapshot plus its loading/error state. */
    function useBalance() {
      const [snapshot, setSnapshot] = react.useState(() => readCache());
      const [busy, setBusy] = react.useState(false);
      const [failure, setFailure] = react.useState(undefined);

      const refresh = react.useCallback(
        async (force) => {
          setBusy(true);
          try {
            const next = await load(force);
            setSnapshot(next);
            setFailure(next && next.ok ? undefined : next && next.error);
          } catch (error) {
            setFailure(String((error && error.message) || error));
          } finally {
            setBusy(false);
          }
        },
        []
      );

      react.useEffect(() => {
        void refresh(false);
        const timer = window.setInterval(() => {
          if (document.visibilityState === 'visible') void refresh(false);
        }, POLL_MS);
        return () => window.clearInterval(timer);
      }, [refresh]);

      return { snapshot, busy, failure, refresh };
    }

    /** The expanded card: totals, grant vs top-up, refresh and timestamp. */
    function BalancePanel(props) {
      const { snapshot, busy, failure, refresh, wide } = props;
      const info = snapshot && Array.isArray(snapshot.infos) ? snapshot.infos[0] : undefined;
      const checked =
        snapshot && snapshot.checkedAt
          ? new Date(snapshot.checkedAt).toLocaleTimeString()
          : undefined;
      return hf('div', {
        className: 'dsh-balance-panel',
        children: [
          hf('div', {
            key: 'head',
            className: 'dsh-balance-row',
            children: [
              h('dt', { key: 'k', children: `${providerName(snapshot)} 余额` }),
              h('dd', { key: 'v', className: 'dsh-balance-total', children: headline(snapshot) })
            ]
          }),
          info && typeof info.granted === 'number'
            ? hf('div', {
                key: 'granted',
                className: 'dsh-balance-row',
                children: [
                  h('dt', { key: 'k', children: '赠金' }),
                  h('dd', { key: 'v', children: money(info.granted, info.currency) })
                ]
              })
            : null,
          info && typeof info.toppedUp === 'number'
            ? hf('div', {
                key: 'topped',
                className: 'dsh-balance-row',
                children: [
                  h('dt', { key: 'k', children: '充值余额' }),
                  h('dd', { key: 'v', children: money(info.toppedUp, info.currency) })
                ]
              })
            : null,
          snapshot && snapshot.ok === false
            ? h('div', { key: 'err', className: 'dsh-balance-error', children: failure || snapshot.error })
            : null,
          hf('div', {
            key: 'actions',
            className: 'dsh-balance-actions',
            children: [
              h('button', {
                key: 'refresh',
                type: 'button',
                className: 'dsh-balance-btn',
                disabled: busy,
                onClick: () => void refresh(true),
                children: busy ? '刷新中…' : '刷新'
              }),
              h('button', {
                key: 'hide',
                type: 'button',
                className: 'dsh-balance-btn',
                onClick: props.onCollapse,
                children: wide ? '收起' : '关闭'
              })
            ]
          }),
          checked
            ? h('div', { key: 'meta', className: 'dsh-balance-meta', children: `更新于 ${checked}` })
            : null
        ]
      });
    }

    /**
     * The sidebar footer entry: a pill while the sidebar is wide, a compact
     * amount while it is collapsed into the rail. Clicking toggles the panel.
     */
    function BalanceEntry(props) {
      ensureStyles();
      const wide = props.wide !== false;
      const state = useBalance();
      const [open, setOpen] = react.useState(false);
      const { snapshot, busy, failure } = state;
      const ok = snapshot && snapshot.ok === true;
      const warn = snapshot && snapshot.ok === true && snapshot.available === false;

      const label = !snapshot ? '读取中…' : ok ? providerName(snapshot) : '余额不可用';
      const amount = snapshot && snapshot.ok === false ? '!' : headline(snapshot);

      if (!wide) {
        return hf(react.Fragment, {
          children: [
            h('button', {
              type: 'button',
              className: 'dsh-balance-rail',
              title: `${label} ${amount}`,
              'aria-label': `${providerName(snapshot)} 余额 ${amount}`,
              onClick: () => setOpen((v) => !v),
              children: amount
            }),
            open ? h(BalancePanel, {
              snapshot,
              busy,
              failure,
              refresh: state.refresh,
              wide: false,
              onCollapse: () => setOpen(false)
            }) : null
          ]
        });
      }

      return hf('div', {
        className: 'dsh-balance-root',
        children: [
          hf('button', {
            key: 'pill',
            type: 'button',
            className: 'dsh-balance-pill',
            'data-state': ok ? 'ok' : 'failed',
            title: failure || (ok ? `可用余额 ${amount}` : '点击查看详情'),
            onClick: () => setOpen((v) => !v),
            children: [
              h('span', {
                key: 'dot',
                className: 'dsh-balance-dot',
                'data-ok': ok ? '1' : '0',
                'data-warn': warn ? '1' : undefined
              }),
              h('span', { key: 'label', className: 'dsh-balance-label', children: label }),
              h('span', { key: 'amount', className: 'dsh-balance-amount', children: amount })
            ]
          }),
          open
            ? h(BalancePanel, {
                key: 'panel',
                snapshot,
                busy,
                failure,
                refresh: state.refresh,
                wide: true,
                onCollapse: () => setOpen(false)
              })
            : null
        ]
      });
    }

    /** Browser half: occupies the sidebar footer slot. */
    function apply(ctx) {
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'deepseek-balance'
          },
          BalanceEntry
        )
      );
    }

    // cordis refuses to hand over a service the plugin never declared:
    // apply() reaches for ctx.slots, so 'slots' must be injected first —
    // otherwise the loader fails with
    //   cannot get property 'slots' without inject
    exports.inject = ['slots'];
    exports.apply = apply;
    exports.BalanceEntry = BalanceEntry;
    exports.headline = headline;
    return module.exports;
  }
});
