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
import { config, publicConfig, applyRuntimeConfig, PUBLIC_DIR, ROLES, DEFAULT_MEMBERS, can } from './src/config.js';
import { loadState, saveState, resetState, logEvent, nextId } from './src/store.js';
import { runIngest, runAnalyze, windowHoursOf } from './src/pipeline.js';
import { generateContent, qualityCheck, runEditorReview } from './src/content.js';
import { computeMetrics } from './src/metrics.js';
import {
  applyScheduler,
  schedulerStatus,
  runSchedulerTick,
  markAlertRead,
  clearAlerts,
} from './src/scheduler.js';
import { ACCOUNTS, HOUR } from './src/dataset.js';

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
  }
  // 工作区成员（作者 / 审核人 / 发布人分离），首次启动时初始化
  if (!s.members?.length) {
    s.members = DEFAULT_MEMBERS.map((m) => ({ ...m }));
    logEvent('workspace_seeded', { members: s.members.length });
  }
  if (!s.actorId || !s.members.some((m) => m.id === s.actorId)) {
    s.actorId = (s.members.find((m) => m.role === 'admin') || s.members[0]).id;
  }
  saveState();
  return s;
}

const ACTION_LABEL = {
  edit: '编辑内容',
  generate: '生成内容',
  approve: '批准',
  reject: '驳回',
  publish: '发布',
  assign: '分配审核人',
};

function currentActor(s) {
  return s.members.find((m) => m.id === s.actorId) || s.members[0] || null;
}

/**
 * 角色权限闸门（服务端强制，不只靠前端按钮 disabled）。
 * 设计意图：作者 / 审核人 / 发布人分离 —— 避免"自己写、自己批、自己发"。
 */
function guard(s, action) {
  const actor = currentActor(s);
  if (!actor) return { ok: false, code: 403, error: '工作区没有成员，无法执行操作' };
  if (!can(actor.role, action)) {
    const allowed = Object.values(ROLES)
      .filter((r) => r.can.includes(action))
      .map((r) => r.label)
      .join(' / ');
    return {
      ok: false,
      code: 403,
      error: `当前身份「${actor.name}（${ROLES[actor.role]?.label || actor.role}）」没有「${ACTION_LABEL[action] || action}」权限；需要角色：${allowed}。可在右上角切换身份。`,
    };
  }
  return { ok: true, actor };
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
          momentum: t.momentum,
          momentumRatio: t.momentumRatio,
          shortHours: t.shortHours,
          surging: t.surging,
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
          timingAdvice: t.timingAdvice,
          suggestedAngles: t.suggestedAngles,
          samplePosts: (t.samplePosts || []).slice(0, 3),
        })),
      }
    : null;

  const actor = currentActor(s);
  const alerts = s.alerts || [];

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
    // 团队审核工作流
    members: (s.members || []).map((m) => ({ ...m, roleLabel: ROLES[m.role]?.label || m.role, isCurrent: m.id === actor?.id })),
    actor: actor ? { ...actor, roleLabel: ROLES[actor.role]?.label || actor.role, can: ROLES[actor.role]?.can || [] } : null,
    roleCatalog: Object.values(ROLES).map((r) => ({ key: r.key, label: r.label, can: r.can })),
    // 排期监控
    scheduler: schedulerStatus(),
    alerts: alerts.slice(0, 20),
    unreadAlerts: alerts.filter((a) => !a.read).length,
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
      return json(res, 200, await runIngest({ window: body.window || s.lastWindow }));
    }

    if (p === '/api/analyze' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.window) s.lastWindow = String(body.window);
      const hours = windowHoursOf(s.lastWindow);
      // 若尚未抓取或窗口内没有数据，先抓一次（否则分析结果会是空的）
      const fresh = s.posts.filter((x) => x.createdAt >= Date.now() - hours * HOUR);
      if (!fresh.length) await runIngest({ window: s.lastWindow });
      runAnalyze({ window: s.lastWindow, trigger: 'manual' });
      return json(res, 200, stateSnapshot());
    }

    if (p === '/api/generate' && req.method === 'POST') {
      const g = guard(s, 'generate');
      if (!g.ok) return json(res, g.code, { error: g.error });
      const body = await readBody(req);
      const key = body.topicKey;
      const topic = (s.analysis?.topics || []).find((t) => t.key === key);
      if (!topic) return json(res, 404, { error: '未找到该话题，请先运行热点识别' });
      const { drafts, warnings, facts } = await generateContent(topic, {
        windowHours: s.analysis?.hours || 24,
      });
      // 同一话题重新生成时，保留已发布的，替换未定稿的
      s.drafts = [...drafts, ...s.drafts.filter((d) => !(d.topicKey === key && ['draft', 'needs_revision'].includes(d.status)))];
      logEvent('generate', { topicKey: key, count: drafts.length, by: g.actor.name });
      saveState();
      return json(res, 200, { drafts, warnings, facts, state: stateSnapshot() });
    }

    if (p === '/api/draft/update' && req.method === 'POST') {
      const g = guard(s, 'edit');
      if (!g.ok) return json(res, g.code, { error: g.error });
      const body = await readBody(req);
      const d = s.drafts.find((x) => x.id === body.id);
      if (!d) return json(res, 404, { error: '草稿不存在' });
      const text = String(body.text || '').trim();
      const topic = (s.analysis?.topics || []).find((t) => t.key === d.topicKey);
      d.text = text;
      d.editedCount += 1;
      d.quality = qualityCheck(text, topic?.samplePosts || []);
      d.status = d.quality.pass ? (d.status === 'needs_revision' ? 'draft' : d.status) : 'needs_revision';
      d.history.push({
        at: Date.now(),
        action: 'human_edit',
        by: g.actor.name,
        note: `${g.actor.name} 编辑第 ${d.editedCount} 次，原创度 ${d.quality.originality}%`,
      });
      logEvent('human_edit', { id: d.id, by: g.actor.name });
      saveState();
      return json(res, 200, { draft: d, drafts: s.drafts });
    }

    if (p === '/api/draft/regenerate' && req.method === 'POST') {
      const g = guard(s, 'generate');
      if (!g.ok) return json(res, g.code, { error: g.error });
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
      d.review = fresh.review;
      d.status = fresh.quality.pass ? 'draft' : 'needs_revision';
      d.history.push({ at: Date.now(), action: 'regenerated', by: g.actor.name, note: `${g.actor.name} 重新生成` });
      saveState();
      return json(res, 200, { draft: d, drafts: s.drafts });
    }

    /** 重跑编辑 Agent 自评：人工改完之后再让"编辑 Agent"看一遍 */
    if (p === '/api/draft/review' && req.method === 'POST') {
      const body = await readBody(req);
      const d = s.drafts.find((x) => x.id === body.id);
      if (!d) return json(res, 404, { error: '草稿不存在' });
      const topic = (s.analysis?.topics || []).find((t) => t.key === d.topicKey);
      if (!topic) return json(res, 404, { error: '该草稿对应的话题已不存在，请重新做热点识别' });
      d.review = await runEditorReview(d.text, topic, d.quality);
      d.history.push({ at: Date.now(), action: 'editor_review', note: `编辑 Agent 复评：${d.review.overall} 分（${d.review.verdictLabel}）` });
      logEvent('editor_review', { id: d.id, overall: d.review.overall });
      saveState();
      return json(res, 200, { draft: d, drafts: s.drafts });
    }

    /** 分配审核人（对齐"工作区任务指派"的做法） */
    if (p === '/api/draft/assign' && req.method === 'POST') {
      const g = guard(s, 'assign');
      if (!g.ok) return json(res, g.code, { error: g.error });
      const body = await readBody(req);
      const d = s.drafts.find((x) => x.id === body.id);
      if (!d) return json(res, 404, { error: '草稿不存在' });
      const target = s.members.find((m) => m.id === body.memberId);
      d.assignedTo = target ? target.id : null;
      d.history.push({
        at: Date.now(),
        action: 'assigned',
        by: g.actor.name,
        note: target ? `${g.actor.name} 把审核任务分配给 ${target.name}` : `${g.actor.name} 取消了分配`,
      });
      logEvent('draft_assigned', { id: d.id, to: target?.name || null });
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
      // 角色闸门：批准 / 驳回属于审核人职责，编辑无权自行批准
      const action = status === 'approved' ? 'approve' : status === 'rejected' ? 'reject' : 'edit';
      const g = guard(s, action);
      if (!g.ok) return json(res, g.code, { error: g.error });
      if (status === 'approved' && !d.quality.pass) {
        return json(res, 400, { error: '该草稿未通过原创度/长度校验，需先修改' });
      }
      d.status = status;
      if (status === 'approved' || status === 'rejected') {
        d.reviewedBy = g.actor.id;
        d.reviewedAt = Date.now();
      }
      d.history.push({
        at: Date.now(),
        action: status,
        by: g.actor.name,
        note: status === 'approved' ? `${g.actor.name} 批准` : status === 'rejected' ? `${g.actor.name} 驳回` : '退回草稿',
      });
      logEvent(`draft_${status}`, { id: d.id, by: g.actor.name });
      saveState();
      return json(res, 200, { draft: d, drafts: s.drafts });
    }

    if (p === '/api/draft/publish' && req.method === 'POST') {
      const g = guard(s, 'publish');
      if (!g.ok) return json(res, g.code, { error: g.error });
      const body = await readBody(req);
      const d = s.drafts.find((x) => x.id === body.id);
      if (!d) return json(res, 404, { error: '草稿不存在' });
      if (!d.quality.pass) return json(res, 400, { error: '未通过质量校验，禁止发布' });
      // 双闸门：必须是"已批准"状态才能发布，发布人不能绕开审核人自行放行
      if (d.status !== 'approved') {
        return json(res, 400, {
          error: `发布前必须先由审核人批准（当前状态：${d.status}）。这是刻意的流程约束：作者 / 审核人 / 发布人分离。`,
        });
      }
      const topic = (s.analysis?.topics || []).find((t) => t.key === d.topicKey);
      d.status = 'published';
      d.publishedAt = Date.now();
      d.publishedBy = g.actor.id;
      d.history.push({
        at: Date.now(),
        action: 'published',
        by: g.actor.name,
        note: `${g.actor.name} 发布（MVP 为模拟发布，X API 写入为 Bonus 项）`,
      });
      const rec = {
        id: nextId('pub'),
        draftId: d.id,
        topicKey: d.topicKey,
        topicName: d.topicName,
        angleLabel: d.angleLabel,
        text: d.text,
        predicted: d.predicted,
        publishedAt: d.publishedAt,
        publishedBy: g.actor.name,
        reviewedBy: s.members.find((m) => m.id === d.reviewedBy)?.name || null,
        mode: 'simulated_publish',
        url: `https://x.com/TelyClaw/status/${String(Date.now()).slice(-12)}`,
      };
      s.published.unshift(rec);
      s.publishedTopicSnapshots[d.id] = { topicKey: d.topicKey, postCount: topic?.postCount || 0, at: Date.now() };
      logEvent('published', { id: d.id, topicKey: d.topicKey, by: g.actor.name });
      saveState();
      return json(res, 200, { published: rec, drafts: s.drafts, publishedList: s.published });
    }

    /* -------- 团队审核工作流：切换当前操作身份 -------- */
    if (p === '/api/members/actor' && req.method === 'POST') {
      const body = await readBody(req);
      const target = s.members.find((m) => m.id === body.memberId);
      if (!target) return json(res, 404, { error: '成员不存在' });
      s.actorId = target.id;
      logEvent('actor_switched', { name: target.name, role: target.role });
      saveState();
      return json(res, 200, stateSnapshot());
    }

    /* -------- 排期监控（Scheduled Monitoring） -------- */
    if (p === '/api/scheduler' && req.method === 'GET') {
      return json(res, 200, { scheduler: schedulerStatus(), alerts: s.alerts || [] });
    }

    if (p === '/api/scheduler' && req.method === 'POST') {
      const body = await readBody(req);
      applyRuntimeConfig({ scheduler: body.scheduler || body });
      applyScheduler();
      logEvent('scheduler_config', { ...config.scheduler });
      saveState();
      return json(res, 200, { scheduler: schedulerStatus(), config: publicConfig() });
    }

    /** 立即执行一轮（不用等到下一个轮询周期，方便演示） */
    if (p === '/api/scheduler/tick' && req.method === 'POST') {
      const result = await runSchedulerTick({ manual: true });
      return json(res, 200, { result, scheduler: schedulerStatus(), state: stateSnapshot() });
    }

    if (p === '/api/alerts/read' && req.method === 'POST') {
      const body = await readBody(req);
      const out = markAlertRead(body.id);
      return json(res, 200, { ...out, unread: out.alerts.filter((a) => !a.read).length });
    }

    if (p === '/api/alerts/clear' && req.method === 'POST') {
      clearAlerts();
      logEvent('alerts_cleared', {});
      return json(res, 200, { alerts: [], unread: 0 });
    }

    if (p === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      const cfg = applyRuntimeConfig(body);
      // 排期设置变化后立即重启定时器，避免"改了配置但没生效"
      if (body.scheduler) applyScheduler();
      logEvent('config_changed', body);
      saveState();
      return json(res, 200, { config: cfg, scheduler: schedulerStatus() });
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

/** 逐时分布已抽到 src/pipeline.js，这里只保留服务启动逻辑 */
seedAccountsIfEmpty();

// 启动时按配置恢复排期监控（默认关闭，可在设置页打开）
applyScheduler();

server.listen(config.port, () => {
  console.log(`\n  TelyClaw Growth Engine running`);
  console.log(`  ➜  http://localhost:${config.port}`);
  console.log(`  数据源: ${config.dataSource}   内容生成: ${config.llmMode}`);
  console.log(`  排期监控: ${config.scheduler.enabled ? `开启（每 ${config.scheduler.intervalMinutes} 分钟）` : '关闭'}\n`);
});
