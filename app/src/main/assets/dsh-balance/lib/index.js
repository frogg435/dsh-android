/**
 * dsh-balance — host side.
 *
 * Polls the DeepSeek balance endpoint on behalf of the browser UI and exposes
 * the normalized result through a same-origin JSON route plus the shared
 * client KV store, so the client plugin can render it without ever holding the
 * API key.
 *
 * The key is resolved exactly the way the shipped DeepSeek plugins do it:
 * an explicit literal `apiKey` in config wins, otherwise the named credential
 * reference is resolved through the credentials service, falling back to the
 * launching environment.
 *
 * @module dsh-balance
 */

/** Plugin name registered with the loader. */
import { PROVIDERS, providerById } from './providers.js';

export { PROVIDERS, providerById };

export const name = 'balance';

/**
 * Services this plugin needs before it can apply. `clientKv` is optional in
 * practice: when it is absent the HTTP route still works and the UI simply
 * polls instead of being pushed.
 */
export const inject = ['webServer'];

/** Default credential reference holding the DeepSeek API key. */
/** Default provider id when the config does not name one. */
export const DEFAULT_PROVIDER = 'deepseek';

/** Kept for the original DeepSeek-only configuration. */
export const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY';

/** Default balance endpoint. */
export const DEFAULT_BASE_URL = 'https://api.deepseek.com';

/** Default poll interval, in milliseconds. */
export const DEFAULT_REFRESH_MS = 60_000;

/** Default HTTP route the browser UI reads. */
export const DEFAULT_ROUTE = '/dsh-balance';

/** Where the latest snapshot is mirrored for client-side subscription. */
export const KV_SCOPE = 'dsh-balance';
export const KV_KEY = 'snapshot';

/** Shortest interval a client may request, to bound upstream traffic. */
const MIN_INTERVAL_MS = 15_000;

/** Longest backoff after repeated failures. */
const MAX_INTERVAL_MS = 15 * 60_000;

/**
 * Render a short, human-readable balance for compact surfaces.
 * @param snapshot - a normalized snapshot.
 * @returns e.g. `¥36.28`, or `--` when nothing is known yet.
 */
export function formatBalance(snapshot) {
  const info = snapshot?.infos?.[0];
  if (info === undefined || info.total === undefined) return '--';
  const symbol = info.currency === 'CNY' ? '¥' : info.currency === 'USD' ? '$' : `${info.currency} `;
  return `${symbol}${info.total.toFixed(2)}`;
}

/**
 * Resolve the API key for one request without retaining it anywhere.
 * @param ctx - plugin context supplying the credential plane.
 * @param config - the currently authoritative plugin config.
 * @returns the API key, or undefined when none is configured.
 */
async function resolveApiKey(ctx, config) {
  if (typeof config.apiKey === 'string' && config.apiKey.length > 0) return config.apiKey;
  const name = config.apiKeyEnv ?? resolveProvider(config).env ?? DEFAULT_API_KEY_ENV;
  const credentials = ctx.get('credentials');
  if (credentials !== undefined) {
    // The credentials service resolves either the bare reference name or a
    // branded key; passing the name keeps this plugin free of an import that
    // may not resolve from every profile layout.
    const resolved = await credentials.resolve(name);
    if (resolved?.value) return resolved.value;
  }
  const ambient = process.env[name];
  return ambient !== undefined && ambient.length > 0 ? ambient : undefined;
}

/** The provider this snapshot should be read from. */
function resolveProvider(config) {
  return providerById(config.provider ?? DEFAULT_PROVIDER);
}

/**
 * Fetch and normalize the current balance for the configured provider.
 *
 * One request path for every provider: the catalog supplies the route and a
 * `pick` function that turns the payload into money or quota entries. Providers
 * that cannot be queried with an API key say so instead of failing obscurely.
 *
 * @param ctx - plugin context supplying the credential plane.
 * @param config - the currently authoritative plugin config.
 * @returns a normalized snapshot describing the outcome.
 */
async function fetchBalance(ctx, config) {
  const checkedAt = Date.now();
  const provider = resolveProvider(config);
  const base = {
    provider: provider.id,
    providerName: provider.name,
    kind: provider.kind,
    checkedAt
  };

  // Nothing to ask for. Reported as a state, not an error: the key is fine, the
  // vendor simply does not publish a balance.
  if (provider.kind === 'none' || provider.kind === 'indirect') {
    return {
      ...base,
      ok: false,
      error: provider.note
        ?? `${provider.name} 不提供余额接口（API Key + Base URL 仍可正常调用模型）`
    };
  }

  const path = config.balancePath || provider.path;
  if (!path) {
    return {
      ...base,
      ok: false,
      error: `${provider.name} 的余额端点未公开，请在插件配置里填 balancePath`
    };
  }

  let key;
  try {
    key = await resolveApiKey(ctx, config);
  } catch (error) {
    return { ...base, error: `凭据解析失败: ${String(error?.message ?? error)}` };
  }
  if (key === undefined) {
    return {
      ...base,
      error: `未配置 API Key（凭据 ${config.apiKeyEnv ?? provider.env ?? DEFAULT_API_KEY_ENV} 为空）`
    };
  }

  const root = (config.baseURL || provider.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 15_000);
  try {
    const response = await fetch(`${root}${path}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      const detail = text.slice(0, 200).replace(/\s+/g, ' ');
      return { ...base, ok: false, error: `HTTP ${response.status}: ${detail}` };
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return { ...base, ok: false, error: '响应不是合法 JSON' };
    }
    let infos = [];
    try {
      infos = provider.pick(payload) ?? [];
    } catch (error) {
      return { ...base, ok: false, error: `无法解析 ${provider.name} 的响应: ${String(error?.message ?? error)}` };
    }
    return {
      ...base,
      ok: true,
      available: provider.available ? provider.available(payload) === true : true,
      infos
    };
  } catch (error) {
    const message = error?.name === 'AbortError' ? '请求超时' : String(error?.message ?? error);
    return { ...base, ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Mount the balance plugin.
 * @param ctx - plugin context.
 * @param config - validated plugin config.
 */
export function apply(ctx, config) {
  let current = () => config;
  let latest;
  let inflight;
  let lastAttempt = 0;
  let failures = 0;
  const subscribers = new Set();

  const publish = (snapshot) => {
    latest = snapshot;
    for (const notify of subscribers) {
      try {
        notify(snapshot);
      } catch {
        /* a broken subscriber must not break the poller */
      }
    }
    // Mirror into the shared client store when one is mounted, so the UI can
    // subscribe instead of polling.
    const kv = ctx.get('clientKv');
    if (kv !== undefined) {
      try {
        kv.set(KV_SCOPE, KV_KEY, snapshot);
      } catch {
        /* the HTTP route remains the source of truth */
      }
    }
  };

  /** Read through a cache window so bursts of clients cost one upstream call. */
  const read = async (minIntervalMs) => {
    const now = Date.now();
    const interval = Math.max(minIntervalMs, MIN_INTERVAL_MS);
    if (latest !== undefined && now - lastAttempt < interval) return latest;
    if (inflight !== undefined) return inflight;
    lastAttempt = now;
    inflight = fetchBalance(ctx, current())
      .then((snapshot) => {
        failures = snapshot.ok ? 0 : failures + 1;
        publish(snapshot);
        return snapshot;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };

  // Background refresh keeps the number warm; its cadence backs off on failure
  // so an invalid key does not hammer the endpoint.
  const timer = setInterval(() => {
    if (failures === 0) {
      void read(current().refreshMs ?? DEFAULT_REFRESH_MS);
      return;
    }
    const backoff = Math.min(MIN_INTERVAL_MS * 2 ** failures, MAX_INTERVAL_MS);
    void read(backoff);
  }, Math.max(current().refreshMs ?? DEFAULT_REFRESH_MS, MIN_INTERVAL_MS));
  if (typeof timer.unref === 'function') timer.unref();

  ctx.effect(() => () => {
    clearInterval(timer);
    subscribers.clear();
  }, 'balance: stop polling');

  const route = current().route ?? DEFAULT_ROUTE;

  // The browser reads through this same-origin route. `force=1` bypasses the
  // cache window, which is what the UI's refresh button sends. The key never
  // leaves the host; the client only ever sees the normalized snapshot.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: route,
        handler: async (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405);
            res.end();
            return;
          }
          const url = new URL(req.url ?? route, 'http://localhost');
          let snapshot;
          if (url.searchParams.get('force') === '1') {
            snapshot = await fetchBalance(ctx, current());
            failures = snapshot.ok ? 0 : failures + 1;
            publish(snapshot);
          } else {
            snapshot = await read(current().refreshMs ?? DEFAULT_REFRESH_MS);
          }
          const body = JSON.stringify(snapshot);
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(body),
            'Cache-Control': 'no-store'
          });
          res.end(req.method === 'HEAD' ? undefined : body);
        }
      }),
    'balance: /api route'
  );

  // Warm the first value so the UI has something to show immediately.
  void read(MIN_INTERVAL_MS);
}

export { fetchBalance, resolveApiKey };
