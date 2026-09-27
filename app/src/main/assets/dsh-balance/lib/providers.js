/**
 * Provider catalog for dsh-balance.
 *
 * Data, not code: every provider is one entry, and the host runs the same
 * request/report path for all of them. Adding a provider means adding a row.
 *
 * `kind` says what can honestly be reported:
 *   money    — a currency balance the API returns directly
 *   quota    — usage-plan percentages rather than money
 *   indirect — a balance exists upstream but needs more than an API key
 *              (an admin key, OAuth, or a separate cloud billing API)
 *   none     — no balance endpoint at all; the API key + base URL still call
 *              models, there is just nothing to display
 *
 * Endpoint paths are relative to the provider's `baseURL`. Providers whose paths
 * are not publicly documented ship with `path: null` so the UI says so instead
 * of guessing a URL; set `balancePath` in the plugin config to use them.
 */

/** Parse a currency amount that APIs return as number or string. */
export function num(value) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** First defined value among the candidates. */
function first(...values) {
  for (const value of values) if (value !== undefined && value !== null && value !== '') return value;
  return undefined;
}

/** money entry: `{currency, total, granted?, toppedUp?}` */
function money(currency, total, granted, toppedUp) {
  const t = num(total);
  if (t === undefined) return undefined;
  const g = num(granted);
  const u = num(toppedUp);
  return {
    currency: currency || 'UNKNOWN',
    total: t,
    ...g === undefined ? {} : { granted: g },
    ...u === undefined ? {} : { toppedUp: u }
  };
}

/** One row per provider. Keep roughly grouped: direct, then indirect, then none. */
export const PROVIDERS = [
  /* ---------- monetary balance, queryable with an API key ---------- */
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    env: 'DEEPSEEK_API_KEY',
    kind: 'money',
    path: '/user/balance',
    // {is_available, balance_infos: [{currency, total_balance, granted_balance, topped_up_balance}]}
    available: (j) => j?.is_available !== false,
    pick: (j) => (Array.isArray(j?.balance_infos) ? j.balance_infos : [])
      .map((b) => money(b?.currency, b?.total_balance, b?.granted_balance, b?.topped_up_balance))
      .filter(Boolean)
  },
  {
    id: 'moonshot',
    name: 'Moonshot / Kimi',
    baseURL: 'https://api.moonshot.cn',
    env: 'MOONSHOT_API_KEY',
    kind: 'money',
    path: '/v1/users/me/balance',
    // {data: {available_balance, voucher_balance, cash_balance}, status}
    pick: (j) => [
      money(first(j?.data?.currency, j?.currency, 'CNY'),
        first(j?.data?.available_balance, j?.data?.balance),
        j?.data?.voucher_balance, j?.data?.cash_balance)
    ].filter(Boolean)
  },
  {
    id: 'stepfun',
    name: '阶跃星辰 StepFun',
    baseURL: 'https://api.stepfun.com',
    env: 'STEPFUN_API_KEY',
    kind: 'money',
    path: '/v1/accounts',
    pick: (j) => [
      money(first(j?.data?.currency, j?.currency, 'CNY'),
        first(j?.data?.balance, j?.data?.available_balance, j?.balance))
    ].filter(Boolean)
  },
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    baseURL: 'https://api.siliconflow.cn',
    env: 'SILICONFLOW_API_KEY',
    kind: 'money',
    path: '/v1/user/info',
    pick: (j) => [
      money(first(j?.data?.currency, j?.currency, 'CNY'),
        first(j?.data?.totalBalance, j?.data?.balance, j?.totalBalance))
    ].filter(Boolean)
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    env: 'OPENROUTER_API_KEY',
    kind: 'money',
    path: '/credits',
    // {data: {total_credits, total_usage}} — remaining is the difference.
    pick: (j) => {
      const credits = num(j?.data?.total_credits);
      const usage = num(j?.data?.total_usage);
      if (credits === undefined) return [];
      return [money('USD', credits - (usage ?? 0), credits, usage)].filter(Boolean);
    }
  },
  {
    id: 'ofox',
    name: 'Ofox.ai',
    baseURL: 'https://api.ofox.ai',
    env: 'OFOX_API_KEY',
    kind: 'money',
    path: '/v1/user/balance',
    pick: (j) => [
      money(first(j?.data?.currency, j?.currency, 'USD'),
        first(j?.data?.balance, j?.data?.available_balance, j?.balance))
    ].filter(Boolean)
  },
  {
    id: 'novita',
    name: 'Novita AI',
    baseURL: 'https://api.novita.ai',
    env: 'NOVITA_API_KEY',
    kind: 'money',
    path: '/v3/user/balance',
    // {availableBalance, cashBalance, creditLimit, currency}
    pick: (j) => [
      money(first(j?.currency, 'USD'), first(j?.availableBalance, j?.balance),
        j?.creditLimit)
    ].filter(Boolean)
  },
  {
    id: 'xai',
    name: 'xAI / Grok',
    baseURL: 'https://api.x.ai',
    env: 'XAI_API_KEY',
    kind: 'money',
    // The balance route is not publicly documented; set balancePath in config.
    path: null,
    pick: (j) => [
      money(first(j?.currency, 'USD'),
        first(j?.balance, j?.data?.balance, j?.available_balance, j?.data?.available_balance))
    ].filter(Boolean)
  },
  {
    id: 'newapi',
    name: 'NewAPI / OneAPI 中转站',
    baseURL: '',
    env: 'OPENAI_API_KEY',
    kind: 'money',
    // NewAPI and OneAPI expose an OpenAI-compatible billing shim, so the same
    // API key used for model calls reads it. Point baseURL at the relay.
    path: '/dashboard/billing/credit_grants',
    pick: (j) => [
      money('USD', first(j?.total_available, j?.total_granted, j?.hard_limit_usd))
    ].filter(Boolean)
  },

  /* ---------- usage plans instead of money ---------- */
  {
    id: 'minimax',
    name: 'MiniMax',
    baseURL: 'https://api.minimax.chat',
    env: 'MINIMAX_API_KEY',
    kind: 'quota',
    path: '/v1/token_plan/remains',
    pick: (j) => (Array.isArray(j?.model_remains) ? j.model_remains : [])
      .map((m) => ({
        label: String(first(m?.model_name, m?.model) ?? 'model'),
        percent: num(first(m?.current_interval_remaining_percent, m?.remaining_percent))
      }))
      .filter((q) => q.percent !== undefined)
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseURL: 'https://open.bigmodel.cn',
    env: 'ZHIPU_API_KEY',
    kind: 'quota',
    path: '/api/monitor/usage/quota/limit',
    pick: (j) => (Array.isArray(j?.data?.limits) ? j.data.limits : [])
      .map((l) => ({
        label: String(first(l?.type, l?.model, 'quota')),
        percent: num(first(l?.usage, l?.percentage, l?.percent))
      }))
      .filter((q) => q.percent !== undefined)
  },

  /* ---------- balance exists, but an API key is not enough ---------- */
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    baseURL: 'https://api.anthropic.com',
    env: 'ANTHROPIC_API_KEY',
    kind: 'indirect',
    path: null,
    note: '用量 API 需要 Admin Key（普通 API Key 无权限）'
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    baseURL: 'https://generativelanguage.googleapis.com',
    env: 'GEMINI_API_KEY',
    kind: 'indirect',
    path: null,
    note: '配额查询需要 OAuth，API Key 不够'
  },
  {
    id: 'together',
    name: 'Together AI',
    baseURL: 'https://api.together.xyz',
    env: 'TOGETHER_API_KEY',
    kind: 'indirect',
    path: null,
    note: '只有用量 API，没有余额'
  },
  {
    id: 'azure',
    name: '微软 Azure OpenAI',
    baseURL: '',
    env: 'AZURE_OPENAI_API_KEY',
    kind: 'indirect',
    path: null,
    note: '需 Azure Consumption API（不同的凭据体系）'
  },
  {
    id: 'aws',
    name: '亚马逊 AWS Bedrock',
    baseURL: '',
    env: 'AWS_ACCESS_KEY_ID',
    kind: 'indirect',
    path: null,
    note: '需 Bedrock AgentCore 的 GetPaymentInstrumentBalance'
  },

  /* ---------- no balance endpoint: the key still calls models ---------- */
  { id: 'openai', name: 'OpenAI', baseURL: 'https://api.openai.com/v1', env: 'OPENAI_API_KEY', kind: 'none' },
  { id: 'mistral', name: 'Mistral AI', baseURL: 'https://api.mistral.ai/v1', env: 'MISTRAL_API_KEY', kind: 'none' },
  { id: 'cohere', name: 'Cohere', baseURL: 'https://api.cohere.com', env: 'COHERE_API_KEY', kind: 'none' },
  { id: 'perplexity', name: 'Perplexity', baseURL: 'https://api.perplexity.ai', env: 'PERPLEXITY_API_KEY', kind: 'none' },
  { id: 'groq', name: 'Groq', baseURL: 'https://api.groq.com/openai/v1', env: 'GROQ_API_KEY', kind: 'none' },
  { id: 'cerebras', name: 'Cerebras', baseURL: 'https://api.cerebras.ai/v1', env: 'CEREBRAS_API_KEY', kind: 'none' },
  { id: 'fireworks', name: 'Fireworks AI', baseURL: 'https://api.fireworks.ai/inference/v1', env: 'FIREWORKS_API_KEY', kind: 'none' },
  { id: 'modelscope', name: 'ModelScope 魔搭', baseURL: 'https://api-inference.modelscope.cn/v1', env: 'MODELSCOPE_API_KEY', kind: 'none' },
  { id: 'qiniu', name: '七牛云', baseURL: 'https://openai.qiniu.com/v1', env: 'QINIU_API_KEY', kind: 'none' },
  { id: 'dashscope', name: '阿里云百炼 Qwen', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', env: 'DASHSCOPE_API_KEY', kind: 'none' },
  { id: 'volcengine', name: '火山引擎 豆包', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', env: 'ARK_API_KEY', kind: 'none' },
  { id: 'qianfan', name: '百度千帆 文心', baseURL: 'https://qianfan.baidubce.com/v2', env: 'QIANFAN_API_KEY', kind: 'none' },
  { id: 'hunyuan', name: '腾讯混元', baseURL: 'https://api.hunyuan.cloud.tencent.com/v1', env: 'HUNYUAN_API_KEY', kind: 'none' },
  { id: 'baichuan', name: '百川智能 Baichuan', baseURL: 'https://api.baichuan-ai.com/v1', env: 'BAICHUAN_API_KEY', kind: 'none' },
  { id: 'yi', name: '零一万物 Yi', baseURL: 'https://api.lingyiwanwu.com/v1', env: 'YI_API_KEY', kind: 'none' },
  { id: 'longcat', name: '美团 LongCat', baseURL: 'https://api.longcat.chat/openai/v1', env: 'LONGCAT_API_KEY', kind: 'none' },
  { id: 'mimo', name: '小米 MiMo', baseURL: '', env: 'MIMO_API_KEY', kind: 'none' },
  { id: 'aihubmix', name: 'AiHubMix', baseURL: 'https://aihubmix.com/v1', env: 'AIHUBMIX_API_KEY', kind: 'none' },
  { id: 'dmxapi', name: 'DMXAPI', baseURL: 'https://www.dmxapi.cn/v1', env: 'DMXAPI_API_KEY', kind: 'none' },
  { id: '302ai', name: '302.AI', baseURL: 'https://api.302.ai/v1', env: 'AI302_API_KEY', kind: 'none' },
  { id: 'vercel', name: 'Vercel AI Gateway', baseURL: 'https://ai-gateway.vercel.sh/v1', env: 'AI_GATEWAY_API_KEY', kind: 'none' },
  { id: 'cloudflare', name: 'Cloudflare AI Gateway', baseURL: '', env: 'CLOUDFLARE_API_TOKEN', kind: 'none' }
];

/** Look a provider up by id, falling back to DeepSeek for unknown ids. */
export function providerById(id) {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
}

/** Providers that can actually be queried with an API key. */
export function queryable() {
  return PROVIDERS.filter((p) => p.kind === 'money' || p.kind === 'quota');
}
