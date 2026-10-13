/**
 * src/ingest.js
 * ------------------------------------------------------------
 * 数据源适配层（Data Source Adapter）
 *
 * 统一输出 Post 结构：
 *   { id, account, accountName, category, text, createdAt, likes, replies, reposts, quotes, engagement, url }
 *
 * 两个实现：
 *   1) simulated —— 内置仿真数据（默认，开箱即用，接口形状与真实数据完全一致）
 *   2) x_api     —— 真实 X API v2 recent search（需要 X_BEARER_TOKEN，受 Rate Limit 与付费档位限制）
 *
 * 只要实现 fetchPosts(handles, windowHours)，上层流水线完全不需要知道数据来自哪里。
 * ------------------------------------------------------------
 */
import { config } from './config.js';
import { fetchSimulatedPosts, HOUR, ACCOUNTS } from './dataset.js';

function normalizeMetrics(pub = {}) {
  const likes = pub.public_metrics?.like_count ?? pub.like_count ?? 0;
  const replies = pub.public_metrics?.reply_count ?? pub.reply_count ?? 0;
  const reposts = pub.public_metrics?.retweet_count ?? pub.retweet_count ?? 0;
  const quotes = pub.public_metrics?.quote_count ?? pub.quote_count ?? 0;
  return {
    likes,
    replies,
    reposts,
    quotes,
    engagement: likes + 2 * reposts + 3 * replies + 2 * quotes,
  };
}

/** 真实 X API v2（需要 bear token；MVP 默认不启用） */
async function fetchFromXApi(handles, windowHours) {
  if (!config.xBearerToken) {
    throw new Error('未配置 X_BEARER_TOKEN，无法使用真实 X API。请在 .env 中填写，或切回 simulated 模式。');
  }
  const userIds = [];
  for (const handle of handles) {
    const u = await fetch(`https://api.x.com/2/users/by/username/${handle.replace('@', '')}`, {
      headers: { Authorization: `Bearer ${config.xBearerToken}` },
    });
    if (!u.ok) continue;
    const j = await u.json();
    if (j?.data?.id) userIds.push({ handle, id: j.data.id, name: j.data.name });
  }
  if (!userIds.length) throw new Error('X API 未返回任何可用账号，请检查 handle 或 token 权限。');

  const startTime = new Date(Date.now() - windowHours * HOUR).toISOString();
  const posts = [];
  for (const u of userIds) {
    const url =
      `https://api.x.com/2/users/${u.id}/tweets?max_results=100&start_time=${encodeURIComponent(startTime)}` +
      `&tweet.fields=created_at,public_metrics,lang`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${config.xBearerToken}` } });
    if (!r.ok) continue;
    const j = await r.json();
    for (const t of j.data || []) {
      posts.push({
        id: t.id,
        account: u.handle,
        accountName: u.name || u.handle,
        category: 'X API',
        text: t.text,
        createdAt: new Date(t.created_at).getTime(),
        ...normalizeMetrics(t),
        url: `https://x.com/${u.handle.replace('@', '')}/status/${t.id}`,
      });
    }
  }
  return posts;
}

/**
 * 统一入口
 * @param {{handles: string[], windowHours: number, source?: 'simulated'|'x_api'}} opts
 */
export async function ingest(opts) {
  const source = opts.source || config.dataSource;
  const handles = (opts.handles || []).length
    ? opts.handles
    : ACCOUNTS.map((a) => a.handle);

  if (source === 'x_api') {
    const posts = await fetchFromXApi(handles, opts.windowHours);
    return { source, posts, warnings: [] };
  }

  const warnings = [];
  const posts = fetchSimulatedPosts(opts.windowHours).filter((p) => handles.includes(p.account));
  if (!posts.length) warnings.push(`${windowHours} 小时窗口内没有抓取到帖子，请换更大的时间窗口。`);
  return { source: 'simulated', posts, warnings };
}
