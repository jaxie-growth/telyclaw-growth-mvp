/**
 * src/content.js
 * ------------------------------------------------------------
 * TelyClaw Content Generation
 *
 * 输入：一个热点话题（含事实摘要、情绪结构、发布时间窗）
 * 输出：3 个不同角度的内容草稿（Hot Take / Educational / TelyClaw Product Angle）
 *      + 至少 1 条可直接发布的 X Post（≤280 字符）
 *
 * 两种模式：
 *   mock   —— 内置确定性生成器（不联网、不需 key，demo 默认；确保"永远能跑"）
 *   openai —— 调用任意 OpenAI 兼容接口，Prompt 与校验逻辑完全一致
 *
 * 无论哪种模式，都强制做"原创度校验"：
 *   - 与源帖做加权 Jaccard 相似度（防止 Rewrite）
 *   - 与源帖做 5-gram 最长重叠（防止 Copy）
 *   不达标会被标记为 needs_revision / rejected，不允许进入发布队列。
 * ------------------------------------------------------------
 */
import { config, ROOT } from './config.js';
import fs from 'node:fs';
import path from 'node:path';
import { tokenize, keywordHit } from './topics.js';
import { TOPIC_SEEDS, PHRASES } from './dataset.js';
import { nextId } from './store.js';

const TEAM_CONTEXT = {
  product: 'TelyClaw',
  oneLiner: 'TelyClaw 是一套 AI-native 的 Social Growth Engine：持续监控 X 上的热点，自动把热点转成官方账号可发布的内容。',
  audience: 'AI-native 创业者、开发者、量化/研究者、财经与 AI 内容创作者',
  voice: '短句、有观点、给数据、不喊单、不夸张、拒绝营销味',
};

function extractFacts(topic) {
  // 数字事实：优先带单位（% / $ / bn / bp）的，长度太短的裸数字没有信息量
  const raw = [];
  for (const p of topic.samplePosts) {
    for (const m of p.text.matchAll(/[-+]?\$?\d[\d.,]*(%|bn|m|k|bp|x|pts|GW|bbl|\/oz|\/bbl)?/g)) {
      const tok = m[0];
      if (tok.replace(/[^\d]/g, '').length < 1) continue;
      if (tok.length < 3 && !/[%$]/.test(tok)) continue;
      raw.push(tok);
    }
  }
  const scoredNums = [...new Set(raw)]
    .sort((a, b) => {
      const ua = /[%$bnkbmx]/.test(a) ? 1 : 0;
      const ub = /[%$bnkbmx]/.test(b) ? 1 : 0;
      return ub - ua || b.length - a.length;
    })
    .slice(0, 5);

  // 关键词：优先用"话题词典里的高频词"（china / stimulus / rate cut），
  // 而不是纯粹的词频结果（避免出现 cny / fix 这种低信息量 token）
  const seed = TOPIC_SEEDS.find((s) => s.id === topic.key);
  let keywords = [];
  if (seed) {
    const freq = new Map();
    for (const kw of seed.keywords) {
      const hits = topic.samplePosts.filter((p) => keywordHit(p.text, kw)).length;
      if (hits > 0) freq.set(kw, hits);
    }
    keywords = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  }
  if (keywords.length < 2) {
    keywords = [...topic.keywords.filter((k) => k.length >= 4), ...topic.keywords].slice(0, 4);
  }

  const phraseMeta = seed ? PHRASES[seed.id] : null;

  return {
    postCount: topic.postCount,
    accountCount: topic.accountCount,
    growthPct: Math.round((topic.growth || 0) * 100),
    velocity: Math.round(topic.velocity || 0),
    engagement: topic.engagement,
    numbers: scoredNums,
    cashtags: topic.cashtags.length ? topic.cashtags : [],
    keywords: keywords.slice(0, 4),
    phrase: phraseMeta?.phrase || topic.name,
    nouns: phraseMeta?.nouns || keywords.slice(0, 4).map(toPhrase),
  };
}

function pickIdx(seed, len, salt = 0) {
  return Math.abs(Math.floor(seed * 2654435761 + salt * 40503)) % len;
}

/** 把单个词包装成可读的名词短语 */
function toPhrase(token = '') {
  const t = String(token).trim();
  if (!t) return 'this';
  if (t.includes(' ') || /^[A-Z]/.test(t)) return t;
  return `${t} positioning`;
}

/* ---------------------------------------------------------------
 * mock 生成器：用"骨架 + 事实填充"，保证句子结构与源帖不同，
 * 因此天然不会构成 Copy / Rewrite / Summary
 * ------------------------------------------------------------- */
function mockDrafts(topic, facts) {
  const kw = facts.keywords.length ? facts.keywords : [topic.name.split(' / ')[0].toLowerCase()];
  const nouns = facts.nouns && facts.nouns.length ? facts.nouns : kw.map(toPhrase);
  const k1 = nouns[0];
  const k2 = nouns[1] || nouns[0];
  const topicPhrase = facts.phrase;
  const cashtag = facts.cashtags[0] || '';
  const num = facts.numbers[0] || `${facts.postCount} posts`;
  const seed = [...topic.key].reduce((s, c) => s + c.charCodeAt(0), topic.postCount * 7);
  const spd = Math.max(1, facts.velocity);
  const growthText =
    facts.growthPct > 0
      ? `up ${facts.growthPct}% window over window`
      : facts.growthPct < 0
        ? `cooling (${facts.growthPct}% window over window)`
        : 'flat window over window';
  const growthShort = `${facts.growthPct >= 0 ? '+' : ''}${facts.growthPct}% w/w`;

  const hotTakes = [
    `Unpopular take: ${topicPhrase} is being read as a headline, not as a repricing. ${facts.postCount} posts from ${facts.accountCount} accounts in one window is not noise. Traders are early; consensus shows up in two weeks.`,
    `Most desks will call ${topicPhrase} "noise" until it hits their P&L. Volume is ${growthText} and ${facts.accountCount} independent accounts are already in. That is a trend, not a take. ${cashtag}`,
    `If you only read one thing about ${topicPhrase}: the signal is ${k1}, not the headline. ${num} is the number everyone will be quoting next week. Watch ${k2} for confirmation.`,
  ];

  const educational = [
    `3 things people get wrong about ${topicPhrase}:\n1) The headline is the least useful part — ${num} is what moves models.\n2) Base rates beat narratives: ${facts.accountCount} accounts, ${facts.postCount} posts, ${growthShort}.\n3) The real payoff sits in ${k1}.`,
    `Primer on ${topicPhrase} in 4 lines:\nWhat happened → ${facts.postCount} posts / ${facts.accountCount} accounts in one window.\nWhy it matters → ${k1} is where it shows up next.\nWhat to watch → whether ${k2} confirms.\nWhat to ignore → the loudest voice.`,
    `Speed is the story on ${topicPhrase}: ~${spd} interactions per hour at detection. Translation — you have hours, not days, before it is fully priced and fully written about by everyone else.`,
  ];

  const product = [
    `${topicPhrase} produced ~${facts.postCount} posts in one monitoring window. A traditional desk ships one note in that time; an AI-native team ships ten drafts in the same loop. The difference is not talent — it is workflow. That is what TelyClaw builds.`,
    `We watched ${topicPhrase} go from ${facts.accountCount} accounts to a full trending topic in hours. Nobody has a distribution problem — everyone has a "capture it while it is hot" problem. That is the loop TelyClaw closes.`,
    `Our category's real bottleneck: ${topicPhrase} is live right now, and most teams notice it tomorrow. Detection-to-publish is a workflow problem, and workflow is fixable. That is our bet at TelyClaw.`,
  ];

  const angles = [
    { angle: 'hot_take', label: 'Hot Take / Opinion', variants: hotTakes },
    { angle: 'educational', label: 'Educational / Insight', variants: educational },
    { angle: 'product', label: 'TelyClaw Product Angle', variants: product },
  ];

  return angles.map((a, i) => ({
    angle: a.angle,
    angleLabel: a.label,
    text: a.variants[pickIdx(seed, a.variants.length, i + 3)],
    origin: 'mock',
  }));
}

/* ---------------------------------------------------------------
 * 真实 LLM 模式
 * ------------------------------------------------------------- */
function buildPrompt(topic, facts) {
  return [
    {
      role: 'system',
      content:
        `你是 ${TEAM_CONTEXT.product} 的增长负责人。产品一句话：${TEAM_CONTEXT.oneLiner}\n` +
        `目标受众：${TEAM_CONTEXT.audience}\n文风要求：${TEAM_CONTEXT.voice}\n` +
        `输出必须是严格 JSON，不要任何解释性文字。`,
    },
    {
      role: 'user',
      content:
        `热点话题：${topic.name}\n` +
        `事实：${facts.postCount} 条帖子 / ${facts.accountCount} 个账号 / 环比 ${facts.growthPct}% / 小时互动 ${facts.velocity} / 相关标的 ${facts.cashtags.join(',')}\n` +
        `话题摘要：${topic.summary}\n` +
        `源帖示例（仅供理解，严禁照抄）：\n${topic.samplePosts.map((p) => `- ${p.text}`).join('\n')}\n\n` +
        `请生成 3 个角度各 1 条 X 推文（英文，每条 ≤280 字符，必须包含原创洞察，禁止出现源帖中的完整句子）：\n` +
        `1) hot_take: 有观点、可以引发讨论\n` +
        `2) educational: 拆解数据或机制，给读者可带走的东西\n` +
        `3) product: 自然引到 TelyClaw 的产品叙事（不要硬广）\n` +
        `返回 JSON：{"posts":[{"angle":"hot_take","text":"..."},{"angle":"educational","text":"..."},{"angle":"product","text":"..."}]}`,
    },
  ];
}

async function llmDrafts(topic, facts) {
  const url = `${config.llmBaseUrl.replace(/\/$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.llmApiKey}`,
    },
    body: JSON.stringify({
      model: config.llmModel,
      temperature: 0.8,
      messages: buildPrompt(topic, facts),
    }),
  });
  if (!res.ok) throw new Error(`LLM 调用失败：HTTP ${res.status} ${await res.text().catch(() => '')}`);
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content || '';
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('LLM 未返回合法 JSON');
  const parsed = JSON.parse(match[0]);
  const labelMap = { hot_take: 'Hot Take / Opinion', educational: 'Educational / Insight', product: 'TelyClaw Product Angle' };
  return (parsed.posts || []).map((p) => ({
    angle: p.angle,
    angleLabel: labelMap[p.angle] || p.angle,
    text: String(p.text || '').trim(),
    origin: 'llm',
  }));
}

/* ---------------------------------------------------------------
 * 原创度 / 质量校验
 * ------------------------------------------------------------- */
export function qualityCheck(text, sourcePosts) {
  const { tokens } = tokenize(text);
  let maxSim = 0;
  let maxGramOverlap = 0;
  const draftWords = text.toLowerCase().match(/[a-z][a-z\-]{2,}/g) || [];
  const draftGrams = new Set();
  for (let i = 0; i + 5 <= draftWords.length; i++) draftGrams.add(draftWords.slice(i, i + 5).join(' '));

  for (const p of sourcePosts) {
    const { tokens: st } = tokenize(p.text);
    let inter = 0;
    let union = 0;
    for (const [k, v] of tokens) {
      const sv = st.get(k) || 0;
      inter += Math.min(v, sv);
      union += Math.max(v, sv);
    }
    for (const [k, v] of st) if (!tokens.has(k)) union += v;
    const sim = union ? inter / union : 0;
    if (sim > maxSim) maxSim = sim;

    const sw = p.text.toLowerCase().match(/[a-z][a-z\-]{2,}/g) || [];
    let overlap = 0;
    for (let i = 0; i + 5 <= sw.length; i++) {
      if (draftGrams.has(sw.slice(i, i + 5).join(' '))) overlap += 1;
    }
    const ratio = draftGrams.size ? overlap / draftGrams.size : 0;
    if (ratio > maxGramOverlap) maxGramOverlap = ratio;
  }

  const charCount = [...text].length;
  const hasNumber = /\d/.test(text);
  const hasCashtag = /\$[A-Za-z]/.test(text);
  // 原创度：以"与源帖的语义相似度"和"连续 5 词重复率"两个口径取更严厉的一个
  const originality = Math.max(0, Math.round((1 - Math.max(maxSim, maxGramOverlap * 2)) * 100));

  const problems = [];
  if (charCount > 280) problems.push(`超出 X 字符上限（${charCount}/280）`);
  if (maxSim >= 0.45) problems.push(`与源帖语义相似度过高（${(maxSim * 100).toFixed(0)}%），涉嫌 Rewrite`);
  if (maxGramOverlap >= 0.2) problems.push(`存在与源帖连续 5 词重叠（${(maxGramOverlap * 100).toFixed(0)}%），涉嫌 Copy`);
  if (text.trim().length < 60) problems.push('内容过短，信息量不足');

  return {
    charCount,
    hasNumber,
    hasCashtag,
    maxSourceSimilarity: Number(maxSim.toFixed(3)),
    maxGramOverlap: Number(maxGramOverlap.toFixed(3)),
    originality,
    problems,
    pass: problems.length === 0,
  };
}

/** 预估表现（模拟）：用于看板的 Engagement Lift / Qualified Engagement 指标 */
function predictPerformance(topic, angle) {
  const angleMult = { hot_take: 1.25, educational: 1.0, product: 0.85 }[angle] || 1;
  const base = topic.velocity * 1.6 + topic.engagement / 18 + 400;
  const impressions = Math.round(base * angleMult * (1 + topic.conflict * 0.3));
  const engagement = Math.round(impressions * (0.016 + topic.conflict * 0.014));
  const icpShare = Math.min(0.85, 0.3 + topic.relevance * 0.6);
  return {
    impressions,
    engagement,
    icpShare: Number(icpShare.toFixed(2)),
    qualifiedEngagement: Math.round(engagement * icpShare),
    note: '模拟预估（基于话题动能 + 角度系数的启发式模型），不代表真实 X 数据',
  };
}

export async function generateContent(topic, { windowHours = 24, history = [] } = {}) {
  const facts = extractFacts(topic);
  const warnings = [];
  let raw;
  try {
    raw = config.llmMode === 'openai' && config.llmApiKey ? await llmDrafts(topic, facts) : mockDrafts(topic, facts);
  } catch (e) {
    warnings.push(`LLM 生成失败，已回退到内置生成器：${e.message}`);
    raw = mockDrafts(topic, facts);
  }

  const drafts = raw
    .filter((d) => d.text)
    .map((d) => {
      const quality = qualityCheck(d.text, topic.samplePosts);
      return {
        id: nextId('draft'),
        topicKey: topic.key,
        topicName: topic.name,
        topicScore: topic.score,
        angle: d.angle,
        angleLabel: d.angleLabel,
        text: d.text,
        origin: d.origin,
        quality,
        predicted: predictPerformance(topic, d.angle),
        status: quality.pass ? 'draft' : 'needs_revision',
        editedCount: 0,
        history: [{ at: Date.now(), action: 'created', note: `由 ${d.origin} 生成器产出，原创度 ${quality.originality}%` }],
        windowHours,
      };
    });

  // 保证至少 1 条"可直接发布"的候选：优先 Hot Take，其次原生成质量最高的一条
  const sorted = [...drafts].filter((d) => d.quality.pass).sort((a, b) => b.predicted.engagement - a.predicted.engagement);
  const ready = sorted[0];
  drafts.forEach((d) => {
    d.readyToPublish = ready ? d.id === ready.id : false;
  });
  if (!ready) warnings.push('本次生成的内容都没有通过原创度/长度校验，请人工改写后再发布。');

  return { drafts, warnings, facts };
}
