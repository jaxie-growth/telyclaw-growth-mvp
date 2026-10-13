/**
 * src/metrics.js
 * ------------------------------------------------------------
 * 指标层：North Star Metric + Supporting Metrics
 *
 * North Star：Qualified Engagement Generated from Trends
 *   = 由热点产出的内容，带来的"高质量互动"总和
 *   高质量 = 互动 × ICP 匹配度（TelyClaw 受众：AI-native 创业者/开发者/量化研究者/财经内容创作者）
 *
 * Supporting：
 *   - Trend Detection Lead Time  热点检测提前量 = 话题峰值时间 - 首次被系统检测到的时间
 *   - Content Volume             内容产出量（按状态拆分）
 *   - Trend Hit Rate             发布后仍在升温的话题占比（= 没有追到"已经死了的热点"）
 *   - Content Acceptance Rate    人工审核通过率（衡量 AI 草稿的可用度）
 *   - Engagement Lift            已发布内容的预估互动 vs 全量草稿基线
 *
 * ⚠️ 免责：当数据源为 simulated 时，本页所有数字均为"基于仿真数据的估算"，
 *        用于验证指标口径与产品闭环，不代表真实 X 表现。
 * ------------------------------------------------------------
 */
import { HOUR } from './dataset.js';
import { loadState } from './store.js';

export function computeMetrics({ dataSource = 'simulated' } = {}) {
  const s = loadState();
  const drafts = s.drafts || [];
  const published = s.published || [];

  const byStatus = drafts.reduce((acc, d) => {
    acc[d.status] = (acc[d.status] || 0) + 1;
    return acc;
  }, {});

  const reviewed = drafts.filter((d) => ['approved', 'published', 'rejected'].includes(d.status));
  const accepted = drafts.filter((d) => ['approved', 'published'].includes(d.status));
  const acceptanceRate = reviewed.length ? accepted.length / reviewed.length : null;

  const publishedWithPred = published.map((p) => {
    const d = drafts.find((x) => x.id === p.draftId) || p;
    return { ...p, predicted: d.predicted || p.predicted };
  });

  const northStar = publishedWithPred.reduce((sum, p) => sum + (p.predicted?.qualifiedEngagement || 0), 0);
  const totalEngagement = publishedWithPred.reduce((sum, p) => sum + (p.predicted?.engagement || 0), 0);
  const totalImpressions = publishedWithPred.reduce((sum, p) => sum + (p.predicted?.impressions || 0), 0);

  // 基线：所有草稿的预估互动均值（代表"不追热点、随机发"的近似基准）
  const allPred = drafts.map((d) => d.predicted?.engagement || 0).filter((v) => v > 0);
  const baseline = allPred.length ? allPred.reduce((a, b) => a + b, 0) / allPred.length : 0;
  const publishedAvg = publishedWithPred.length ? totalEngagement / publishedWithPred.length : 0;
  const engagementLift = baseline ? publishedAvg / baseline - 1 : null;

  // 发布后话题是否仍在升温（命中）—— 追热点最怕追到"已经死了的热点"
  const snapshots = s.publishedTopicSnapshots || {};
  const currentTopics = s.analysis?.topics || [];
  let hit = 0;
  let checked = 0;
  for (const p of published) {
    const snap = snapshots[p.draftId];
    if (!snap) continue;
    checked += 1;
    const now = currentTopics.find((t) => t.key === snap.topicKey);
    if (now && (now.postCount > snap.postCount || now.rising)) hit += 1;
  }
  const trendHitRate = checked ? hit / checked : null;

  // 检测时效：
  //   detectionLagHours   —— 话题首帖出现 → 被系统首次检测到，平均用了多久（越小越好）
  //   leadBeforePeakHours —— 首次检测时，距离话题峰值还有多久（>0 = 提前发现，<0 = 滞后于峰值）
  //   earlyCatchRate      —— 提前于峰值发现的话题占比
  const detection = s.detection || {};
  const lags = [];
  const leads = [];
  for (const t of currentTopics) {
    const first = detection[t.key];
    if (!first) continue;
    lags.push((first - t.firstPostAt) / HOUR);
    leads.push((t.peakAt - first) / HOUR);
  }
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const detectionLagHours = avg(lags);
  const leadBeforePeakHours = avg(leads);
  const earlyCatchRate = leads.length ? leads.filter((v) => v > 0).length / leads.length : null;

  const angleMix = publishedWithPred.reduce((acc, p) => {
    const k = p.angleLabel || p.angle || 'unknown';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});

  // 评分趋势：最近 6 次 analyze 的 Top1 分数
  const scoreHistory = (s.scoreHistory || []).slice(0, 12).reverse();

  return {
    dataSource,
    disclaimer:
      dataSource === 'simulated'
        ? '数据源为仿真数据集，以下指标用于验证口径与闭环，不代表真实 X 表现。切换为 X API 后同一套口径直接生效。'
        : '数据源为真实 X API。',
    northStar: {
      value: northStar,
      impressions: totalImpressions,
      engagement: totalEngagement,
      publishedCount: published.length,
      definition: 'Qualified Engagement Generated from Trends = 由热点内容带来的互动 × ICP 匹配度',
    },
    supporting: {
      detectionLagHours,
      leadBeforePeakHours,
      earlyCatchRate,
      contentVolume: { total: drafts.length, byStatus },
      trendHitRate,
      contentAcceptanceRate: acceptanceRate,
      engagementLift,
      angleMix,
    },
    funnel: {
      topicsDetected: currentTopics.length,
      draftsGenerated: drafts.length,
      draftsApproved: accepted.length,
      published: published.length,
    },
    scoreHistory,
    recentEvents: (s.events || []).slice(0, 20),
  };
}
