/**
 * src/config.js
 * 极简配置层：读取 .env（零依赖手写解析）+ 运行时可变配置（可由前端设置页修改）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const PUBLIC_DIR = path.join(ROOT, 'public');

function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  const out = {};
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return out;
}

const fileEnv = loadEnv();
const env = (k, d) => process.env[k] ?? fileEnv[k] ?? d;

export const config = {
  port: Number(env('PORT', 5173)),

  // 数据源：simulated | x_api
  dataSource: env('DATA_SOURCE', 'simulated'),
  xBearerToken: env('X_BEARER_TOKEN', ''),

  // 内容生成：mock | openai
  llmMode: env('LLM_MODE', 'mock'),
  llmBaseUrl: env('LLM_BASE_URL', 'https://api.openai.com/v1'),
  llmApiKey: env('LLM_API_KEY', ''),
  llmModel: env('LLM_MODEL', 'gpt-4o-mini'),

  /**
   * Opportunity Score 权重（可在设置页调整，体现"自己定义机会分数"）
   * 三类因子：
   *   A. 话题动能：momentum / velocity / engagement / accounts
   *   B. 时效与匹配：freshness / relevance
   *   C. 可生产性：contentOpportunity
   */
  weights: {
    momentum: 0.18,
    velocity: 0.22,
    engagement: 0.16,
    accounts: 0.12,
    freshness: 0.08,
    relevance: 0.14,
    contentOpportunity: 0.1,
  },

  /**
   * 排期监控（Scheduled Monitoring，Bonus 项）
   * 定时自动跑"抓取 → 识别 → 排序"，只在发现"新高分机会"时推送提醒。
   */
  scheduler: {
    enabled: false,
    intervalMinutes: 30,   // 轮询间隔
    window: '4H',          // 每次轮询使用的时间窗口（近实时用短窗口）
    alertScore: 55,        // 机会分数阈值：达到即视为"值得跟进的机会"
    quietHours: [23, 7],   // 静默时段（本地时间，[起, 止)），期间不打扰
    quietOverrideScore: 80,// 静默时段内分数仍达到该值 → 例外放行（真正的爆点）
    dedupeHours: 6,        // 同一话题在多少小时内不重复提醒
    maxAlerts: 50,
  },

  // TelyClaw 相关性词典：与产品（AI-native 内容增长引擎）及目标受众的匹配度
  relevanceKeywords: [
    'ai', 'agent', 'agents', 'llm', 'automation', 'workflow', 'model', 'copilot',
    'content', 'creator', 'research', 'analysis', 'analyst', 'data', 'tool',
    'coding', 'codex', 'claude', 'gpt', 'datacenter', 'compute', 'inference',
    '量化', '内容', '效率',
  ],
};

/**
 * 审核工作流的角色模型（对齐成熟社媒工具"工作区 + 权限"的做法）。
 * 关键设计：作者 / 审核人 / 发布人分离，避免"自己写自己批自己发"。
 */
export const ROLES = {
  editor: { key: 'editor', label: '内容编辑', can: ['edit', 'generate', 'assign'] },
  reviewer: { key: 'reviewer', label: '审核人', can: ['edit', 'approve', 'reject', 'assign'] },
  publisher: { key: 'publisher', label: '发布人', can: ['publish'] },
  admin: { key: 'admin', label: '管理员', can: ['edit', 'generate', 'approve', 'reject', 'publish', 'assign'] },
};

export const DEFAULT_MEMBERS = [
  { id: 'u-alice', name: 'Alice', role: 'editor' },
  { id: 'u-bob', name: 'Bob', role: 'reviewer' },
  { id: 'u-carol', name: 'Carol', role: 'publisher' },
  { id: 'u-dave', name: 'Dave', role: 'admin' },
];

export function can(roleKey, action) {
  const role = ROLES[roleKey];
  return Boolean(role && role.can.includes(action));
}

export function publicConfig() {
  return {
    dataSource: config.dataSource,
    llmMode: config.llmMode,
    llmModel: config.llmModel,
    hasXToken: Boolean(config.xBearerToken),
    hasLlmKey: Boolean(config.llmApiKey),
    weights: config.weights,
    relevanceKeywords: config.relevanceKeywords,
    scheduler: config.scheduler,
    roles: Object.values(ROLES).map((r) => ({ key: r.key, label: r.label, can: r.can })),
  };
}

export function applyRuntimeConfig(patch = {}) {
  for (const k of ['dataSource', 'llmMode']) {
    if (patch[k]) config[k] = patch[k];
  }
  if (patch.weights && typeof patch.weights === 'object') {
    for (const [k, v] of Object.entries(patch.weights)) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) config.weights[k] = n;
    }
  }
  if (patch.scheduler && typeof patch.scheduler === 'object') {
    const sc = config.scheduler;
    if (typeof patch.scheduler.enabled === 'boolean') sc.enabled = patch.scheduler.enabled;
    for (const k of ['intervalMinutes', 'alertScore', 'quietOverrideScore', 'dedupeHours', 'maxAlerts']) {
      const n = Number(patch.scheduler[k]);
      if (Number.isFinite(n) && n > 0) sc[k] = n;
    }
    if (typeof patch.scheduler.window === 'string') sc.window = patch.scheduler.window;
    if (Array.isArray(patch.scheduler.quietHours) && patch.scheduler.quietHours.length === 2) {
      const [a, b] = patch.scheduler.quietHours.map(Number);
      if (Number.isFinite(a) && Number.isFinite(b)) sc.quietHours = [a, b];
    }
  }
  return publicConfig();
}
