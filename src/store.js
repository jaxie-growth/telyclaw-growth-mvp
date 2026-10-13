/**
 * src/store.js
 * JSON 文件持久化（零依赖）。生产环境可换成 Postgres/Supabase，接口保持不变。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const STATE_FILE = path.join(DATA_DIR, 'state.json');
const POSTS_FILE = path.join(DATA_DIR, 'posts.json');

const DEFAULT_STATE = {
  accounts: [],        // 监控账号
  posts: [],           // 最近一次抓取的帖子快照
  lastIngestAt: null,
  lastWindow: '24H',
  topics: [],          // 最近一次热点识别的结果
  analysis: null,      // { window, hours, generatedAt, topics, opportunities }
  drafts: [],          // 生成的内容草稿（含审核状态）
  published: [],       // 已发布内容
  events: [],          // 审核/发布等操作日志
  detection: {},       // topicKey -> 首次被检测到的时间（用于计算 Detection Lead Time）
  publishedTopicSnapshots: {}, // draftId -> 发布时该话题的帖子量（用于计算 Trend Hit Rate）
  scoreHistory: [],    // 每次 analyze 的 Top 话题分数快照（用于看板）
  alerts: [],          // 排期监控推送的"新高分机会"提醒（带去重）
  members: [],         // 工作区成员与角色（作者/审核人/发布人分离）
  actorId: null,       // 当前操作身份（前端可切换，服务端据此做权限校验）
  scheduler: null,     // 排期监控运行状态（lastTickAt / tickCount / lastError）
};

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * 容错写入：某些部署环境（如只读容器/沙箱）不允许写盘。
 * 此时降级为"内存模式"——服务继续可用，只是重启后数据不保留，
 * 避免整个 API 因一次写盘失败而 500。
 */
let writeWarned = false;
function safeWrite(file, data) {
  try {
    ensureDir();
    fs.writeFileSync(file, data, 'utf8');
    return true;
  } catch (err) {
    if (!writeWarned) {
      writeWarned = true;
      console.warn(
        `[store] 持久化失败，已降级为内存模式（重启后数据不保留）：${err.message}`,
      );
    }
    return false;
  }
}

let state = null;

export function loadState() {
  try {
    ensureDir();
  } catch {
    /* 目录不可创建时忽略，后续写入会自动降级 */
  }
  if (state) return state;
  if (fs.existsSync(STATE_FILE)) {
    try {
      state = { ...structuredClone(DEFAULT_STATE), ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
    } catch {
      state = structuredClone(DEFAULT_STATE);
    }
  } else {
    state = structuredClone(DEFAULT_STATE);
  }
  return state;
}

export function saveState() {
  safeWrite(STATE_FILE, JSON.stringify(state, null, 2));
}

export function resetState({ keepAccounts = true } = {}) {
  const prev = loadState();
  // 账号、成员、当前身份属于"配置"，重置分析结果时保留
  const accounts = keepAccounts ? prev.accounts : [];
  const members = prev.members || [];
  const actorId = prev.actorId ?? null;
  state = structuredClone(DEFAULT_STATE);
  state.accounts = accounts;
  state.members = members;
  state.actorId = actorId;
  saveState();
  return state;
}

export function savePostsSnapshot(posts) {
  safeWrite(POSTS_FILE, JSON.stringify(posts, null, 2));
}

let idSeq = 0;
export function nextId(prefix = 'id') {
  idSeq += 1;
  return `${prefix}-${Date.now().toString(36)}${idSeq.toString(36)}`;
}

export function logEvent(type, detail = {}) {
  const s = loadState();
  s.events.unshift({ id: nextId('evt'), type, detail, at: Date.now() });
  s.events = s.events.slice(0, 400);
}
