/**
 * src/topics.js
 * ------------------------------------------------------------
 * AI Trend Detection 层：把一堆散乱帖子，变成"有名字、有摘要、有增速"的热点话题。
 *
 * 流程：
 *   1. 清洗 & 分词（英文词 + cashtag + 中文片段）
 *   2. 加权 Jaccard 相似度聚类（cashtag / 实体权重更高）
 *   3. 自动命名（从簇内高频词生成，并与已知主题词典对齐）
 *   4. 自动摘要（共识 / 分歧 / 高频标的 / 增速）
 *   5. 趋势计算（增速、速度、新鲜度、峰值时间、逐时分布）
 *
 * 说明：这里刻意使用可解释的规则聚类 + 关键词对齐，而不是黑盒 embedding，
 *      原因是：① 无需额外 API key 也能复现；② 面试时每一步都能讲清楚"为什么它算热点"。
 *      生产版可把 clusterPosts() 换成 embedding 聚类，接口不变。
 * ------------------------------------------------------------
 */
import { config } from './config.js';
import { TOPIC_SEEDS, HOUR } from './dataset.js';

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'her', 'was', 'one', 'our',
  'out', 'day', 'get', 'has', 'him', 'his', 'how', 'its', 'new', 'now', 'old', 'see', 'two', 'way',
  'who', 'boy', 'did', 'its', 'let', 'put', 'say', 'she', 'too', 'use', 'that', 'this', 'with',
  'from', 'have', 'they', 'will', 'your', 'about', 'would', 'there', 'their', 'what', 'when',
  'make', 'like', 'time', 'just', 'know', 'take', 'into', 'year', 'good', 'some', 'could',
  'them', 'than', 'then', 'only', 'come', 'over', 'also', 'back', 'after', 'most', 'even',
  'here', 'why', 'still', 'being', 'been', 'were', 'which', 'these', 'those', 'much', 'many',
  'very', 'more', 'other', 'every', 'watch', 'think', 'looks', 'look', 'feel', 'need', 'want',
  'sure', 'people', 'thing', 'going', 'going', 'read', 'note', 'out', 'check', 'quiet',
  'tape', 'story', 'thread', 'breaking', 'positioning', 'surprised', 'holds', 'matters', 'next',
  'first', 'last', 'again', 'down', 'over', 'under', 'above', 'is', 'are', 'was', 'were', 'be',
  'to', 'of', 'in', 'on', 'at', 'it', 'as', 'an', 'or', 'if', 'so', 'no', 'up', 'we', 'us',
]);

const BULL_WORDS = ['record', 'beat', 'raised', 'higher', 'up', 'ripping', 'higher', 'rally', 'rallied', 'inflow', 'improved', 'accelerating', 'momentum', 'outperformed', 'jumped', 'gapped', 'dovish', 'cheap', 'bounce'];
const BEAR_WORDS = ['bled', 'sold', 'off', 'lower', 'slipped', 'outflow', 'risk', 'ugly', 'compressed', 'fading', 'crowded', 'warned', 'surprise', 'hot', 'constraint', 'unwinding', 'deleveraging', 'pushed', 'back'];

const SHORT_TOKENS = /\b(ai|bp|ev|fx|pe|qe|yoy|mom|ipo|cpi|gdp|pmi|etf|ceo|fnb)\b/g;

export function tokenize(text) {
  const lower = ` ${text.toLowerCase()} `;
  const tokens = new Map(); // token -> weight
  for (const m of lower.matchAll(/\$[a-z]{1,6}\b/g)) tokens.set(m[0], (tokens.get(m[0]) || 0) + 2.5);
  for (const m of lower.matchAll(/[a-z][a-z\-]{2,}/g)) {
    const w = m[0];
    if (STOPWORDS.has(w)) continue;
    tokens.set(w, (tokens.get(w) || 0) + 1);
  }
  for (const m of lower.matchAll(SHORT_TOKENS)) {
    const w = m[0];
    if (STOPWORDS.has(w)) continue;
    tokens.set(w, (tokens.get(w) || 0) + 1.2);
  }
  // 百分比/数字片段（用于"可生产性"判断）
  const numbers = [...lower.matchAll(/[-+]?\d+(\.\d+)?%|\$\d+(\.\d+)?(bn|m|k)?|\d+(\.\d+)?x|\d+bp|\d{2,}k/g)].map((m) => m[0]);
  return { tokens, numbers };
}

function weightedJaccard(a, b) {
  let inter = 0;
  let union = 0;
  let sumA = 0;
  for (const [k, v] of a) {
    sumA += v;
    const bv = b.get(k) || 0;
    inter += Math.min(v, bv);
    union += Math.max(v, bv);
  }
  let sumB = 0;
  for (const [k, v] of b) {
    sumB += v;
    if (!a.has(k)) union += v;
  }
  if (!union) return 0;
  const jac = inter / union;
  // 重叠系数：看"较小的集合有多少被包含"，能有效应对长短帖差异
  const ovl = inter / Math.max(1, Math.min(sumA, sumB));
  return 0.5 * jac + 0.5 * ovl;
}

function mergeProfiles(target, src) {
  for (const [k, v] of src) target.set(k, (target.get(k) || 0) + v);
  return target;
}

/** 加权 Jaccard + 重叠系数 的混合相似度贪心聚类 */
export function clusterPosts(posts, { minSimilarity = 0.26, mergeAt = 0.3, minSize = 2 } = {}) {
  const enriched = posts.map((p) => {
    const { tokens, numbers } = tokenize(p.text);
    return { post: p, tokens, numbers };
  });

  // 互动量高的帖子优先成为簇心，更容易形成"主流叙事"
  enriched.sort((a, b) => b.post.engagement - a.post.engagement);

  let clusters = [];
  for (const item of enriched) {
    let best = null;
    let bestSim = 0;
    for (const c of clusters) {
      const sim = weightedJaccard(item.tokens, c.profile);
      if (sim > bestSim) {
        bestSim = sim;
        best = c;
      }
    }
    if (best && bestSim >= minSimilarity) {
      best.items.push(item);
      mergeProfiles(best.profile, item.tokens);
    } else {
      clusters.push({ profile: new Map(item.tokens), items: [item] });
    }
  }

  // 合并高度重叠的簇
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const sim = weightedJaccard(clusters[i].profile, clusters[j].profile);
        if (sim >= mergeAt) {
          clusters[i].items.push(...clusters[j].items);
          mergeProfiles(clusters[i].profile, clusters[j].profile);
          clusters.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }

  return clusters.filter((c) => c.items.length >= minSize);
}

function titleCase(s) {
  return s.replace(/\b[a-z]/g, (m) => m.toUpperCase());
}

/**
 * 关键词命中的统一口径：短词（≤3 字符，如 ai / bp / cpi）必须整词匹配，
 * 否则 "ai" 会命中 "again / raise / chain" 这类词，造成主题错配。
 */
export function keywordHit(text, kw) {
  if (kw.length <= 3) return new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
  return text.toLowerCase().includes(kw.toLowerCase());
}

/** 与主题词典做对齐：判断这一簇究竟在讲哪个已知主题（用于命名 + 同类合并） */
function seedAlignment(cluster) {
  let bestSeed = null;
  let bestHits = 0;
  for (const seed of TOPIC_SEEDS) {
    let hits = 0;
    for (const item of cluster.items) {
      const t = item.post.text;
      if (seed.keywords.some((k) => keywordHit(t, k))) hits += 1;
    }
    if (hits > bestHits) {
      bestHits = hits;
      bestSeed = seed;
    }
  }
  const strong = Boolean(bestSeed) && bestHits >= Math.max(2, Math.ceil(cluster.items.length * 0.45));
  return { seed: bestSeed, hits: bestHits, strong };
}

/**
 * 第二遍合并：同一主题的"碎片簇"合一。
 * 词面聚类会把同一话题的不同侧面（比如 Fed 的 dot plot 党 vs duration 党）拆成多个小簇，
 * 用主题词典对齐后把它们并回去——否则排序里会出现 5 个"Fed 热点"互相打架。
 */
function mergeBySeed(clusters) {
  const groups = new Map();
  const rest = [];
  for (const c of clusters) {
    const align = seedAlignment(c);
    c.alignment = align;
    if (align.strong) {
      const key = align.seed.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    } else {
      rest.push(c);
    }
  }
  const merged = [...rest];
  for (const [, list] of groups) {
    if (list.length === 1) {
      merged.push(list[0]);
      continue;
    }
    const base = list[0];
    for (const c of list.slice(1)) {
      base.items.push(...c.items);
      mergeProfiles(base.profile, c.profile);
    }
    merged.push(base);
  }
  return merged;
}

/** 自动命名 + 主题词典对齐 */
function nameCluster(cluster, df = new Map(), totalDocs = 1) {
  const tf = new Map();
  const docFreqInCluster = new Map();
  for (const item of cluster.items) {
    for (const [k, v] of item.tokens) {
      tf.set(k, (tf.get(k) || 0) + v);
      docFreqInCluster.set(k, (docFreqInCluster.get(k) || 0) + 1);
    }
  }

  // IDF 加权：在整个语料里到处都是的词（desk / chatter）没有区分度，直接压下去；
  // 只在少数帖子里反复出现的词（fed / cpi / stablecoin）才是这一簇的"名字"。
  const scored = [...tf.entries()]
    .filter(([k]) => (docFreqInCluster.get(k) || 0) >= 2 && !k.startsWith('$'))
    .map(([k, v]) => {
      const dfAll = df.get(k) || 1;
      const idf = Math.log(1 + totalDocs / dfAll);
      const clusterTf = docFreqInCluster.get(k) || 1;
      return { token: k, score: v * idf * Math.sqrt(clusterTf) };
    })
    .sort((a, b) => b.score - a.score);

  const topTokens = scored.slice(0, 6).map((s) => s.token);

  const align = cluster.alignment || seedAlignment(cluster);
  const strong = align.strong;
  const bestSeed = align.seed;

  // cashtag 从原文提取（保留大小写）
  const cashtags = [
    ...new Set(cluster.items.flatMap((i) => (i.post.text.match(/\$[A-Za-z]{1,6}\b/g) || []).map((s) => s.toUpperCase()))),
  ].slice(0, 4);
  const name = strong
    ? bestSeed.autoLabel
    : topTokens.slice(0, 3).map(titleCase).join(' / ');

  return {
    name,
    topTokens,
    cashtags,
    seed: strong ? bestSeed : align.hits > 0 ? bestSeed : null,
    strongMatch: strong,
  };
}

/** 计算话题的趋势指标 */
function computeTrend(cluster, posts, windowHours, now) {
  const from = now - windowHours * HOUR;
  const mid = from + (windowHours * HOUR) / 2;
  const recentFrom = now - (windowHours * HOUR) / 4;

  const list = cluster.items.map((i) => i.post).sort((a, b) => a.createdAt - b.createdAt);
  const earlier = list.filter((p) => p.createdAt < mid);
  const later = list.filter((p) => p.createdAt >= mid);
  const recent = list.filter((p) => p.createdAt >= recentFrom);

  /**
   * 双口径趋势量化（两条口径互补，缺一不可）：
   *   A. growth   窗口对半切，比较"前半 vs 后半"的每小时速率 → 看趋势**形状**（在升温还是在衰减）
   *   B. momentum 最近短窗 vs 整窗平均基线 → 看"**现在**是不是正在爆"
   * 只有 A 会把"一直很热但已到平台期"的话题判成 0 增速；只有 B 会把"早期小样本抖动"误判成爆发。
   * 两者都高才是真正的"正在爆"，因此额外给一个 surging 标记。
   */
  const shortHours = Math.max(1, Math.min(windowHours, windowHours / 8));
  const shortFrom = now - shortHours * HOUR;
  const shortWindow = list.filter((p) => p.createdAt >= shortFrom);

  const half = (windowHours * HOUR) / 2 / HOUR;
  const earlierRate = earlier.length / half;
  const laterRate = later.length / half;
  const growth = earlierRate > 0 ? (laterRate - earlierRate) / earlierRate : laterRate > 0 ? 1 : 0;

  // 口径 B：短窗 vs 长基线
  const baselineRate = list.length / windowHours; // 帖/小时（整窗均值）
  const shortRate = shortWindow.length / shortHours; // 帖/小时（最近短窗）
  const momentum = baselineRate > 0 ? shortRate / baselineRate - 1 : shortRate > 0 ? 1 : 0;
  const momentumRatio = baselineRate > 0 ? shortRate / baselineRate : shortRate > 0 ? 2 : 0;

  const recentEngagement = recent.reduce((s, p) => s + p.engagement, 0);
  const velocity = recentEngagement / Math.max(1, (windowHours * HOUR) / 4 / HOUR); // 近 1/4 窗口的每小时互动量

  const freshness = recent.length / list.length; // 近 1/4 窗口的发帖占比

  const accounts = [...new Set(list.map((p) => p.account))];

  // 逐时分布（用于 UI 迷你走势图 & 峰值检测）
  const buckets = Math.min(48, Math.max(12, Math.round(windowHours)));
  const bucketMs = (windowHours * HOUR) / buckets;
  const hist = new Array(buckets).fill(0);
  for (const p of list) {
    const idx = Math.min(buckets - 1, Math.max(0, Math.floor((p.createdAt - from) / bucketMs)));
    hist[idx] += 1;
  }
  let peakIdx = 0;
  hist.forEach((v, i) => {
    if (v > hist[peakIdx]) peakIdx = i;
  });
  const peakAt = from + (peakIdx + 0.5) * bucketMs;

  // 情绪结构：分歧越大 => 内容可生产性越高（有得吵才有点击）
  let bull = 0;
  let bear = 0;
  for (const p of list) {
    const t = p.text.toLowerCase();
    if (BULL_WORDS.some((w) => t.includes(w))) bull += 1;
    if (BEAR_WORDS.some((w) => t.includes(w))) bear += 1;
  }
  const tagged = Math.max(1, bull + bear);
  const bullShare = bull / tagged;
  const conflict = 1 - Math.abs(bullShare - 0.5) * 2;

  // 数字密度：带数据的讨论更容易做成"干货科普"内容
  const numberDensity = cluster.items.filter((i) => i.numbers.length > 0).length / list.length;

  // TelyClaw 相关性
  const kwHits = list.filter((p) => config.relevanceKeywords.some((k) => keywordHit(p.text, k))).length;
  const relevance = Math.min(1, kwHits / Math.max(1, list.length) / 1.2);

  const engagement = list.reduce((s, p) => s + p.engagement, 0);
  const accountDiversity = accounts.length / list.length;

  const contentOpportunity = Math.min(
    1,
    0.42 * numberDensity + 0.28 * Math.min(1, accountDiversity * 2.2) + 0.3 * conflict
  );

  return {
    postCount: list.length,
    accountCount: accounts.length,
    accounts,
    engagement,
    engagementPerHour: engagement / Math.max(1, windowHours),
    velocity,
    growth,
    growing: growth > 0.05,
    rising: growth > 0.2,
    // 口径 B 与综合判定
    momentum,
    momentumRatio,
    shortHours,
    shortPostCount: shortWindow.length,
    shortRate,
    baselineRate,
    surging: growth > 0.2 && momentum > 0.5,
    freshness,
    relevance,
    numberDensity,
    conflict,
    tone: {
      bullish: Math.round((bull / tagged) * 100),
      bearish: Math.round((bear / tagged) * 100),
      neutral: Math.round((1 - (bull + bear) / Math.max(1, list.length * 2)) * 100),
    },
    hist,
    peakAt,
    firstPostAt: list[0]?.createdAt ?? from,
    lastPostAt: list[list.length - 1]?.createdAt ?? now,
    contentOpportunity,
  };
}

function buildSummary({ name, trend, meta }) {
  const growthText =
    trend.growth > 0.05
      ? `上升 ${(trend.growth * 100).toFixed(0)}%（加速中）`
      : trend.growth < -0.05
        ? `回落 ${Math.abs(trend.growth * 100).toFixed(0)}%（热度衰减）`
        : '基本持平';
  // 口径 B：最近短窗相对整窗基线的放大倍数，用来区分"一直很热"和"刚刚开始爆"
  const momentumText =
    trend.momentumRatio >= 1.15
      ? `，最近 ${trend.shortHours.toFixed(1)} 小时发帖速率是窗口均值的 ${trend.momentumRatio.toFixed(1)} 倍${
          trend.surging ? '（正在爆发）' : ''
        }`
      : trend.momentumRatio > 0 && trend.momentumRatio <= 0.85
        ? `，最近 ${trend.shortHours.toFixed(1)} 小时发帖速率已降到窗口均值的 ${trend.momentumRatio.toFixed(1)} 倍（动能减弱）`
        : '';
  const consensus = meta?.seed?.consensus || `围绕「${name}」的讨论在窗口内持续出现，尚未形成统一结论`;
  const debate = meta?.seed?.debate || '多空双方对持续性存在分歧，需观察后续数据兑现';
  const tags = meta.cashtags.length ? meta.cashtags.join('、') : '（暂无高频标的）';
  return (
    `${trend.accountCount} 个账号在窗口内围绕「${name}」发布 ${trend.postCount} 条内容，` +
    `合计互动 ${trend.engagement.toLocaleString()}，讨论量环比${growthText}${momentumText}。` +
    `市场共识：${consensus}。主要分歧：${debate}。高频标的：${tags}。` +
    `情绪结构：偏多 ${trend.tone.bullish}% / 偏空 ${trend.tone.bearish}%。`
  );
}

/**
 * 主入口：帖子 -> 热点话题列表
 */
export function detectTopics(posts, { windowHours, now = Date.now() } = {}) {
  // 短窗口内样本天然稀疏：放宽聚类阈值，否则会把同一话题拆成一堆 1-2 条的小簇
  const clusterOpts = windowHours <= 6 ? { minSimilarity: 0.22, mergeAt: 0.26, minSize: 2 } : {};
  const minTopicSize = windowHours <= 6 ? 2 : 3;
  const rawClusters = clusterPosts(posts, clusterOpts);
  const clusters = mergeBySeed(rawClusters).filter((c) => c.items.length >= minTopicSize);

  // 语料级词频（用于 IDF，让命名更"有区分度"）
  const df = new Map();
  for (const p of posts) {
    const { tokens } = tokenize(p.text);
    for (const k of tokens.keys()) df.set(k, (df.get(k) || 0) + 1);
  }

  const topics = clusters.map((c, idx) => {
    const meta = nameCluster(c, df, posts.length);
    const trend = computeTrend(c, posts, windowHours, now);
    const sample = c.items
      .map((i) => i.post)
      .sort((a, b) => b.engagement - a.engagement)
      .slice(0, 6);
    const key = meta.seed?.id || `cluster-${meta.topTokens.slice(0, 3).join('-')}`;
    return {
      key,
      name: meta.name,
      keywords: meta.topTokens,
      cashtags: meta.cashtags,
      strongMatch: meta.strongMatch,
      summary: buildSummary({ name: meta.name, trend, meta }),
      ...trend,
      samplePosts: sample,
      clusterIndex: idx,
    };
  });

  topics.sort((a, b) => b.postCount - a.postCount || b.engagement - a.engagement);
  return topics;
}
