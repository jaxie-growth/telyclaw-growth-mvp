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
   *   A. 话题动能：velocity / engagement / accounts
   *   B. 时效与匹配：freshness / relevance
   *   C. 可生产性：contentOpportunity
   */
  weights: {
    velocity: 0.3,
    engagement: 0.2,
    accounts: 0.15,
    freshness: 0.1,
    relevance: 0.15,
    contentOpportunity: 0.1,
  },

  // TelyClaw 相关性词典：与产品（AI-native 内容增长引擎）及目标受众的匹配度
  relevanceKeywords: [
    'ai', 'agent', 'agents', 'llm', 'automation', 'workflow', 'model', 'copilot',
    'content', 'creator', 'research', 'analysis', 'analyst', 'data', 'tool',
    'coding', 'codex', 'claude', 'gpt', 'datacenter', 'compute', 'inference',
    '量化', '内容', '效率',
  ],
};

export function publicConfig() {
  return {
    dataSource: config.dataSource,
    llmMode: config.llmMode,
    llmModel: config.llmModel,
    hasXToken: Boolean(config.xBearerToken),
    hasLlmKey: Boolean(config.llmApiKey),
    weights: config.weights,
    relevanceKeywords: config.relevanceKeywords,
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
  return publicConfig();
}
