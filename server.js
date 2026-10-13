/**
 * server.js
 * ------------------------------------------------------------
 * TelyClaw Growth Engine —— 零依赖 HTTP 服务（Node 内置模块即可运行）
 *
 * 为什么不用框架：面试作业要求"快速跑通"，零依赖意味着 clone 下来 `node server.js`
 * 就能跑，不需要 npm install、不需要构建步骤。
 *
 * 真实产品化时：把 src/store.js 换成 Postgres/Supabase、把本文件换成 Express/Next.js
 * API Route 即可，业务模块（ingest / topics / ranking / content / metrics）可原样复用。
 * ------------------------------------------------------------
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config, publicConfig, applyRuntimeConfig, PUBLIC_DIR } from './src/config.js';
import { loadState, saveState, resetState, logEvent, nextId, savePostsSnapshot } from './src/store.js';
import { ingest } from './src/ingest.js';
import { detectTopics } from './src/topics.js';
import { rankOpportunities } from './src/ranking.js';
import { generateContent, qualityCheck } from './src/content.js';
import { computeMetrics } from './src/metrics.js';
import { ACCOUNTS, WINDOWS, HOUR } from './src/dataset.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function seedAccountsIfEmpty() {
  const s = loadState();
  if (!s.accounts.length) {
    s.accounts = ACCOUNTS.map((a) => ({
      handle: a.handle,
      name: a.name,
      category: a.category,
      enabled: true,
      addedAt: Date.now(),
    }));
    saveState();
  }
  return s;
}

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function windowHoursOf(label) {
  if (typeof label === 'number') return label;
  return WINDOWS[label] || 24;
}

/** 生成状态快照给前端 */
function stateSnapshot() {
  const s = loadState();
  const analysis = s.analysis
    ? {
        window: s.analysis.window,
        hours: s.analysis.hours,
        generatedAt: s.analysis.generatedAt,
        topicCount: s.analysis.topics?.length || 0,
        postCount: s.analysis.postCount,
        topics: (s.analysis.topics || []).slice(0, 12).map((t) => ({
          key: t.key,
          name: t.name,
          summary: t.summary,
          postCount: t.postCount,
          accountCount: t.accountCount,
          engagement: t.engagement,
          growth: t.growth,
          rising: t.rising,
          velocity: t.velocity,
          freshness: t.freshness,
          relevance: t.relevance,
          contentOpportunity: t.contentOpportunity,
          tone: t.tone,
          hist: t.hist,
          cashtags: t.cashtags,
          keywords: t.keywords,
          accounts: t.accounts,
          peakAt: t.peakAt,
          score: t.score,
          rank: t.rank,
          factors: t.factors,
          reasons: t.reasons,
          verdict: t.verdict,
          suggestedAngles: t.suggestedAngles,
          samplePosts: (t.samplePosts || []).slice(0, 3),
        })),
      }
    : null;

  return {
    config: publicConfig(),
    accounts: s.accounts,
    lastIngestAt: s.lastIngestAt,
    lastWindow: s.lastWindow,
    postCount: s.posts.length,
    analysis,
    drafts: s.drafts,
    published: s.published,
    hasDraftForTopics: [...new Set(s.drafts.map((d) => d.topicKey))],
    detection: s.detection,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${config.port}`);
  const p = url.pathname;

  try {
    /* ---------------- 静态资源 ---------------- */
    if (!p.startsWith('/api/')) {
      const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
      const file = path.join(PUBLIC_DIR, rel);
      if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
      return;
    }

    /* ---------------- API ---------------- */
    const s = seedAccountsIfEmpty();

    if (p === '/api/state' && req.method === 'GET') {
      return json(res, 200, stateSnapshot());
    }

    if (p === '/api/posts' && req.method === 'GET') {
      const sorted = [...s.posts].sort((a, b) => b.engagement - a.engagement).slice(0, 120);
      return json(res, 200, { posts: sorted, total: s.posts.length, window: s.lastWindow, source: s.ingestSource || config.dataSource });
    }

    if (p === '/api/accounts' && req.method === 'POST') {
      const body = await readBody(req);
      const handle = String(body.handle || '').trim();
      if (!handle) return json(res, 400, { error: 'handle 不能为空' });
      const normalized = handle.startsWith('@') ? handle : `@${handle}`;
      if (s.accounts.some((a) => a.handle.toLowerCase() === normalized.toLowerCase())) {
        return json(res, 400, { error: '该账号已在监控列表中', accounts: s.accounts });
      }
      s.accounts.push({
        handle: normalized,
        name: body.name || normalized,
        category: body.category || '自定义',
        enabled: true,
        addedAt: Date.now(),
      });
      logEvent('account_added', { handle: normalized });
      saveState();
      return json(res, 200, { accounts: s.accounts, note: '已加入监控列表（仿真模式下新账号若无历史数据，抓取结果可能为空）' });
    }

    if (p === '/api/accounts/remove' && req.method === 'POST') {
      const body = await readBody(req);
      s.accounts = s.accounts.filter((a) => a.handle !== body.handle);
      logEvent('account_removed', { handle: body.handle });
      saveState();
      return json(res, 200, { accounts: s.accounts });
    }

    if (p === '/api/accounts/toggle' && req.method === 'POST') {
      const body = await readBody(req);
      const acc = s.accounts.find((a) => a.handle === body.handle);
      if (acc) acc.enabled = !acc.enabled;
      saveState();
      return json(res, 200, { accounts: s.accounts });
    }

    if (p === '/api/ingest' && req.method === 'POST') {
      const body = await readBody(req);
      const hours = windowHoursOf(body.window || s.lastWindow);
      const handles = s.accounts.filter((a) => a.enabled).map((a) => a.handle);
      const { posts, source, warnings } = await ingest({ handles, windowHours: hours });
      s.posts = posts;
      s.lastIngestAt = Date.now();
      s.lastWindow = String(body.window || s.lastWindow);
      s.ingestSource = source;
      savePostsSnapshot(posts);
      logEvent('ingest', { window: s.lastWindow, posts: posts.length, source });
      saveState();
      return json(res, 200, {
        source,
        window: s.lastWindow,
        postCount: posts.length,
        accounts: handles.length,
        warnings,
        hourly: hourlyHistogram(posts, hours),
      });
    }

    if (p === '/api/analyze' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.window) {
        s.lastWindow = String(body.window);
      }
      const hours = windowHoursOf(s.lastWindow);
      // 若尚未抓取或窗口变化，先抓一次
      const cutoff = Date.now() - hours * HOUR;
      const fresh = s.posts.filter((x) => x.createdAt >= cutoff);
      if (!fresh.length) {
        const handles = s.accounts.filter((a) => a.enabled).map((a) => a.handle);
        const { posts } = await ingest({ handles, windowHours: hours });
        s.posts = posts;
        savePostsSnapshot(posts);
      }
      const posts = s.posts.filter((x) => x.createdAt >= cutoff);

      const topics = detectTopics(posts, { windowHours: hours, now: Date.now() });
      const ranked = rankOpportunities(topics, { limit: 8 });
      const now = Date.now();

      // 记录"首次检测到"的时间，用于计算 Detection Lead Time
      for (const t of ranked.all || []) {
        if (!s.detection[t.key]) s.detection[t.key] = now;
      }
      s.scoreHistory = [{ at: now, top: (ranked.opportunities[0] || {}).score || 0, topics: topics.length }, ...(s.scoreHistory || [])].slice(0, 30);

      s.analysis = {
        window: s.lastWindow,
        hours,
        generatedAt: now,
        postCount: posts.length,
        topics: ranked.all || [],
      };
      s.topics = ranked.all || [];
      logEvent('analyze', { window: s.lastWindow, topics: topics.length, posts: posts.length });
      saveState();
      return json(res, 200, stateSnapshot());
    }

    if (p === '/api/generate' && req.method === 'POST') {
      const body = await readBody(req);
      const key = body.topicKey;
      const topic = (s.analysis?.topics || []).find((t) => t.key === key);
      if (!topic) return json(res, 404, { error: '未找到该话题，请先运行热点识别' });
      const { drafts, warnings, facts } = await generateContent(topic, {
        windowHours: s.analysis?.hours || 24,
      });
      // 同一话题重新生成时，保留已发布的，替换未定稿的
      s.drafts = [...drafts, ...s.drafts.filter((d) => !(d.topicKey === key && ['draft', 'needs_revision'].includes(d.status)))];
      logEvent('generate', { topicKey: key, count: drafts.length });
      saveState();
      return json(res, 200, { drafts, warnings, facts, state: stateSnapshot() });
    }

    if (p === '/api/draft/update' && req.method === 'POST') {
      const body = await readBody(req);
      const d = s.drafts.find((x) => x.id === body.id);
      if (!d) return json(res, 404, { error: '草稿不存在' });
      const text = String(body.text || '').trim();
      const topic = (s.analysis?.topics || []).find((t) => t.key === d.topicKey);
      d.text = text;
      d.editedCount += 1;
      d.quality = qualityCheck(text, topic?.samplePosts || []);
      d.status = d.quality.pass ? (d.status === 'needs_revision' ? 'draft' : d.status) : 'needs_revision';
      d.history.push({ at: Date.now(), action: 'human_edit', note: `人工编辑第 ${d.editedCount} 次，原创度 ${d.quality.originality}%` });
      logEvent('human_edit', { id: d.id });
      saveState();
      return json(res, 200, { draft: d, drafts: s.drafts });
    }

    if (p === '/api/draft/regenerate' && req.method === 'POST') {
      const body = await readBody(req);
      const d = s.drafts.find((x) => x.id === body.id);
      const topic = (s.analysis?.topics || []).find((t) => t.key === d?.topicKey);
      if (!d || !topic) return json(res, 404, { error: '草稿或话题不存在' });
      const single = { ...topic, samplePosts: topic.samplePosts };
      const { drafts } = await generateContent(single, { windowHours: s.analysis?.hours || 24 });
      const fresh = drafts.find((x) => x.angle === d.angle) || drafts[0];
      d.text = fresh.text;
      d.quality = fresh.quality;
      d.origin = fresh.origin;
      d.predicted = fresh.predicted;
      d.status = fresh.quality.pass ? 'draft' : 'needs_revision';
      d.history.push({ at: Date.now(), action: 'regenerated', note: '重新生成' });
      saveState();
      return json(res, 200, { draft: d, drafts: s.drafts });
    }

    if (p === '/api/draft/status' && req.method === 'POST') {
      const body = await readBody(req);
      const d = s.drafts.find((x) => x.id === body.id);
      if (!d) return json(res, 404, { error: '草稿不存在' });
      const status = body.status;
      if (!['approved', 'rejected', 'draft', 'needs_revision'].includes(status)) {
        return json(res, 400, { error: '非法状态' });
      }
      if (status === 'approved' && !d.quality.pass) {
        return json(res, 400, { error: '该草稿未通过原创度/长度校验，需先修改' });
      }
      d.status = status;
      d.history.push({ at: Date.now(), action: status, note: status === 'approved' ? '人工批准' : '人工驳回' });
      logEvent(`draft_${status}`, { id: d.id });
      saveState();
      return json(res, 200, { draft: d, drafts: s.drafts });
    }

    if (p === '/api/draft/publish' && req.method === 'POST') {
      const body = await readBody(req);
      const d = s.drafts.find((x) => x.id === body.id);
      if (!d) return json(res, 404, { error: '草稿不存在' });
      if (!d.quality.pass) return json(res, 400, { error: '未通过质量校验，禁止发布' });
      const topic = (s.analysis?.topics || []).find((t) => t.key === d.topicKey);
      d.status = 'published';
      d.publishedAt = Date.now();
      d.history.push({ at: Date.now(), action: 'published', note: '已发布（MVP 为模拟发布，X API 写入为 Bonus 项）' });
      const rec = {
        id: nextId('pub'),
        draftId: d.id,
        topicKey: d.topicKey,
        topicName: d.topicName,
        angleLabel: d.angleLabel,
        text: d.text,
        predicted: d.predicted,
        publishedAt: d.publishedAt,
        mode: 'simulated_publish',
        url: `https://x.com/TelyClaw/status/${String(Date.now()).slice(-12)}`,
      };
      s.published.unshift(rec);
      s.publishedTopicSnapshots[d.id] = { topicKey: d.topicKey, postCount: topic?.postCount || 0, at: Date.now() };
      logEvent('published', { id: d.id, topicKey: d.topicKey });
      saveState();
      return json(res, 200, { published: rec, drafts: s.drafts, publishedList: s.published });
    }

    if (p === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      const cfg = applyRuntimeConfig(body);
      logEvent('config_changed', body);
      saveState();
      return json(res, 200, { config: cfg });
    }

    if (p === '/api/metrics' && req.method === 'GET') {
      return json(res, 200, computeMetrics({ dataSource: config.dataSource }));
    }

    if (p === '/api/reset' && req.method === 'POST') {
      resetState({ keepAccounts: true });
      logEvent('reset', {});
      saveState();
      return json(res, 200, stateSnapshot());
    }

    json(res, 404, { error: `未知接口 ${p}` });
  } catch (e) {
    json(res, 500, { error: e.message || '服务器内部错误' });
  }
});

function hourlyHistogram(posts, hours) {
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

server.listen(config.port, () => {
  console.log(`\n  TelyClaw Growth Engine running`);
  console.log(`  ➜  http://localhost:${config.port}`);
  console.log(`  数据源: ${config.dataSource}   内容生成: ${config.llmMode}\n`);
});
