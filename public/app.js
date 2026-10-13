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

/* 图标（内联 SVG，避免额外请求；统一加 .ic 兜底尺寸，防止没有上下文尺寸时被撑满容器） */
const ICONS = {
  play: '<path d="M7 4.5v15l12-7.5-12-7.5Z"/>',
  spark: '<path d="M12 3l1.9 4.9L18.8 9.8l-4.9 1.9L12 16.6l-1.9-4.9L5.2 9.8l4.9-1.9L12 3Z"/>',
  clock: '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.4V12l3.1 2"/>',
  warn: '<path d="M10.3 4 2.2 17.8A2 2 0 0 0 3.9 20.8h16.2a2 2 0 0 0 1.7-3L13.7 4a2 2 0 0 0-3.4 0Z"/><path d="M12 9.2v4"/><path d="M12 16.6h.01"/>',
  info: '<circle cx="12" cy="12" r="8.6"/><path d="M12 16.4v-4.6"/><path d="M12 7.8h.01"/>',
  target: '<circle cx="12" cy="12" r="8.6"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r=".6"/>',
  inbox: '<path d="M3.5 12.5 6 5.5h12l2.5 7v5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-5Z"/><path d="M3.5 12.5h4l1 2.5h7l1-2.5h4"/>',
};
const icon = (name, cls = '') =>
  `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
const iconFill = (name, cls = '') =>
  `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">${ICONS[name]}</svg>`;


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

  renderActor(d);
  renderNextStep(d);
  renderOverview(d);
  renderAlerts(d);
  renderAccounts(d);
  renderPosts(d);
  renderTopics(d);
  renderRanking(d);
  renderStudio(d);
  renderPublished(d);
  renderTabBadges(d);
  renderSettings(d);
  syncTourUI();
}

/* ---------------- 下一步该做什么（按状态给出唯一建议） ---------------- */
function renderNextStep(d) {
  const box = $('#next-step');
  if (!box) return;
  const m = metricsOf(d.analysis);
  const drafts = d.drafts || [];
  const pending = drafts.filter((x) => ['draft', 'needs_revision'].includes(x.status));
  const approved = drafts.filter((x) => x.status === 'approved');
  const published = d.published || [];

  let step;
  if (!(d.accounts || []).length) {
    step = { text: '还没有监控账号。去「账号监控」添加要盯的 X 账号。', label: '去添加账号', action: () => switchTab('accounts') };
  } else if (!d.postCount) {
    step = { text: '数据源已就绪，但还没有抓取到帖子。先跑一次抓取建立基线。', label: '抓取帖子', action: () => doIngest() };
  } else if (!m.topicCount) {
    step = { text: `已抓取 ${fmt(d.postCount)} 条帖子，但还没做热点识别。运行识别才能得到机会排序。`, label: '运行热点识别', action: () => doAnalyze() };
  } else if (!drafts.length) {
    step = { text: `识别出 ${m.topicCount} 个热点（${m.rising} 个在加速）。现在为 Top1 生成多角度草稿。`, label: '生成内容', action: () => doGenerate(d.analysis.topics[0]?.key) };
  } else if (pending.length) {
    step = { text: `有 ${pending.length} 条草稿待审核。审核通过后发布人才发得出去。`, label: '去审核草稿', action: () => switchTab('studio') };
  } else if (approved.length) {
    step = { text: `有 ${approved.length} 条已批准待发布。切换为发布人身份即可发出。`, label: '去发布', action: () => switchTab('studio') };
  } else if (published.length) {
    step = { text: `闭环已跑通，共发布 ${published.length} 条。去数据看板复盘命中率与北星指标。`, label: '看数据看板', action: () => switchTab('metrics') };
  } else {
    step = { text: '运行完整流水线，一次走完 监控 → 识别 → 排序 → 生成。', label: '运行流水线', action: () => runAll() };
  }

  box.innerHTML = `<span class="icon">${iconFill('spark')}</span>
    <div class="grow"><div class="label">下一步建议</div><div class="text">${esc(step.text)}</div></div>
    <button class="btn primary" id="btn-next-step">${esc(step.label)}</button>`;
  $('#btn-next-step').onclick = step.action;
}

/* ---------------- 页签徽标 ---------------- */
function renderTabBadges(d) {
  const set = (tab, value) => {
    const el = $(`#tab-badge-${tab}`);
    if (!el) return;
    el.textContent = value;
    el.hidden = !value;
  };
  set('accounts', (d.accounts || []).length);
  set('trends', (d.analysis?.topics || []).length);
  set('studio', (d.drafts || []).length);
  set('published', (d.published || []).length);

  // 内容工厂的流程条：点亮已经走到的环节
  const drafts = d.drafts || [];
  const reached = {
    Trend: Boolean(d.analysis?.topics?.length),
    'AI Draft': drafts.length > 0,
    'Editor Agent 自评': drafts.some((x) => x.review),
    'Human Edit': drafts.some((x) => x.editedCount > 0),
    'Reviewer 批准': drafts.some((x) => ['approved', 'published'].includes(x.status)),
    'Publisher 发布': (d.published || []).length > 0,
  };
  $$('#review-flow span').forEach((el) => el.classList.toggle('on', Boolean(reached[el.textContent.trim()])));
}


/** 当前身份（决定能点哪些按钮） */
function renderActor(d) {
  const sel = $('#actor-select');
  const members = d.members || [];
  const prev = sel.value;
  sel.innerHTML = members
    .map((m) => `<option value="${esc(m.id)}">${esc(m.name)}（${esc(m.roleLabel)}）</option>`)
    .join('');
  if (d.actor) sel.value = d.actor.id;
  else if (prev) sel.value = prev;
}

/** 当前身份是否具备某项权限 */
function canDo(action) {
  const a = state.data?.actor;
  return Boolean(a && Array.isArray(a.can) && a.can.includes(action));
}

const PERM_HINT = {
  generate: '需要「内容编辑」或「管理员」身份',
  edit: '需要「内容编辑」「审核人」或「管理员」身份',
  approve: '需要「审核人」或「管理员」身份',
  reject: '需要「审核人」或「管理员」身份',
  publish: '需要「发布人」或「管理员」身份',
  assign: '需要「内容编辑」「审核人」或「管理员」身份',
};

/* ---------------- 排期监控 & 机会提醒 ---------------- */
function renderAlerts(d) {
  const sch = d.scheduler || {};
  const alerts = d.alerts || [];
  const unread = d.unreadAlerts || 0;

  const badge = $('#alert-badge');
  badge.hidden = unread === 0;
  badge.textContent = unread;
  $('#btn-alerts').classList.toggle('has-unread', unread > 0);

  $('#sched-enabled').checked = Boolean(sch.enabled);
  $('#scheduler-hint').textContent = sch.enabled
    ? `运行中 · 每 ${sch.intervalMinutes} 分钟一轮（窗口 ${sch.window}）· 已轮询 ${sch.tickCount} 次 · 上次 ${relTime(sch.lastTickAt)}`
    : `已停止 · 上次轮询 ${sch.tickCount ? relTime(sch.lastTickAt) : '从未执行'}${sch.lastError ? ' · 错误：' + sch.lastError : ''}`;

  $('#alerts-list').innerHTML = alerts.length
    ? alerts
        .map(
          (a) => `<div class="alert ${a.read ? 'read' : ''} ${a.surging ? 'surging' : ''}">
        <div class="alert-head">
          <div class="who">
            <b>${esc(a.topicName)}</b>
            ${a.surging ? '<span class="tag ok">正在起爆</span>' : ''}
            <span class="score-pill"><b>${a.score}</b>分</span>
          </div>
          <div class="hint">${relTime(a.at)}${a.read ? ' · 已读' : ''}</div>
        </div>
        <div class="hint">${esc(a.reason || '')}</div>
        ${a.timingAdvice ? `<div class="callout">${icon('clock')}<span><b>行动建议</b>：${esc(a.timingAdvice)}</span></div>` : ''}
        <div class="row">
          <button class="btn tiny primary" data-gen="${esc(a.topicKey)}">为该热点生成内容</button>
          ${a.read ? '' : `<button class="btn tiny" data-alert-read="${esc(a.id)}">标记已读</button>`}
        </div>
      </div>`
        )
        .join('')
    : `<div class="empty">${icon('inbox')}<div>还没有提醒</div>
       <div class="hint">打开上面的「启用定时轮询」后点「立即执行一轮」，或等待下一次自动轮询——只有分数达到阈值的<strong>新</strong>机会才会出现在这里。</div></div>`;
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
             <div class="topic-title">#1 ${esc(top.name)} ${
               top.surging ? '<span class="tag ok">正在起爆</span>' : top.rising ? '<span class="tag ok">加速中</span>' : ''
             }</div>
             <div class="topic-stats">
               <span>机会分数 <b>${top.score}</b></span>
               <span>帖子 <b>${top.postCount}</b></span>
               <span>账号 <b>${top.accountCount}</b></span>
               <span>环比 <b>${signed(top.growth)}</b></span>
               <span>短窗动能 <b>${Number.isFinite(top.momentumRatio) ? top.momentumRatio.toFixed(1) + 'x' : '—'}</b></span>
             </div>
           </div>
           <button class="btn primary" data-gen="${esc(top.key)}">为它生成内容</button>
         </div>
         <div class="topic-summary">${esc(top.summary)}</div>
         ${top.verdict ? `<div class="verdict">${icon('target')}<span>${esc(top.verdict)}</span></div>` : ''}
         ${top.timingAdvice ? `<div class="callout">${icon('clock')}<span><b>时效建议</b>：${esc(top.timingAdvice)}</span></div>` : ''}
       </div>`
    : `<div class="empty">${icon('inbox')}<div>还没有分析结果</div><div class="hint">先在上方点「运行完整流水线」。</div></div>`;
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

const avatar = (handle = '') => esc(String(handle).replace(/^@/, '').slice(0, 2) || '?');

function renderPosts(d) {
  const posts = (state.posts || []).slice(0, 40);
  $('#posts-list').innerHTML = posts.length
    ? posts
        .map(
          (p) => `<div class="post">
        <div class="avatar" aria-hidden="true">${avatar(p.account)}</div>
        <div class="body">
          <div class="meta"><b>${esc(p.account)}</b>${p.category ? ' · ' + esc(p.category) : ''} · ${new Date(p.createdAt).toLocaleString('zh-CN')} · 互动 ${fmt(p.engagement)}</div>
          <div class="text">${esc(p.text)}</div>
        </div>
      </div>`
        )
        .join('')
    : `<div class="empty">${icon('inbox')}<div>还没有抓取到帖子</div><div class="hint">点击上方「抓取当前窗口帖子」后，这里会显示原始证据（帖子流）。</div></div>`;
}

function sparkline(hist = []) {
  if (!hist.length) return '';
  const max = Math.max(...hist, 1);
  const w = 150;
  const h = 36;
  const cut = hist.length * 0.75;
  const bars = hist
    .map((v, i) => {
      const bh = Math.max(1.5, (v / max) * (h - 4));
      return `<rect class="spark-bar${i >= cut ? ' hot' : ''}" x="${(i * w) / hist.length}" y="${h - bh}" width="${Math.max(1, w / hist.length - 1.4)}" height="${bh}" rx="1.6" />`;
    })
    .join('');
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="发帖量走势">${bars}</svg>`;
}

function renderTopics(d) {
  const topics = d.analysis?.topics || [];
  const box = $('#topics-list');
  if (!topics.length) {
    box.innerHTML = `<div class="card"><div class="empty">${icon('inbox')}<div>还没有热点结果</div><div class="hint">先到「账号监控」抓取帖子，再回到这里点「运行热点识别」。</div></div></div>`;
    return;
  }
  box.innerHTML = topics
    .map(
      (t) => `<div class="card topic ${t.rising ? 'rising' : ''}" id="topic-${esc(t.key)}">
      <div class="topic-head">
        <div style="min-width:0">
          <div class="topic-title">#${t.rank} ${esc(t.name)} ${
            t.surging
              ? '<span class="tag ok">正在起爆</span>'
              : t.rising
                ? '<span class="tag ok">加速中</span>'
                : t.growth < -0.05
                  ? '<span class="tag warn">热度衰减</span>'
                  : ''
          }</div>
          <div class="topic-stats">
            <span>机会分数 <b>${t.score}</b></span>
            <span>帖子 <b>${t.postCount}</b></span>
            <span>独立账号 <b>${t.accountCount}</b></span>
            <span>总互动 <b>${fmt(t.engagement)}</b></span>
            <span>环比 <b>${signed(t.growth)}</b></span>
            <span>短窗动能 <b>${Number.isFinite(t.momentumRatio) ? t.momentumRatio.toFixed(1) + 'x' : '—'}</b></span>
            <span>每小时互动 <b>${Math.round(t.velocity)}</b></span>
            <span>TelyClaw 相关性 <b>${pct(t.relevance)}</b></span>
          </div>
        </div>
        <div class="spark-box">
          ${sparkline(t.hist)}
          <div class="hint">窗口内发帖量走势（深色 = 最近 25%）</div>
          <button class="btn tiny primary" data-gen="${esc(t.key)}">生成内容</button>
        </div>
      </div>
      <div class="topic-summary"><b>AI 摘要：</b>${esc(t.summary)}</div>
      <div class="chips" style="margin-top:10px">
        <span class="chips-label">关键词</span>
        ${(t.keywords || []).map((k) => `<span>${esc(k)}</span>`).join('')}
        ${(t.cashtags || []).length ? `<span class="chips-label" style="margin-left:6px">高频标的</span>${t.cashtags.map((c) => `<span class="cash">${esc(c)}</span>`).join('')}` : ''}
      </div>
      <div class="meta-line">参与账号：<b>${(t.accounts || []).map(esc).join('、')}</b></div>
      <div class="topic-posts">
        ${(t.samplePosts || [])
          .map(
            (p) => `<div class="post">
            <div class="avatar" aria-hidden="true">${avatar(p.account)}</div>
            <div class="body">
              <div class="meta"><b>${esc(p.account)}</b> · 互动 ${fmt(p.engagement)} · ${new Date(p.createdAt).toLocaleTimeString('zh-CN')}</div>
              <div class="text">${esc(p.text)}</div>
            </div>
          </div>`
          )
          .join('')}
      </div>
    </div>`
    )
    .join('');
}

/* 权重因子的中文名（设置页与排序页共用，避免两处不一致） */
const WEIGHT_LABELS = {
  momentum: '爆发动能 momentum',
  velocity: '热度增速 velocity',
  engagement: '互动规模 engagement',
  accounts: '参与账号数 accounts',
  freshness: '时效性 freshness',
  relevance: 'TelyClaw 相关性 relevance',
  contentOpportunity: '内容可生产性 contentOpportunity',
};

function renderRanking(d) {
  const topics = d.analysis?.topics || [];
  const w = d.config.weights || {};
  $('#weights-inline').innerHTML = Object.entries(w)
    .map(([k, v]) => `<span>${esc((WEIGHT_LABELS[k] || k).split(' ')[0])} <b>${v}</b></span>`)
    .join('');

  const box = $('#ranking-list');
  if (!topics.length) {
    box.innerHTML = `<div class="card"><div class="empty">${icon('inbox')}<div>还没有排序结果</div><div class="hint">先在「热点分析」里运行一次识别。</div></div></div>`;
    return;
  }
  box.innerHTML = topics
    .map((t) => {
      const factors = Object.entries(t.factors || {})
        .map(([key, f]) => {
          // 不同量纲的原始值用不同格式，否则 0.78 会被四舍五入成 "1" 看不出差别
          const rawText =
            key === 'momentum' || key === 'relevance' || key === 'freshness' || key === 'contentOpportunity'
              ? `${(f.raw * 100).toFixed(0)}%`
              : Number(f.raw).toLocaleString('en-US');
          return `<div class="factor">
            <div class="factor-top"><span>${esc(f.label)}</span><b>${f.normalized.toFixed(2)}</b></div>
            <div class="factor-bar"><i style="width:${Math.max(2, f.normalized * 100)}%"></i></div>
            <div class="factor-meta">权重 ${(f.weight * 100).toFixed(0)}% · 贡献 ${f.contribution} 分 · 原始值 ${rawText}</div>
          </div>`;
        })
        .join('');
      return `<div class="opp ${t.rank === 1 ? 'top' : ''}">
      <div class="opp-rank">
        <div class="rank-badge">#${t.rank}</div>
        <div class="hint">${t.rank === 1 ? 'Top 机会' : '排名'}</div>
      </div>
      <div>
        <div class="row" style="justify-content:space-between;align-items:flex-start">
          <div class="opp-title">${esc(t.name)}</div>
          <div class="row" style="gap:8px">
            <span class="score-pill"><b>${t.score}</b>分</span>
            <button class="btn tiny primary" data-gen="${esc(t.key)}">生成内容</button>
          </div>
        </div>
        ${t.rank === 1 && t.verdict ? `<div class="verdict">${icon('target')}<span>${esc(t.verdict)}</span></div>` : ''}
        ${t.timingAdvice ? `<div class="callout">${icon('clock')}<span><b>时效建议</b>：${esc(t.timingAdvice)}</span></div>` : ''}
        <div class="factors">${factors}</div>
        <div class="hint" style="margin-top:13px">建议切入角度：${(t.suggestedAngles || []).map(esc).join('；')}</div>
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
    : `<div class="card"><div class="empty">${icon('inbox')}<div>还没有草稿</div><div class="hint">在上方选中一个热点，点「为选中热点生成内容」。</div></div></div>`;

  const a = d.actor;
  const permLabels = { generate: '生成', edit: '编辑', approve: '批准', reject: '驳回', publish: '发布', assign: '分配' };
  $('#studio-role-hint').innerHTML = a
    ? `当前身份：<b>${esc(a.name)}</b>（${esc(a.roleLabel)}）· 可执行：${(a.can || []).map((c) => permLabels[c] || c).join(' / ')} · 右上角可切换身份。<b>作者 / 审核人 / 发布人分离</b>：发布前必须由审核人批准，发布人无法绕开审核。`
    : '';
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
  const r = x.review || null;
  const members = state.data?.members || [];
  const assignee = members.find((m) => m.id === x.assignedTo);
  const reviewer = members.find((m) => m.id === x.reviewedBy);
  const guardAttr = (action) =>
    canDo(action) ? '' : `disabled title="${esc(PERM_HINT[action] || '当前身份无权限')}"`;

  // 发布闸门在前端也如实反映：未批准 + 无发布权限，两条都拦
  const publishBlocked = !canDo('publish')
    ? PERM_HINT.publish
    : x.status !== 'approved'
      ? '需要先由审核人批准'
      : '';

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

    ${
      r
        ? `<div class="review-box">
      <div class="review-head">
        <span><b>编辑 Agent 评审</b> <span class="score-pill">${r.overall} 分 · ${esc(r.verdictLabel)}</span></span>
        <span class="hint">来源 ${esc(r.origin === 'llm' ? 'LLM 评审' : '规则评审')}</span>
      </div>
      <div class="qc">${(r.dimensions || [])
        .map((dim) => `<span class="${dim.score >= 70 ? 'ok' : dim.score >= 55 ? '' : 'bad'}">${esc(dim.label)} ${dim.score}</span>`)
        .join('')}</div>
      <ul class="reasons">${(r.notes || []).map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
    </div>`
        : '<div class="hint">该草稿还没有编辑 Agent 评审，点下面的「编辑 Agent 复评」生成。</div>'
    }

    <div class="pred">预估表现（模拟）：曝光 <b>${fmt(p.impressions)}</b> · 互动 <b>${fmt(p.engagement)}</b> · ICP 占比 <b>${pct(p.icpShare)}</b> · 合格互动 <b>${fmt(p.qualifiedEngagement)}</b></div>

    <div class="assign-row">
      <span class="hint">审核人分配</span>
      <select data-assign-select="${x.id}" ${canDo('assign') ? '' : 'disabled'}>
        <option value="">— 未分配 —</option>
        ${members
          .filter((m) => m.role !== 'publisher')
          .map((m) => `<option value="${esc(m.id)}" ${x.assignedTo === m.id ? 'selected' : ''}>${esc(m.name)}（${esc(m.roleLabel)}）</option>`)
          .join('')}
      </select>
      <span class="hint">${assignee ? '已分配给 <b>' + esc(assignee.name) + '</b>' : '未指派'}${
        reviewer ? ' · 批准人 ' + esc(reviewer.name) : ''
      }${x.publishedBy ? ' · 发布人 ' + esc(members.find((m) => m.id === x.publishedBy)?.name || '—') : ''}</span>
    </div>

    <div class="actions">
      <button class="btn tiny" data-save="${x.id}" ${guardAttr('edit')}>保存人工编辑</button>
      <button class="btn tiny" data-review="${x.id}">编辑 Agent 复评</button>
      <button class="btn tiny" data-regen="${x.id}" ${guardAttr('generate')}>重新生成</button>
      <span class="spacer"></span>
      <button class="btn tiny" data-approve="${x.id}" ${guardAttr('approve')}>批准</button>
      <button class="btn tiny" data-reject="${x.id}" ${guardAttr('reject')}>驳回</button>
      <button class="btn tiny primary" data-publish="${x.id}" ${publishBlocked ? `disabled title="${esc(publishBlocked)}"` : ''}>发布</button>
    </div>
  </div>`;
}

function renderPublished(d) {
  const list = d.published || [];
  $('#published-list').innerHTML = list.length
    ? list
        .map(
          (p) => `<div class="pub">
      <div class="hint">${esc(p.topicName)} · ${esc(p.angleLabel)} · ${new Date(p.publishedAt).toLocaleString('zh-CN')} · ${esc(p.mode)}${
        p.reviewedBy ? ` · 审核：${esc(p.reviewedBy)}` : ''
      }${p.publishedBy ? ` · 发布：${esc(p.publishedBy)}` : ''}</div>
      <div class="text">${esc(p.text)}</div>
      <div class="pred">预估：曝光 ${fmt(p.predicted?.impressions)} · 互动 ${fmt(p.predicted?.engagement)} · 合格互动 ${fmt(p.predicted?.qualifiedEngagement)} · <a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url)}</a></div>
    </div>`
        )
        .join('')
    : `<div class="card"><div class="empty">${icon('inbox')}<div>还没有发布记录</div><div class="hint">在「内容工厂」里由审核人批准、再由发布人发出一条草稿试试。</div></div></div>`;
}

function renderSettings(d) {
  $('#set-source').value = d.config.dataSource;
  $('#set-llm').value = d.config.llmMode;
  const w = d.config.weights || {};
  $('#weights-editor').innerHTML = Object.keys(WEIGHT_LABELS)
    .map(
      (k) => `<label>${esc(WEIGHT_LABELS[k])}
      <div class="slider-row">
        <input type="range" min="0" max="0.5" step="0.05" value="${w[k] ?? 0}" data-weight="${k}" aria-label="${esc(WEIGHT_LABELS[k])}" />
        <output data-out="${k}">${(w[k] ?? 0).toFixed(2)}</output>
      </div>
    </label>`
    )
    .join('');
  $$('#weights-editor input[type=range]').forEach((el) => {
    el.oninput = () => $(`[data-out="${el.dataset.weight}"]`).textContent = Number(el.value).toFixed(2);
  });
  $('#settings-status').innerHTML = `X Token: ${d.config.hasXToken ? '已配置' : '未配置'} · LLM Key: ${d.config.hasLlmKey ? '已配置' : '未配置'}`;

  // 排期监控设置
  const sch = d.scheduler || d.config.scheduler || {};
  $('#sched-interval').value = sch.intervalMinutes ?? 30;
  $('#sched-window').value = sch.window ?? '4H';
  $('#sched-threshold').value = sch.alertScore ?? 55;
  $('#sched-dedupe').value = sch.dedupeHours ?? 6;
  $('#sched-quiet-from').value = (sch.quietHours || [23, 7])[0];
  $('#sched-quiet-to').value = (sch.quietHours || [23, 7])[1];
  $('#sched-override').value = sch.quietOverrideScore ?? 80;
  $('#sched-status').innerHTML = `${sch.running ? '🟢 轮询中' : '⚪️ 已停止'} · 已轮询 ${sch.tickCount || 0} 次${
    sch.lastTickAt ? ' · 上次 ' + relTime(sch.lastTickAt) : ''
  } · 当前${sch.quietNow ? '<b>处于静默时段</b>（低于破例阈值的提醒会被抑制）' : '非静默时段'}`;
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
      <div class="notice warn" style="margin:10px 0 0">
        ${icon('warn')}
        <span>时效类指标的口径说明：仿真数据是「上线时回填过去 7 天」，系统首次检测时间 = 你点下按钮的时间，
        所以「峰值提前发现」在这个环境里必然为负、峰值前发现率 ${s.earlyCatchRate === null ? '—' : pct(s.earlyCatchRate)}。
        它衡量的是「持续监控时能提前多久捕捉到话题」，切到真实 X API 连续采集后才有正数意义（详见 README）。</span>
      </div>
      <div class="notice info" style="margin:10px 0 0">${icon('info')}<span>${esc(m.disclaimer)}</span></div>
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
  { tab: 'overview', title: '2. 无人值守：排期监控', tip: '热点窗口只有几小时，人不可能一直盯屏。打开定时轮询后系统自己跑；只有在出现"新高分机会"时才提醒你，同一话题 6 小时内不重复打扰，夜间静默但真爆点破例放行。', target: '#alerts-list' },
  { tab: 'accounts', title: '3. 账号监控', tip: '这里配置要监控的财经类 X 账号（当前 14 个，满足"至少 5 个"的验收标准），可选 1H/4H/24H/7D 时间窗口。', target: '#btn-ingest' },
  { tab: 'trends', title: '4. AI 热点识别', tip: '系统把散乱帖子聚合成话题、自动命名、生成摘要。注意"短窗动能"——它用最近短窗对比整窗基线，专门用来区分"一直很热"和"刚刚开始爆"。', target: '#btn-analyze' },
  { tab: 'ranking', title: '5. 机会打分', tip: '讨论多 ≠ 值得跟进。这里展示 7 个因子的分数拆解（含爆发动能）、"为什么它排第一"的理由，以及一条可执行的时效建议。', target: '#ranking-list' },
  { tab: 'studio', title: '6. 生成 + 编辑 Agent 自评', tip: '每个热点生成 3 个角度；生成后另有一个"编辑 Agent"从钩子/具体性/原创度/受众/清晰度五个维度打分并给出可执行的修改建议——把"读一遍找毛病"这件事也交给机器。', target: '#btn-generate' },
  { tab: 'studio', title: '7. 人工审核 + 角色分离', tip: '作者 / 审核人 / 发布人分离：右上角切换身份，Alice（编辑）批不了、Carol（发布人）没批准也发不了——权限在服务端强制校验，不是前端把按钮变灰而已。', target: '#studio-role-hint' },
  { tab: 'published', title: '8. 发布记录', tip: '每条发布都记录"谁审核的、谁发布的"（MVP 为模拟发布；真实 X 写入是 Bonus 项）。', target: '#published-list' },
  { tab: 'metrics', title: '9. 数据看板', tip: '北星指标 = 合格互动（互动 × ICP 匹配度）；还有检测提前量、命中率、通过率、互动提升。', target: '#metrics-body' },
];

function syncTourUI() {
  const panel = $('#tour');
  if (panel.hidden) return;
  const step = TOUR[state.tourIndex];
  $('#tour-step-no').textContent = `${state.tourIndex + 1}/${TOUR.length}`;
  $('#tour-title').textContent = step.title;
  $('#tour-tip').textContent = step.tip;
  const bar = $('#tour-progress-i');
  if (bar) bar.style.width = `${((state.tourIndex + 1) / TOUR.length) * 100}%`;
  const dots = $('#tour-dots');
  if (dots) dots.innerHTML = TOUR.map((_, i) => `<i class="${i === state.tourIndex ? 'on' : ''}"></i>`).join('');
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
const TAB_NAMES = ['overview', 'accounts', 'trends', 'ranking', 'studio', 'published', 'metrics', 'settings'];

function switchTab(name, syncHash = true) {
  if (!TAB_NAMES.includes(name)) name = 'overview';
  state.tab = name;
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  // 把当前页签写进 URL：刷新不丢上下文，也方便直接把某一页发给别人
  if (syncHash && location.hash.slice(1) !== name) {
    try { history.replaceState(null, '', `#${name}`); } catch { location.hash = name; }
  }
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

  /* ---- 团队审核：切换当前身份 ---- */
  $('#actor-select').onchange = async (e) => {
    try {
      state.data = await api('/api/members/actor', { memberId: e.target.value });
      const a = state.data.actor;
      toast(`已切换为 ${a.name}（${a.roleLabel}）`, 'ok');
      render();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  /* ---- 排期监控 ---- */
  $('#btn-alerts').onclick = () => {
    switchTab('overview');
    const el = $('#alerts-list');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('pulse');
    void el.offsetWidth;
    el.classList.add('pulse');
  };

  $('#sched-enabled').onchange = async (e) => {
    try {
      const r = await api('/api/scheduler', { scheduler: { enabled: e.target.checked } });
      state.data = await api('/api/state');
      toast(r.scheduler.enabled ? '已开启排期监控（后台无人值守轮询）' : '已停止排期监控', 'ok');
      render();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  $('#btn-sched-tick').onclick = async () => {
    const btn = $('#btn-sched-tick');
    setBusy(btn, true, '轮询中…');
    try {
      const r = await api('/api/scheduler/tick', {});
      state.data = r.state;
      const s = r.result;
      if (s.ok) {
        logLine(`[排期监控] 窗口 ${s.window} · 帖子 ${s.postCount} · 话题 ${s.topicCount} · Top1 ${s.topScore ?? '—'} · 新增提醒 ${s.alertsRaised} 条${s.suppressedByQuietHours ? `（静默时段抑制 ${s.suppressedByQuietHours} 条）` : ''}`);
        toast(`轮询完成：新增提醒 ${s.alertsRaised} 条`, 'ok');
      } else {
        toast(`轮询失败：${s.error}`, 'bad');
      }
      render();
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setBusy(btn, false);
    }
  };

  $('#btn-save-scheduler').onclick = async () => {
    const num = (sel, dflt) => {
      const v = Number($(sel).value);
      return Number.isFinite(v) && v > 0 ? v : dflt;
    };
    const payload = {
      scheduler: {
        intervalMinutes: num('#sched-interval', 30),
        window: $('#sched-window').value,
        alertScore: num('#sched-threshold', 55),
        dedupeHours: num('#sched-dedupe', 6),
        quietHours: [Number($('#sched-quiet-from').value) || 0, Number($('#sched-quiet-to').value) || 0],
        quietOverrideScore: num('#sched-override', 80),
      },
    };
    try {
      await api('/api/scheduler', payload);
      state.data = await api('/api/state');
      toast('排期设置已保存并生效', 'ok');
      render();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  $('#btn-tour').onclick = startTour;
  $('#tour-close').onclick = () => ($('#tour').hidden = true);  $('#tour-prev').onclick = () => {
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
    if (t.dataset.review) return draftAction('/api/draft/review', { id: t.dataset.review }, '编辑 Agent 已复评');
    if (t.dataset.approve) return draftAction('/api/draft/status', { id: t.dataset.approve, status: 'approved' }, '已批准');
    if (t.dataset.reject) return draftAction('/api/draft/status', { id: t.dataset.reject, status: 'rejected' }, '已驳回');
    if (t.dataset.publish) return draftAction('/api/draft/publish', { id: t.dataset.publish }, '已发布（模拟）');
    if (t.dataset.alertRead) {
      const r = await api('/api/alerts/read', { id: t.dataset.alertRead });
      state.data.alerts = r.alerts;
      state.data.unreadAlerts = r.alerts.filter((a) => !a.read).length;
      return render();
    }
  });

  // 审核人分配（下拉框）
  document.body.addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-assign-select]');
    if (!sel) return;
    try {
      await api('/api/draft/assign', { id: sel.dataset.assignSelect, memberId: sel.value });
      state.data = await api('/api/state');
      toast(sel.value ? '已分配审核人' : '已取消分配', 'ok');
      render();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });

  /* ---- 键盘快捷键：让演示与日常操作都不用找鼠标 ---- */
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') {
      if (!$('#tour').hidden) $('#tour').hidden = true;
      return;
    }
    if (e.key === '?') {
      toast('快捷键：1–8 切换页签 · R 运行流水线 · G 生成内容 · T 演示模式 · Esc 关闭演示');
      return;
    }
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1 && n <= TAB_NAMES.length) {
      switchTab(TAB_NAMES[n - 1]);
      return;
    }
    const k = e.key.toLowerCase();
    if (k === 'r') return void runAll();
    if (k === 'g') return void doGenerate();
    if (k === 't') return void startTour();
  });

  // 支持手改地址栏 hash 直接跳到某一页
  window.addEventListener('hashchange', () => switchTab(location.hash.slice(1), false));
}

/* ---------------- 启动 ---------------- */
(async function init() {
  bind();
  try {
    state.data = await api('/api/state');
    render();
    const initial = (location.hash || '').slice(1);
    if (initial) switchTab(initial);
    loadPostsSnapshot();
  } catch (e) {
    notice(`无法连接后端：${esc(e.message)}`, 'bad');
  }
})();
