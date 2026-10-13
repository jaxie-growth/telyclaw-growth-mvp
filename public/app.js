/* ============================================================
 * TelyClaw Growth Engine — 前端交互层（原生 JS，无构建步骤）
 * 数据全部来自后端 API；本文件只负责渲染与交互。
 * ============================================================ */

const state = {
  data: null,
  metrics: null,
  tab: 'overview',
  showAllDrafts: false,
  tourIndex: 0,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US'));
const pct = (n, digits = 0) => (n === null || n === undefined ? '—' : `${(n * 100).toFixed(digits)}%`);
const signed = (n, digits = 0) => (n === null || n === undefined ? '—' : `${n > 0 ? '+' : ''}${(n * 100).toFixed(digits)}%`);
const relTime = (ts) => {
  if (!ts) return '—';
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return `${Math.floor(diff)} 秒前`;
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${(diff / 3600).toFixed(1)} 小时前`;
  return `${(diff / 86400).toFixed(1)} 天前`;
};

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

let toastTimer = null;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3200);
}

function notice(msg, kind = 'info') {
  const el = $('#notice');
  if (!msg) {
    el.hidden = true;
    return;
  }
  el.className = `notice ${kind}`;
  el.innerHTML = msg;
  el.hidden = false;
}

function logLine(text) {
  const box = $('#run-log');
  const div = document.createElement('div');
  div.textContent = text;
  box.prepend(div);
}

function setBusy(btn, busy, label) {
  if (!btn) return;
  if (busy) {
    btn.dataset.label = btn.textContent;
    btn.disabled = true;
    btn.textContent = label || '处理中…';
  } else {
    btn.disabled = false;
    if (btn.dataset.label) btn.textContent = btn.dataset.label;
  }
}

/* ---------------- 渲染 ---------------- */
function render() {
  const d = state.data;
  if (!d) return;
  $('#badge-source').textContent = `数据源: ${d.config.dataSource}${d.config.hasXToken ? '（已配置 token）' : ''}`;
  $('#badge-llm').textContent = `生成: ${d.config.llmMode}${d.config.llmMode === 'openai' && !d.config.hasLlmKey ? '(缺 key→回退)' : ''}`;
  $('#window-select').value = d.lastWindow || '24H';

  renderOverview(d);
  renderAccounts(d);
  renderPosts(d);
  renderTopics(d);
  renderRanking(d);
  renderStudio(d);
  renderPublished(d);
  renderSettings(d);
  syncTourUI();
}

function metricsOf(analysis) {
  const topics = analysis?.topics || [];
  return {
    topicCount: topics.length,
    rising: topics.filter((t) => t.rising).length,
    posts: analysis?.postCount ?? 0,
  };
}

function renderOverview(d) {
  const m = metricsOf(d.analysis);
  const readyDrafts = (d.drafts || []).filter((x) => x.quality?.pass && ['draft', 'needs_revision'].includes(x.status));
  const approved = (d.drafts || []).filter((x) => x.status === 'approved').length;
  $('#overview-stats').innerHTML = `
    <div class="stat"><div class="label">监控账号</div><div class="value">${(d.accounts || []).filter((a) => a.enabled).length}</div>
      <div class="sub">共 ${(d.accounts || []).length} 个，${d.lastWindow || '24H'} 窗口内抓取 ${fmt(d.postCount)} 条帖子</div></div>
    <div class="stat"><div class="label">识别出的热点</div><div class="value">${m.topicCount}</div>
      <div class="sub">其中 ${m.rising} 个正在加速</div></div>
    <div class="stat"><div class="label">待审核草稿</div><div class="value">${readyDrafts.length}</div>
      <div class="sub">已批准待发布 ${approved} 条</div></div>
    <div class="stat accent"><div class="label">已发布内容</div><div class="value">${(d.published || []).length}</div>
      <div class="sub">最后抓取：${relTime(d.lastIngestAt)}</div></div>`;

  // 流程条状态
  const steps = {
    Monitor: (d.accounts || []).length > 0 && d.postCount > 0,
    Detect: m.topicCount > 0,
    Rank: m.topicCount > 0,
    Ideate: (d.drafts || []).length > 0,
    Craft: (d.drafts || []).length > 0,
    Review: (d.drafts || []).some((x) => ['approved', 'rejected', 'published'].includes(x.status)),
    Publish: (d.published || []).length > 0,
  };
  $$('#flow-steps .flow-step').forEach((el) => el.classList.toggle('done', Boolean(steps[el.dataset.step])));

  const top = (d.analysis?.topics || [])[0];
  $('#overview-top').innerHTML = top
    ? `<div class="topic ${top.rising ? 'rising' : ''}">
         <div class="topic-head">
           <div>
             <div class="topic-title">#1 ${esc(top.name)} ${top.rising ? '<span class="tag ok">加速中</span>' : ''}</div>
             <div class="topic-stats">
               <span>机会分数 <b>${top.score}</b></span>
               <span>帖子 <b>${top.postCount}</b></span>
               <span>账号 <b>${top.accountCount}</b></span>
               <span>环比 <b>${signed(top.growth)}</b></span>
             </div>
           </div>
           <button class="btn primary" data-gen="${esc(top.key)}">为它生成内容</button>
         </div>
         <div class="topic-summary">${esc(top.summary)}</div>
         ${top.verdict ? `<div class="verdict">${esc(top.verdict)}</div>` : ''}
       </div>`
    : '<p class="hint">还没有分析结果，先在上方运行"完整流水线"。</p>';
}

function renderAccounts(d) {
  const tbody = $('#accounts-table tbody');
  tbody.innerHTML = (d.accounts || [])
    .map(
      (a) => `<tr>
      <td><b>${esc(a.handle)}</b></td>
      <td>${esc(a.name)}</td>
      <td>${esc(a.category)}</td>
      <td>${a.enabled ? '<span class="tag">监控中</span>' : '<span class="tag off">已暂停</span>'}</td>
      <td>
        <button class="btn tiny" data-toggle-acc="${esc(a.handle)}">${a.enabled ? '暂停' : '启用'}</button>
        <button class="btn tiny" data-remove-acc="${esc(a.handle)}">移除</button>
      </td>
    </tr>`
    )
    .join('');
  $('#accounts-hint').textContent = `${(d.accounts || []).length} 个账号 · 最少 5 个（验收标准）· 当前窗口 ${d.lastWindow || '24H'}`;
}

function renderPosts(d) {
  const posts = (state.posts || []).slice(0, 40);
  $('#posts-list').innerHTML = posts.length
    ? posts
        .map(
          (p) => `<div class="post">
        <div class="meta">${esc(p.account)} · ${esc(p.category || '')} · ${new Date(p.createdAt).toLocaleString('zh-CN')} · 互动 ${fmt(p.engagement)}</div>
        <div class="text">${esc(p.text)}</div>
      </div>`
        )
        .join('')
    : '<p class="hint">点击上方"抓取当前窗口帖子"后，这里会显示原始证据（帖子流）。</p>';
}

function sparkline(hist = []) {
  if (!hist.length) return '';
  const max = Math.max(...hist, 1);
  const w = 150;
  const h = 34;
  const bars = hist
    .map((v, i) => {
      const bh = Math.max(1, (v / max) * h);
      return `<rect x="${(i * w) / hist.length}" y="${h - bh}" width="${w / hist.length - 1.2}" height="${bh}" rx="1.4" fill="${i >= hist.length * 0.75 ? '#0f7f8c' : '#cfe6e9'}" />`;
    })
    .join('');
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${bars}</svg>`;
}

function renderTopics(d) {
  const topics = d.analysis?.topics || [];
  const box = $('#topics-list');
  if (!topics.length) {
    box.innerHTML = '<div class="card"><p class="hint">还没有热点结果。先抓取帖子，再点"运行热点识别"。</p></div>';
    return;
  }
  box.innerHTML = topics
    .map(
      (t) => `<div class="card topic ${t.rising ? 'rising' : ''}" id="topic-${esc(t.key)}">
      <div class="topic-head">
        <div>
          <div class="topic-title">${esc(t.name)} ${t.rising ? '<span class="tag ok">加速中</span>' : t.growth < -0.05 ? '<span class="tag warn">热度衰减</span>' : ''}</div>
          <div class="topic-stats">
            <span>帖子 <b>${t.postCount}</b></span>
            <span>独立账号 <b>${t.accountCount}</b></span>
            <span>总互动 <b>${fmt(t.engagement)}</b></span>
            <span>环比 <b>${signed(t.growth)}</b></span>
            <span>每小时互动 <b>${Math.round(t.velocity)}</b></span>
            <span>TelyClaw 相关性 <b>${pct(t.relevance)}</b></span>
          </div>
        </div>
        <div style="text-align:right">
          ${sparkline(t.hist)}
          <div class="hint">窗外：发帖量走勢（深色=最近 25%）</div>
          <button class="btn tiny primary" style="margin-top:6px" data-gen="${esc(t.key)}">生成内容</button>
        </div>
      </div>
      <div class="topic-summary"><b>AI 摘要：</b>${esc(t.summary)}</div>
      <div class="hint" style="margin-top:8px">关键词：${(t.keywords || []).map(esc).join(' / ')} ${(t.cashtags || []).length ? '· 高频标的：' + t.cashtags.map(esc).join(' ') : ''}</div>
      <div class="hint">参与账号：${(t.accounts || []).map(esc).join('、')}</div>
      <div class="topic-posts">
        ${(t.samplePosts || [])
          .map(
            (p) => `<div class="post"><div class="meta">${esc(p.account)} · 互动 ${fmt(p.engagement)} · ${new Date(p.createdAt).toLocaleTimeString('zh-CN')}</div><div class="text">${esc(p.text)}</div></div>`
          )
          .join('')}
      </div>
    </div>`
    )
    .join('');
}

function renderRanking(d) {
  const topics = d.analysis?.topics || [];
  const w = d.config.weights || {};
  $('#weights-inline').innerHTML = Object.entries(w)
    .map(([k, v]) => `<span>${k}: ${v}</span>`)
    .join('');

  const box = $('#ranking-list');
  if (!topics.length) {
    box.innerHTML = '<div class="card"><p class="hint">还没有排序结果，先在"热点分析"里运行一次识别。</p></div>';
    return;
  }
  box.innerHTML = topics
    .map((t) => {
      const factors = Object.entries(t.factors || {})
        .map(([key, f]) => {
          return `<div class="factor">
            ${esc(f.label)}（权重 ${(f.weight * 100).toFixed(0)}%）
            <div class="bar"><i style="width:${Math.max(2, f.normalized * 100)}%"></i></div>
            <span>因子分 ${f.normalized.toFixed(2)} · 贡献 ${f.contribution} 分 · 原始值 ${Math.round(f.raw)}</span>
          </div>`;
        })
        .join('');
      return `<div class="opp ${t.rank === 1 ? 'top' : ''}">
      <div class="opp-rank">#${t.rank}</div>
      <div>
        <div class="row" style="justify-content:space-between">
          <div class="topic-title">${esc(t.name)}</div>
          <div class="row">
            <span class="score-pill">Opportunity ${t.score}</span>
            <button class="btn tiny primary" data-gen="${esc(t.key)}">生成内容</button>
          </div>
        </div>
        ${t.rank === 1 && t.verdict ? `<div class="verdict">${esc(t.verdict)}</div>` : ''}
        <div class="factors">${factors}</div>
        <div class="hint">建议切入角度：${(t.suggestedAngles || []).map(esc).join('；')}</div>
        <ul class="reasons">${(t.reasons || []).map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
      </div>
    </div>`;
    })
    .join('');
}

function renderStudio(d) {
  const topics = d.analysis?.topics || [];
  const sel = $('#studio-topic');
  const prev = sel.value;
  sel.innerHTML = topics.length
    ? topics.map((t) => `<option value="${esc(t.key)}">#${t.rank} ${esc(t.name)}（${t.score} 分）</option>`).join('')
    : '<option value="">请先运行热点识别</option>';
  if (prev && topics.some((t) => t.key === prev)) sel.value = prev;

  let drafts = d.drafts || [];
  if (!state.showAllDrafts && topics.length) {
    const topKey = topics[0].key;
    const filtered = drafts.filter((x) => x.topicKey === topKey);
    if (filtered.length) drafts = filtered;
  }

  $('#drafts-list').innerHTML = drafts.length
    ? drafts.map(draftCard).join('')
    : '<div class="card"><p class="hint">还没有草稿。选中一个热点后点"为选中热点生成内容"。</p></div>';
}

const STATUS_LABEL = {
  draft: '<span class="tag">AI 草稿</span>',
  needs_revision: '<span class="tag warn">未通过校验</span>',
  approved: '<span class="tag ok">已批准</span>',
  rejected: '<span class="tag bad">已驳回</span>',
  published: '<span class="tag ok">已发布</span>',
};

function draftCard(x) {
  const q = x.quality || {};
  const p = x.predicted || {};
  return `<div class="draft ${x.status}">
    <div class="draft-head">
      <div class="angle">${esc(x.angleLabel)} <span class="hint">· ${esc(x.topicName)}</span></div>
      <div class="row">${STATUS_LABEL[x.status] || x.status} ${x.readyToPublish ? '<span class="tag ok">可直接发布</span>' : ''}</div>
    </div>
    <textarea data-draft-text="${x.id}">${esc(x.text)}</textarea>
    <div class="qc">
      <span class="${q.originality >= 70 ? 'ok' : 'bad'}">原创度 ${q.originality ?? '—'}%</span>
      <span class="${q.charCount <= 280 ? 'ok' : 'bad'}">字数 ${q.charCount}/280</span>
      <span class="${q.maxSourceSimilarity < 0.45 ? 'ok' : 'bad'}">与源帖相似度 ${pct(q.maxSourceSimilarity, 1)}</span>
      <span class="${q.maxGramOverlap < 0.2 ? 'ok' : 'bad'}">5 词连续重复 ${pct(q.maxGramOverlap, 0)}</span>
      <span>编辑 ${x.editedCount} 次 · 来源 ${esc(x.origin)}</span>
    </div>
    ${(q.problems || []).length ? `<div class="notice bad" style="margin:0 0 8px">${q.problems.map(esc).join('；')}</div>` : ''}
    <div class="pred">预估表现（模拟）：曝光 ${fmt(p.impressions)} · 互动 ${fmt(p.engagement)} · ICP 占比 ${pct(p.icpShare)} · 合格互动 ${fmt(p.qualifiedEngagement)}</div>
    <div class="actions">
      <button class="btn tiny" data-save="${x.id}">保存人工编辑</button>
      <button class="btn tiny" data-regen="${x.id}">重新生成</button>
      <button class="btn tiny" data-approve="${x.id}">批准</button>
      <button class="btn tiny" data-reject="${x.id}">驳回</button>
      <button class="btn tiny primary" data-publish="${x.id}">发布</button>
    </div>
  </div>`;
}

function renderPublished(d) {
  const list = d.published || [];
  $('#published-list').innerHTML = list.length
    ? list
        .map(
          (p) => `<div class="pub">
      <div class="hint">${esc(p.topicName)} · ${esc(p.angleLabel)} · ${new Date(p.publishedAt).toLocaleString('zh-CN')} · ${esc(p.mode)}</div>
      <div class="text">${esc(p.text)}</div>
      <div class="pred">预估：曝光 ${fmt(p.predicted?.impressions)} · 互动 ${fmt(p.predicted?.engagement)} · 合格互动 ${fmt(p.predicted?.qualifiedEngagement)} · <a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url)}</a></div>
    </div>`
        )
        .join('')
    : '<p class="hint">还没有发布记录。在"内容工厂"里批准并发布一条草稿试试。</p>';
}

function renderSettings(d) {
  $('#set-source').value = d.config.dataSource;
  $('#set-llm').value = d.config.llmMode;
  const w = d.config.weights || {};
  const labels = {
    velocity: '热度增速 (velocity)',
    engagement: '互动规模 (engagement)',
    accounts: '参与账号数 (accounts)',
    freshness: '时效性 (freshness)',
    relevance: 'TelyClaw 相关性 (relevance)',
    contentOpportunity: '内容可生产性 (contentOpportunity)',
  };
  $('#weights-editor').innerHTML = Object.keys(labels)
    .map(
      (k) => `<label>${labels[k]}
      <input type="range" min="0" max="0.5" step="0.05" value="${w[k] ?? 0}" data-weight="${k}" />
      <output data-out="${k}">${(w[k] ?? 0).toFixed(2)}</output>
    </label>`
    )
    .join('');
  $$('#weights-editor input[type=range]').forEach((el) => {
    el.oninput = () => $(`[data-out="${el.dataset.weight}"]`).textContent = Number(el.value).toFixed(2);
  });
  $('#settings-status').innerHTML = `X Token: ${d.config.hasXToken ? '已配置' : '未配置'} · LLM Key: ${d.config.hasLlmKey ? '已配置' : '未配置'}`;
}

async function renderMetrics() {
  const m = await api('/api/metrics');
  const s = m.supporting;
  $('#metrics-body').innerHTML = `
    <div class="card">
      <div class="card-head"><h2>North Star Metric</h2><span class="hint">Qualified Engagement Generated from Trends</span></div>
      <div class="grid-4">
        <div class="stat accent"><div class="label">合格互动（北星指标）</div><div class="value">${fmt(m.northStar.value)}</div>
          <div class="sub">互动 × ICP 匹配度的加总</div></div>
        <div class="stat"><div class="label">预估曝光</div><div class="value">${fmt(m.northStar.impressions)}</div><div class="sub">已发布 ${m.northStar.publishedCount} 条</div></div>
        <div class="stat"><div class="label">预估互动</div><div class="value">${fmt(m.northStar.engagement)}</div><div class="sub">发布内容合计</div></div>
        <div class="stat"><div class="label">峰值提前发现</div><div class="value">${s.leadBeforePeakHours === null ? '—' : s.leadBeforePeakHours.toFixed(1) + 'h'}</div>
          <div class="sub">首次检测 → 话题峰值（正=提前捕捉）</div></div>
      </div>
      <p class="hint">${esc(m.northStar.definition)}</p>
      <div class="notice info" style="margin:8px 0 0">
        ⚠️ 时效类指标的口径说明：仿真数据是"上线时回填过去 7 天"，系统首次检测时间 = 你点下按钮的时间，
        所以「峰值提前发现」在这个环境里必然为负、峰值前发现率 ${s.earlyCatchRate === null ? '—' : pct(s.earlyCatchRate)}。
        它衡量的是"持续监控时能提前多久捕捉到话题"，切到真实 X API 连续采集后才有正数意义（详见 README）。
      </div>
      <div class="notice info" style="margin:10px 0 0">${esc(m.disclaimer)}</div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Supporting Metrics</h2></div>
      <div class="metric-grid">
        <div class="metric"><h4>内容产出量</h4><div class="v">${fmt(s.contentVolume.total)}</div>
          <div class="d">${Object.entries(s.contentVolume.byStatus || {}).map(([k, v]) => `${k}: ${v}`).join(' · ') || '暂无'}</div></div>
        <div class="metric"><h4>审核通过率</h4><div class="v">${s.contentAcceptanceRate === null ? '—' : pct(s.contentAcceptanceRate)}</div>
          <div class="d">已审核草稿中通过的比例（衡量 AI 草稿可用度）</div></div>
        <div class="metric"><h4>热点命中率</h4><div class="v">${s.trendHitRate === null ? '—' : pct(s.trendHitRate)}</div>
          <div class="d">发布后话题仍在升温的占比（没有追"死掉的热点"）</div></div>
        <div class="metric"><h4>峰值提前发现</h4><div class="v">${s.leadBeforePeakHours === null ? '—' : s.leadBeforePeakHours.toFixed(1) + 'h'}</div>
          <div class="d">首次检测 → 话题峰值的时间差（正=提前发现）</div></div>
        <div class="metric"><h4>互动提升（vs 基线）</h4><div class="v">${s.engagementLift === null ? '—' : signed(s.engagementLift)}</div>
          <div class="d">已发布内容预估互动 / 全量草稿均值 - 1</div></div>
        <div class="metric"><h4>角度分布</h4><div class="v">${Object.keys(s.angleMix || {}).length}</div>
          <div class="d">${Object.entries(s.angleMix || {}).map(([k, v]) => `${esc(k)}: ${v}`).join(' · ') || '暂无发布'}</div></div>
        <div class="metric"><h4>闭环漏斗</h4><div class="funnel">
            <div>热点 <b>${m.funnel.topicsDetected}</b></div>
            <div>草稿 <b>${m.funnel.draftsGenerated}</b></div>
            <div>批准 <b>${m.funnel.draftsApproved}</b></div>
            <div>发布 <b>${m.funnel.published}</b></div>
          </div></div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Top1 机会分数变化</h2><span class="hint">每次运行热点识别记一次</span></div>
      <div class="bars">${(m.scoreHistory || [])
        .map((h) => `<i class="${h.top >= 50 ? 'hot' : ''}" style="height:${Math.max(4, h.top)}%" title="${new Date(h.at).toLocaleString('zh-CN')} · 分数 ${h.top}"></i>`)
        .join('') || '<span class="hint">暂无数据</span>'}</div>
    </div>

    <div class="card">
      <div class="card-head"><h2>操作日志</h2><span class="hint">Monitor → Detect → Rank → Ideate → Craft → Review → Publish</span></div>
      <div class="log">${(m.recentEvents || [])
        .map((e) => `<div>${new Date(e.at).toLocaleString('zh-CN')} · <b>${esc(e.type)}</b> ${esc(JSON.stringify(e.detail || {}))}</div>`)
        .join('') || '<div class="hint">暂无操作</div>'}</div>
    </div>`;
}

/* ---------------- 动作 ---------------- */
async function refreshPosts() {
  const d = state.data;
  if (!d?.postCount) return;
  try {
    const res = await fetch('/api/state');
    state.data = await res.json();
  } catch {}
}

async function doIngest() {
  const btn = $('#btn-ingest');
  setBusy(btn, true, '抓取中…');
  try {
    const r = await api('/api/ingest', { window: $('#window-select').value });
    state.data = await api('/api/state');
    const snap = await api('/api/posts');
    state.posts = snap.posts;
    logLine(`[抓取] 窗口 ${r.window} · 来源 ${r.source} · 帖子 ${r.postCount} 条 · 账号 ${r.accounts} 个`);
    $('#ingest-result').textContent = `最近一次抓取：${r.postCount} 条帖子 / ${r.accounts} 个账号 / 来源 ${r.source}`;
    if (r.warnings?.length) notice(r.warnings.join('；'), 'warn');
    toast(`抓取完成：${r.postCount} 条帖子`, 'ok');
    render();
  } catch (e) {
    notice(`抓取失败：${esc(e.message)}`, 'bad');
    toast(e.message, 'bad');
  } finally {
    setBusy(btn, false);
  }
}

async function doAnalyze() {
  const btn = $('#btn-analyze');
  setBusy(btn, true, '分析中…');
  try {
    state.data = await api('/api/analyze', { window: $('#window-select').value });
    const m = metricsOf(state.data.analysis);
    $('#analyze-result').textContent = `识别出 ${m.topicCount} 个热点（${m.rising} 个加速中），基于 ${state.data.analysis.postCount} 条帖子`;
    logLine(`[热点识别] ${state.data.analysis.window} 窗口 · 话题 ${m.topicCount} 个 · Top1 分数 ${state.data.analysis.topics[0]?.score ?? '—'}`);
    toast(`识别出 ${m.topicCount} 个热点`, 'ok');
    render();
    renderMetrics().catch(() => {});
  } catch (e) {
    notice(`热点识别失败：${esc(e.message)}`, 'bad');
    toast(e.message, 'bad');
  } finally {
    setBusy(btn, false);
  }
}

async function doGenerate(topicKey) {
  const btn = $('#btn-generate');
  const key = topicKey || $('#studio-topic').value;
  if (!key) return toast('先运行热点识别，选一个话题', 'bad');
  setBusy(btn, true, '生成中…');
  try {
    const r = await api('/api/generate', { topicKey: key });
    state.data = r.state;
    logLine(`[内容生成] 话题 ${key} · 产出 ${r.drafts.length} 条草稿`);
    if (r.warnings?.length) notice(r.warnings.map(esc).join('；'), 'warn');
    toast(`已生成 ${r.drafts.length} 条草稿`, 'ok');
    switchTab('studio');
    render();
    const el = $(`#view-studio .draft`);
    if (el) el.classList.add('pulse');
  } catch (e) {
    notice(`生成失败：${esc(e.message)}`, 'bad');
    toast(e.message, 'bad');
  } finally {
    setBusy(btn, false);
  }
}

async function runAll() {
  const btn = $('#btn-run-all');
  setBusy(btn, true, '运行中…');
  try {
    await doIngest();
    await doAnalyze();
    const top = state.data?.analysis?.topics?.[0];
    if (top) {
      await doGenerate(top.key);
      logLine(`[闭环] 已为 Top1「${top.name}」生成草稿，下一步：人工审核 → 批准 → 发布`);
    }
    switchTab('studio');
  } finally {
    setBusy(btn, false);
  }
}

async function draftAction(path, body, msg) {
  try {
    const r = await api(path, body);
    state.data = await api('/api/state');
    if (msg) toast(msg, 'ok');
    render();
    renderMetrics().catch(() => {});
    return r;
  } catch (e) {
    toast(e.message, 'bad');
  }
}

/* ---------------- 演示模式 ---------------- */
const TOUR = [
  { tab: 'overview', title: '1. 先看全局', tip: '这是整条闭环：Monitor → Detect → Rank → Ideate → Craft → Review → Publish。点"运行完整流水线"一次跑通。', target: '#btn-run-all' },
  { tab: 'accounts', title: '2. 账号监控', tip: '这里配置要监控的财经类 X 账号（当前 14 个，满足"至少 5 个"的验收标准），可选 1H/4H/24H/7D 时间窗口。', target: '#btn-ingest' },
  { tab: 'trends', title: '3. AI 热点识别', tip: '系统把散乱帖子聚合成话题、自动命名、生成摘要，并判断哪些话题正在加速。', target: '#btn-analyze' },
  { tab: 'ranking', title: '4. 机会打分', tip: '讨论多 ≠ 值得跟进。这里展示 6 个因子的分数拆解和"为什么它排第一"的理由。', target: '#ranking-list' },
  { tab: 'studio', title: '5. 内容生成', tip: '每个热点生成 3 个角度（Hot Take / 干货 / 产品视角）+ 至少 1 条可直接发布的推文，并强制做原创度校验。', target: '#btn-generate' },
  { tab: 'studio', title: '6. 人工审核闭环', tip: 'AI 草稿 → 人工编辑 → 批准 → 发布。可以在文本框里改，然后批准并发布。', target: '#drafts-list' },
  { tab: 'published', title: '7. 发布记录', tip: '已发布内容与预估表现（MVP 为模拟发布；真实 X 写入是 Bonus 项）。', target: '#published-list' },
  { tab: 'metrics', title: '8. 数据看板', tip: '北星指标 = 合格互动（互动 × ICP 匹配度）；还有检测提前量、命中率、通过率、互动提升。', target: '#metrics-body' },
];

function syncTourUI() {
  const panel = $('#tour');
  if (panel.hidden) return;
  const step = TOUR[state.tourIndex];
  $('#tour-step-no').textContent = `${state.tourIndex + 1}/${TOUR.length}`;
  $('#tour-title').textContent = step.title;
  $('#tour-tip').textContent = step.tip;
  switchTab(step.tab);
  const el = $(step.target);
  if (el) {
    el.classList.remove('pulse');
    void el.offsetWidth;
    el.classList.add('pulse');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function startTour() {
  state.tourIndex = 0;
  $('#tour').hidden = false;
  syncTourUI();
}

/* ---------------- Tab ---------------- */
function switchTab(name) {
  state.tab = name;
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'metrics') renderMetrics().catch((e) => notice(esc(e.message), 'bad'));
  if (name === 'accounts') loadPostsSnapshot();
}

async function loadPostsSnapshot() {
  try {
    const snap = await api('/api/posts');
    state.posts = snap.posts;
  } catch {
    state.posts = [];
  }
  if (state.data) renderPosts(state.data);
}

/* ---------------- 事件绑定 ---------------- */
function bind() {
  $$('#tabs button').forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));

  $('#btn-run-all').onclick = runAll;
  $('#btn-only-ingest').onclick = doIngest;
  $('#btn-only-analyze').onclick = doAnalyze;
  $('#btn-ingest').onclick = doIngest;
  $('#btn-analyze').onclick = doAnalyze;
  $('#btn-generate').onclick = () => doGenerate();

  $('#window-select').onchange = () => {
    logLine(`[配置] 时间窗口切换为 ${$('#window-select').value}（需重新抓取/识别）`);
  };

  $('#btn-add-acc').onclick = async () => {
    const handle = $('#acc-handle').value.trim();
    if (!handle) return toast('请输入账号 handle', 'bad');
    try {
      const r = await api('/api/accounts', { handle, name: $('#acc-name').value, category: $('#acc-category').value });
      state.data = await api('/api/state');
      $('#acc-handle').value = $('#acc-name').value = $('#acc-category').value = '';
      toast('已添加账号', 'ok');
      render();
    } catch (e) {
      toast(e.message, 'bad');
    }
  };

  $('#btn-reset').onclick = async () => {
    if (!confirm('确定重置所有分析结果、草稿与发布记录吗？（账号配置保留）')) return;
    state.data = await api('/api/reset', {});
    toast('已重置', 'ok');
    render();
  };

  $('#show-all-drafts').onchange = (e) => {
    state.showAllDrafts = e.target.checked;
    render();
  };

  $('#btn-save-weights').onclick = async () => {
    const weights = {};
    $$('#weights-editor input[type=range]').forEach((el) => (weights[el.dataset.weight] = Number(el.value)));
    await api('/api/config', { weights });
    toast('权重已保存，正在重算排序…', 'ok');
    if (state.data?.postCount) await doAnalyze();
    render();
  };

  $('#set-source').onchange = async (e) => {
    await api('/api/config', { dataSource: e.target.value });
    state.data = await api('/api/state');
    toast(`数据源切换为 ${e.target.value}`, 'ok');
    render();
  };

  $('#set-llm').onchange = async (e) => {
    await api('/api/config', { llmMode: e.target.value });
    state.data = await api('/api/state');
    toast(`内容生成模式切换为 ${e.target.value}`, 'ok');
    render();
  };

  $('#btn-tour').onclick = startTour;
  $('#tour-close').onclick = () => ($('#tour').hidden = true);
  $('#tour-prev').onclick = () => {
    state.tourIndex = Math.max(0, state.tourIndex - 1);
    syncTourUI();
  };
  $('#tour-next').onclick = () => {
    if (state.tourIndex >= TOUR.length - 1) {
      $('#tour').hidden = true;
      toast('演示结束 🎉', 'ok');
      return;
    }
    state.tourIndex += 1;
    syncTourUI();
  };

  // 事件委托
  document.body.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const gen = t.dataset.gen;
    if (gen) return doGenerate(gen);
    if (t.dataset.toggleAcc) {
      await api('/api/accounts/toggle', { handle: t.dataset.toggleAcc });
      state.data = await api('/api/state');
      return render();
    }
    if (t.dataset.removeAcc) {
      await api('/api/accounts/remove', { handle: t.dataset.removeAcc });
      state.data = await api('/api/state');
      toast('已移除账号', 'ok');
      return render();
    }
    if (t.dataset.save) {
      const text = $(`[data-draft-text="${t.dataset.save}"]`).value;
      return draftAction('/api/draft/update', { id: t.dataset.save, text }, '已保存人工编辑');
    }
    if (t.dataset.regen) return draftAction('/api/draft/regenerate', { id: t.dataset.regen }, '已重新生成');
    if (t.dataset.approve) return draftAction('/api/draft/status', { id: t.dataset.approve, status: 'approved' }, '已批准');
    if (t.dataset.reject) return draftAction('/api/draft/status', { id: t.dataset.reject, status: 'rejected' }, '已驳回');
    if (t.dataset.publish) return draftAction('/api/draft/publish', { id: t.dataset.publish }, '已发布（模拟）');
  });
}

/* ---------------- 启动 ---------------- */
(async function init() {
  bind();
  try {
    state.data = await api('/api/state');
    render();
    loadPostsSnapshot();
  } catch (e) {
    notice(`无法连接后端：${esc(e.message)}`, 'bad');
  }
})();
