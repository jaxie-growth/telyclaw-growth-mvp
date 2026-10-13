/**
 * scripts/smoke.js
 * 端到端冒烟测试：不启动 HTTP 服务，直接跑业务链路
 *   ingest -> detect -> rank -> generate -> qualify
 * 用法：node scripts/smoke.js [windowHours]
 */
import { ingest } from '../src/ingest.js';
import { detectTopics } from '../src/topics.js';
import { rankOpportunities } from '../src/ranking.js';
import { generateContent } from '../src/content.js';
import { ACCOUNTS } from '../src/dataset.js';

const windowHours = Number(process.argv[2] || 24);

const { posts, source } = await ingest({
  handles: ACCOUNTS.map((a) => a.handle),
  windowHours,
});
console.log(`\n[1] Ingest  source=${source}  window=${windowHours}h  posts=${posts.length}`);

const topics = detectTopics(posts, { windowHours });
console.log(`\n[2] Detect  topics=${topics.length}`);
for (const t of topics.slice(0, 12)) {
  console.log(
    `    - ${t.name.padEnd(52)} posts=${String(t.postCount).padStart(3)}  accounts=${String(t.accountCount).padStart(2)}` +
      `  growth=${(t.growth * 100).toFixed(0)}%  rel=${t.relevance.toFixed(2)}`
  );
}

const ranked = rankOpportunities(topics, { limit: 5 });
console.log(`\n[3] Rank  Top ${ranked.opportunities.length}`);
for (const o of ranked.opportunities) {
  console.log(`    #${o.rank} ${o.score.toFixed(1)}  ${o.name}`);
  console.log(`        ${o.verdict || ''}`);
}

const top = ranked.opportunities[0];
if (top) {
  const { drafts, warnings, facts } = await generateContent(top, { windowHours });
  console.log(`\n[4] Generate  drafts=${drafts.length}  warnings=${warnings.length}`);
  for (const d of drafts) {
    console.log(`    [${d.angleLabel}] pass=${d.quality.pass} 原创度=${d.quality.originality}% 字数=${d.quality.charCount} 相似度=${d.quality.maxSourceSimilarity}`);
    console.log(`      ${d.text.replace(/\n/g, ' ⏎ ')}`);
  }
  console.log(`\n    readyToPublish: ${drafts.filter((d) => d.readyToPublish).length} 条`);
  console.log(`    facts: ${JSON.stringify(facts)}`);
  if (warnings.length) console.log(`    WARN: ${warnings.join(' | ')}`);
}
console.log('\n✅ smoke done\n');
