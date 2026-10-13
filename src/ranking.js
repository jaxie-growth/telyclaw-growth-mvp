/**
 * src/ranking.js
 * ------------------------------------------------------------
 * Trend Opportunity Ranking：讨论多 ≠ 值得 TelyClaw 跟进。
 *
 * Opportunity Score（0-100）= 7 个可解释因子的加权和：
 *   动能类
 *     momentum           短窗 vs 长基线的放大倍数（"现在是不是正在爆"——区分"一直很热"与"刚刚起爆"）
 *     velocity           近 1/4 窗口的每小时互动量（热度"现在有多快"）
 *     engagement         窗口内总互动量（"盘子有多大"）
 *     accounts           独立账号数（"是不是多个来源在说"——单账号刷屏不算趋势）
 *   时效与匹配类
 *     freshness          近 1/4 窗口发帖占比（"是不是正在发生"）
 *     relevance          与 TelyClaw 产品/受众的匹配度（"是不是我们该说的"）
 *   可生产类
 *     contentOpportunity 数字密度 + 账号多样性 + 多空分歧（"能不能写出有信息量且有点击的内容"）
 *
 * 权重可在设置页调整；每个因子都会输出归一化分值 + 中文理由，做到"为什么它排第一"可解释。
 * ------------------------------------------------------------
 */
import { config } from './config.js';

const FACTOR_META = {
  momentum: { label: '爆发动能', desc: '最近短窗的发帖速率相对整窗基线的放大倍数（>1 表示正在起爆）' },
  velocity: { label: '热度增速', desc: '近 1/4 时间窗口的每小时互动量' },
  engagement: { label: '互动规模', desc: '窗口内总互动量（赞+转+评加权）' },
  accounts: { label: '参与账号数', desc: '独立账号数，避免单账号自嗨被误判为趋势' },
  freshness: { label: '时效性', desc: '近 1/4 窗口内的发帖占比' },
  relevance: { label: 'TelyClaw 相关性', desc: '与产品叙事及目标受众的匹配度' },
  contentOpportunity: { label: '内容可生产性', desc: '数据密度、账号多样性、多空分歧' },
};

const RAW_GETTER = {
  momentum: (t) => t.momentum,
  velocity: (t) => t.velocity,
  engagement: (t) => t.engagement,
  accounts: (t) => t.accountCount,
  freshness: (t) => t.freshness,
  relevance: (t) => t.relevance,
  contentOpportunity: (t) => t.contentOpportunity,
};

function minMax(values) {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return (v) => (hi === lo ? (hi > 0 ? 0.7 : 0) : (v - lo) / (hi - lo)); // 全部相等时给中性偏高值
}

function fmt(v, digits = 2) {
  return Number.isFinite(v) ? v.toFixed(digits) : '0';
}

function humanizeHours(h) {
  if (h < 1) return `${Math.round(h * 60)} 分钟`;
  if (h < 48) return `${h.toFixed(1)} 小时`;
  return `${(h / 24).toFixed(1)} 天`;
}

export function rankOpportunities(topics, { limit = 8, weights } = {}) {
  const w = { ...config.weights, ...(weights || {}) };
  if (!topics.length) return { opportunities: [], factorMeta: FACTOR_META, weights: w };

  const norm = {};
  for (const key of Object.keys(RAW_GETTER)) {
    norm[key] = minMax(topics.map(RAW_GETTER[key]));
  }

  const scored = topics.map((t) => {
    const factors = {};
    let total = 0;
    const weightSum = Object.values(w).reduce((s, v) => s + v, 0) || 1;
    for (const key of Object.keys(RAW_GETTER)) {
      const n = norm[key](RAW_GETTER[key](t));
      factors[key] = {
        raw: RAW_GETTER[key](t),
        normalized: Number(n.toFixed(3)),
        weight: w[key] / weightSum,
        contribution: Number(((n * w[key]) / weightSum * 100).toFixed(1)),
        ...FACTOR_META[key],
      };
      total += (n * w[key]) / weightSum;
    }
    const score = Number((total * 100).toFixed(1));

    const reasons = [];
    reasons.push(
      `热度：近 1/4 窗口每小时 ${fmt(t.velocity, 1)} 次互动（总互动 ${t.engagement.toLocaleString()}）`
    );
    // 双口径之一：短窗 vs 长基线（区分"一直很热"与"刚刚起爆"）
    const ratio = Number.isFinite(t.momentumRatio) ? t.momentumRatio : 0;
    if (ratio >= 1.15) {
      reasons.push(
        `爆发动能：最近 ${fmt(t.shortHours, 1)} 小时发帖速率是窗口均值的 ${ratio.toFixed(1)} 倍${
          t.surging ? '，且前后半窗同步上行 —— 正在起爆，窗口期只剩数小时' : '，属于刚起量的早期信号'
        }`
      );
    } else if (ratio > 0 && ratio <= 0.85) {
      reasons.push(`动能减弱：最近 ${fmt(t.shortHours, 1)} 小时速率降到窗口均值的 ${ratio.toFixed(1)} 倍，热度在退潮`);
    } else {
      reasons.push(`动能平稳：最近 ${fmt(t.shortHours, 1)} 小时速率约为窗口均值的 ${ratio ? ratio.toFixed(1) : '1.0'} 倍，没有明显的起爆或退潮`);
    }
    if (t.rising) reasons.push(`加速中：讨论量环比上升 ${(t.growth * 100).toFixed(0)}%（窗口期还在，适合抢时效）`);
    else if (t.growing) reasons.push(`温和上行：环比 +${(t.growth * 100).toFixed(0)}%，仍有增量但不算爆发`);
    else if (t.growth < -0.05) reasons.push(`热度衰减：环比下降 ${Math.abs(t.growth * 100).toFixed(0)}%（更适合追忆型内容，不适合追热点）`);
    reasons.push(`来源可信度：${t.accountCount} 个独立账号参与，${t.accounts.slice(0, 3).join(' / ')} 等都在讨论`);
    reasons.push(`时效：${(t.freshness * 100).toFixed(0)}% 的帖子发生在最近 25% 的时间窗口内`);
    reasons.push(
      t.relevance >= 0.5
        ? `与 TelyClaw 高度相关（命中产品/受众关键词占比 ${(t.relevance * 100).toFixed(0)}%）`
        : `与 TelyClaw 相关性偏弱（${(t.relevance * 100).toFixed(0)}%），建议用"行业观察"角度切入而非产品角度`
    );
    reasons.push(
      `内容可生产性 ${(t.contentOpportunity * 100).toFixed(0)}%：数据密度 ${(t.numberDensity * 100).toFixed(0)}%、多空分歧度 ${(t.conflict * 100).toFixed(0)}%`
    );
    if (t.strongMatch) reasons.push('该热点在监控窗口内被多个账号独立提及，且关键词一致性高，可判定为真实共识话题');

    const angles = [];
    if (t.numberDensity >= 0.5) angles.push('Educational / Insight（有数据可拆解）');
    if (t.conflict >= 0.5) angles.push('Hot Take / Opinion（多空分歧明显，适合表态）');
    if (t.relevance >= 0.4) angles.push('TelyClaw Product Angle（能自然接到产品叙事）');
    if (!angles.length) angles.push('行业观察（相关性弱，适合做轻量转发式点评）');

    // 时效建议：把"双口径"的结论落成一条可执行的动作指令
    const timingAdvice = t.surging
      ? '立即动手：短窗与前后半窗两个口径同时上行，属于正在起爆的窗口，建议 2 小时内完成审核并发布'
      : t.rising
        ? '优先处理：仍在加速，但已过最早的窗口，建议 6 小时内发布'
        : t.growth < -0.05
          ? '不着急：热度已在退潮，建议转成"复盘/观点"型内容，不追即时流量'
          : '正常排期：动能平稳，按常规内容日历处理即可';

    return { ...t, score, factors, reasons, suggestedAngles: angles, timingAdvice, rank: 0 };
  });

  scored.sort((a, b) => b.score - a.score);
  scored.forEach((t, i) => {
    t.rank = i + 1;
  });

  const top = scored.slice(0, limit);
  const gap = top.length > 1 ? top[0].score - top[1].score : 0;
  if (top.length) {
    const stateWord = top[0].surging
      ? '两个趋势口径同时确认它正在起爆'
      : top[0].rising
        ? '仍在加速'
        : top[0].growing
          ? '热度仍在温和上行'
          : '热度已经过峰（内容更适合做"复盘/观点"而不是追即时流量）';
    top[0].verdict =
      `在 ${topics.length} 个识别出的热点中，它是当前最值得 TelyClaw 跟进的一个` +
      (gap > 5 ? `（领先第二名 ${gap.toFixed(1)} 分，优势明显）` : `（与第二名差距仅 ${gap.toFixed(1)} 分，可同时准备第二条内容）`) +
      `。窗口内它已被 ${top[0].accountCount} 个账号讨论，${stateWord}，且${top[0].relevance >= 0.4 ? '与我们的产品叙事直接相关' : '可以借"AI 内容效率"的框架重新包装后使用'}。` +
      `行动建议：${top[0].timingAdvice}。`;
  }

  return { opportunities: top, all: scored, factorMeta: FACTOR_META, weights: w, humanizeHours };
}
