/**
 * src/pipeline.js
 * ------------------------------------------------------------
 * 流水线编排层：把 ingest → detect → rank 串成一条可复用的链路。
 *
 * 为什么要单独抽出来：
 *   同一条链路有两个触发源 —— ① 用户点按钮（/api/*）；② 排期监控定时轮询（scheduler）。
 *   把它们写成同一个函数，保证"手动跑"和"自动跑"结果口径完全一致，
 *   否则很容易出现"定时任务算的分数和界面上的不一样"这种经典问题。
 * ------------------------------------------------------------
 */
import { config } from './config.js';
import { loadState, saveState, logEvent, savePostsSnapshot } from './store.js';
import { ingest } from './ingest.js';
import { detectTopics } from './topics.js';
import { rankOpportunities } from './ranking.js';
import { WINDOWS, HOUR } from './dataset.js';

export function windowHoursOf(label) {
  if (typeof label === 'number') return label;
  return WINDOWS[label] || 24;
}

/** 逐时分布（用于前端迷你走势图与抓取结果回执） */
export function hourlyHistogram(posts, hours) {
  const now = Date.now();
  const buckets = Math.min(48, Math.max(12, Math.round(hours)));
  const ms = (hours * HOUR) / buckets;
  const hist = new Array(buckets).fill(0);
  for (const p of posts) {
    const idx = Math.min(buckets - 1, Math.max(0, Math.floor((p.createdAt - (now - hours * HOUR)) / ms)));
    hist[idx] += 1;
  }
  return hist;
}

/** 抓取：把外部世界变成统一 Post 结构，落盘快照 */
export async function runIngest({ window: win, source } = {}) {
  const s = loadState();
  if (win) s.lastWindow = String(win);
  const hours = windowHoursOf(s.lastWindow);
  const handles = s.accounts.filter((a) => a.enabled).map((a) => a.handle);
  const { posts, source: used, warnings } = await ingest({ handles, windowHours: hours, source });

  s.posts = posts;
  s.lastIngestAt = Date.now();
  s.ingestSource = used;
  savePostsSnapshot(posts);
  logEvent('ingest', { window: s.lastWindow, posts: posts.length, source: used });
  saveState();

  return {
    source: used,
    window: s.lastWindow,
    postCount: posts.length,
    accounts: handles.length,
    warnings,
    hourly: hourlyHistogram(posts, hours),
  };
}

/**
 * 识别 + 排序。
 * 同步维护两个"跨次运行"的状态：
 *   - detection[topicKey]：话题**首次**被检测到的时间（用于算检测时效）
 *   - scoreHistory：每次的 Top1 分数（用于看板看排序质量变化）
 */
export function runAnalyze({ window: win, now = Date.now(), trigger = 'manual' } = {}) {
  const s = loadState();
  if (win) s.lastWindow = String(win);
  const hours = windowHoursOf(s.lastWindow);
  const cutoff = now - hours * HOUR;
  const posts = s.posts.filter((x) => x.createdAt >= cutoff);

  const topics = detectTopics(posts, { windowHours: hours, now });
  const ranked = rankOpportunities(topics, { limit: 8 });

  for (const t of ranked.all || []) {
    if (!s.detection[t.key]) s.detection[t.key] = now;
  }
  s.scoreHistory = [
    { at: now, top: (ranked.opportunities[0] || {}).score || 0, topics: topics.length, trigger },
    ...(s.scoreHistory || []),
  ].slice(0, 30);

  s.analysis = {
    window: s.lastWindow,
    hours,
    generatedAt: now,
    postCount: posts.length,
    topics: ranked.all || [],
    trigger,
  };
  s.topics = ranked.all || [];
  logEvent('analyze', { window: s.lastWindow, topics: topics.length, posts: posts.length, trigger });
  saveState();

  return {
    window: s.lastWindow,
    hours,
    postCount: posts.length,
    topicCount: ranked.all.length,
    top: ranked.opportunities[0] || null,
    opportunities: ranked.opportunities,
  };
}

/** 完整链路：抓取 → 识别 → 排序（排期监控与"一键流水线"共用） */
export async function runFull({ window: win, trigger = 'manual' } = {}) {
  const ing = await runIngest({ window: win });
  const an = runAnalyze({ window: win, trigger });
  return { ingest: ing, analyze: an };
}
