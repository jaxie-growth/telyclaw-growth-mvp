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
};

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

let state = null;

export function loadState() {
  ensureDir();
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
  ensureDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

export function resetState({ keepAccounts = true } = {}) {
  const accounts = keepAccounts ? loadState().accounts : [];
  state = structuredClone(DEFAULT_STATE);
  state.accounts = accounts;
  saveState();
  return state;
}

export function savePostsSnapshot(posts) {
  ensureDir();
  fs.writeFileSync(POSTS_FILE, JSON.stringify(posts, null, 2), 'utf8');
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
