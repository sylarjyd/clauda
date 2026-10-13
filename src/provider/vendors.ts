/**
 * 常见大模型厂商的预置表 —— **单一真源**。
 *
 * 为什么要这张表：`openai.ts` 走 OpenAI SDK，它只会往 baseUrl 后面追加
 * `/chat/completions`，**不做任何 `/v1` 补全**。而各家地址的路径并不统一 ——
 * 智谱是 `/api/paas/v4`、火山方舟是 `/api/v3`、百炼是 `/compatible-mode/v1`。
 * 想换一家用，用户得先翻文档、再手敲进 `config.json`，敲错的表现是一个没有任何
 * 解释的 404。这张表把「地址 + 环境变量名 + 常见坑」一次性记住。
 *
 * 放在 `src/provider/` 而不是 `desktop/`：CLI 以后加 `--vendor` 时不用搬家
 * （见本目录 `types.ts` 的分层约定）。
 *
 * **不往 config 里存厂商名**：厂商由 `provider.baseUrl` 推导（下表每个 baseUrl
 * 互不相同，是单射）。存一个 label 只会多出「文件被手改了、label 与 baseUrl
 * 对不上，界面开始撒谎」这种状态。
 */
export interface VendorPreset {
  /** 稳定标识。renderer 只按它查表、不判 —— 推导在主进程做（renderer 走 `app://`，import 不到 dist） */
  key: string
  label: string
  /** **完整前缀**，含各家的非标准路径。不要在这里补 `/v1`，各家不一样 */
  baseUrl: string
  /** 该厂商读的环境变量名；本地部署不需要密钥，留空串 */
  envKey: string
  /** 候选模型名，**首个**会被「切厂商」写进 model。会过期，别当约束 */
  models: readonly string[]
  /** 一句话坑位提醒，直接显示在界面上 —— 这张表的主要价值就在这一行 */
  note?: string
}

/**
 * 九家（本地部署算一条）。模型名与地址都按各家控制台核过，但**都会过期** ——
 * 界面上的候选只作提示，随时可以手填。
 */
export const VENDORS: readonly VendorPreset[] = [
  {
    key: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    envKey: 'DEEPSEEK_API_KEY',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    note: 'deepseek-reasoner 的思维链（reasoning_content）本工具不展示，只取正文。',
  },
  {
    key: 'ark',
    label: '豆包（火山方舟）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    envKey: 'ARK_API_KEY',
    models: ['doubao-seed-2-1-pro-260628', 'doubao-seed-code-preview-251028', 'doubao-seed-1-6-flash-250828'],
    note: 'model 可填模型 ID，也可填自建接入点 ID（ep-…）；走 Coding Plan 要换成 /api/coding/v3。',
  },
  {
    key: 'dashscope',
    label: '通义千问（阿里云百炼）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    envKey: 'DASHSCOPE_API_KEY',
    models: ['qwen3-coder-plus', 'qwen-plus', 'qwen-flash'],
    note: '地址随地域变：美国是 dashscope-us.aliyuncs.com，新/德还要在域名里带业务空间 ID，Key 不通用。',
  },
  {
    key: 'kimi',
    label: 'Kimi（月之暗面）',
    baseUrl: 'https://api.moonshot.cn/v1',
    envKey: 'MOONSHOT_API_KEY',
    models: ['kimi-k2.6', 'kimi-k2.7-code', 'kimi-k3'],
    note: 'kimi-k2-* 旧款与 moonshot-v1 系列已下线；kimi-k3 固定 temperature=1.0，本工具会显式传 temperature，先别选。',
  },
  {
    key: 'minimax',
    label: 'MiniMax',
    baseUrl: 'https://api.minimax.cn/v1',
    envKey: 'MINIMAX_API_KEY',
    models: ['MiniMax-M2', 'MiniMax-M2.7', 'MiniMax-M3'],
    note: '海外版是 api.minimax.io（Key 与国内不通用）；旧域名 api.minimaxi.com 走的是另一条 /v1/text/chatcompletion_v2 路径。',
  },
  {
    key: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    envKey: 'ZHIPU_API_KEY',
    models: ['glm-4.6', 'glm-4.7', 'glm-4.5-air'],
    note: '是 /api/paas/v4 不是 /v1；国际站 api.z.ai 的同名路径，Key 不通用。',
  },
  {
    key: 'siliconflow',
    label: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    envKey: 'SILICONFLOW_API_KEY',
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen3-Coder-Plus'],
    note: '模型名必须带厂商前缀且大小写敏感，写错是 400 Model Not Found。',
  },
  {
    key: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    envKey: 'OPENAI_API_KEY',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1'],
  },
  {
    key: 'local',
    label: '本地部署',
    baseUrl: 'http://localhost:11434/v1',
    envKey: '',
    models: ['qwen2.5-coder:14b', 'llama3.1:8b'],
    note: 'Ollama / vLLM / LM Studio 都走这里，改「接口地址」那行换端口即可；不需要密钥。',
  },
]

export function findVendor(key: string): VendorPreset | undefined {
  return VENDORS.find((v) => v.key === key)
}

/**
 * 把已解析的 baseUrl 反推回厂商，反查不到就是「自定义」。
 *
 * **两边都去尾斜杠**再比：`loadConfig` 会把尾斜杠去掉，但用户手填进
 * `config.json` 的那一份、以及从各处复制来的地址未必。只做这一种归一 ——
 * URL 的路径是大小写敏感的，折叠大小写会把 `DeepSeek/V3` 这种模型名式路径认错。
 */
export function vendorByBaseUrl(baseUrl: string): VendorPreset | undefined {
  const norm = baseUrl.replace(/\/+$/, '')
  return VENDORS.find((v) => v.baseUrl.replace(/\/+$/, '') === norm)
}
