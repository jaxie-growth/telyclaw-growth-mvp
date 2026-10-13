/**
 * scripts/flow-test.js —— 端到端验收：流水线 / 双口径动能 / 编辑 Agent / 多角色权限 / 排期监控
 * 用法：node scripts/flow-test.js   （需先启动 server.js）
 */
const BASE = process.env.BASE || 'http://localhost:5173';

let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

async function call(path, body, method) {
  const res = await fetch(BASE + path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

(async () => {
  console.log('\n[1] 重置 + 跑完整流水线');
  await call('/api/reset', {});
  // 重置会保留上次的身份（这是有意的：身份属于配置），但各角色权限不同，
  // 所以先切回管理员，保证"跑流水线"这一段不受残留身份影响。
  const bootState = await call('/api/state');
  const admin = (bootState.json.members || []).find((m) => m.role === 'admin');
  if (admin) await call('/api/members/actor', { memberId: admin.id });

  const ing = await call('/api/ingest', { window: '24H' });
  check('抓取成功', ing.status === 200 && ing.json.postCount > 0, `${ing.json.postCount} 条帖子 / ${ing.json.accounts} 账号`);
  const an = await call('/api/analyze', { window: '24H' });
  const topics = an.json.analysis?.topics || [];
  check('热点识别', topics.length > 0, `${topics.length} 个话题`);
  const top = topics[0];
  check('Top1 带双口径动能', Number.isFinite(top.momentum) && Number.isFinite(top.momentumRatio), `动能 ${(top.momentum * 100).toFixed(0)}% / ${top.momentumRatio.toFixed(2)}x`);
  check('Top1 带行动建议', Boolean(top.timingAdvice), top.timingAdvice?.slice(0, 30) + '…');
  const factors = Object.keys(top.factors || {});
  check('机会分数为 7 因子', factors.length === 7, factors.join(','));

  console.log('\n[2] 内容生成 + 编辑 Agent 自评');
  const gen = await call('/api/generate', { topicKey: top.key });
  const drafts = gen.json.drafts || [];
  check('生成接口返回 200', gen.status === 200, gen.json.error || '');
  check('生成 3 个角度', drafts.length === 3);
  check('≥1 条可直接发布', drafts.some((d) => d.readyToPublish));
  check('每条都有编辑 Agent 评审', drafts.every((d) => d.review && Number.isFinite(d.review.overall)),
    drafts.map((d) => d.review?.overall).join(' / '));
  check('评审给出可执行建议', drafts.every((d) => (d.review?.notes || []).length > 0));

  console.log('\n[3] 多角色权限闸门');
  const st0 = await call('/api/state');
  const members = st0.json.members || [];
  check('工作区有 4 个角色成员', members.length === 4, members.map((m) => `${m.name}(${m.roleLabel})`).join(' / '));
  const alice = members.find((m) => m.role === 'editor');
  const bob = members.find((m) => m.role === 'reviewer');
  const carol = members.find((m) => m.role === 'publisher');

  const target = drafts.find((d) => d.readyToPublish) || drafts[0];

  await call('/api/members/actor', { memberId: alice.id });
  const editorApprove = await call('/api/draft/status', { id: target.id, status: 'approved' });
  check('编辑身份无法批准（403）', editorApprove.status === 403, editorApprove.json.error?.slice(0, 46) + '…');

  await call('/api/members/actor', { memberId: carol.id });
  const pubTooEarly = await call('/api/draft/publish', { id: target.id });
  check('未批准不得发布（400）', pubTooEarly.status === 400, pubTooEarly.json.error?.slice(0, 40) + '…');

  await call('/api/members/actor', { memberId: bob.id });
  const approved = await call('/api/draft/status', { id: target.id, status: 'approved' });
  check('审核人可以批准', approved.status === 200 && approved.json.draft.status === 'approved',
    `reviewedBy=${approved.json.draft?.reviewedBy}`);

  const bobPublish = await call('/api/draft/publish', { id: target.id });
  check('审核人无发布权限（403）', bobPublish.status === 403);

  await call('/api/members/actor', { memberId: carol.id });
  const pub = await call('/api/draft/publish', { id: target.id });
  check('发布人可发布已批准草稿', pub.status === 200 && pub.json.published?.id,
    `publishedBy=${pub.json.published?.publishedBy} / reviewedBy=${pub.json.published?.reviewedBy}`);

  console.log('\n[4] 排期监控（去重 + 静默时段）');
  const sched = await call('/api/scheduler', { scheduler: { enabled: true, intervalMinutes: 30, window: '24H', alertScore: 40, quietHours: [23, 7], quietOverrideScore: 95, dedupeHours: 6 } });
  check('排期配置生效', sched.status === 200 && sched.json.scheduler.enabled === true,
    `每 ${sched.json.scheduler.intervalMinutes} 分钟 / 阈值 ${sched.json.scheduler.alertScore}`);
  const tick1 = await call('/api/scheduler/tick', {});
  const a1 = tick1.json.result?.alertsRaised ?? 0;
  check('首轮轮询产生提醒', tick1.json.result?.ok === true, `提醒 ${a1} 条 / Top 分数 ${tick1.json.result?.topScore}`);
  const tick2 = await call('/api/scheduler/tick', {});
  const a2 = tick2.json.result?.alertsRaised ?? 0;
  check('次轮被去重（不重复轰炸）', a2 === 0, `第二轮新增 ${a2} 条`);
  const stateAfter = await call('/api/state');
  check('状态里带回提醒与未读数', Array.isArray(stateAfter.json.alerts), `共 ${stateAfter.json.alerts.length} 条 / 未读 ${stateAfter.json.unreadAlerts}`);
  await call('/api/scheduler', { scheduler: { enabled: false } });
  check('排期可关闭', (await call('/api/scheduler')).json.scheduler.enabled === false);

  console.log('\n[5] 指标与统计');
  const m = await call('/api/metrics');
  check('北星指标可用', Number.isFinite(m.json.northStar?.value), `北星 ${m.json.northStar?.value} / 发布 ${m.json.funnel?.published}`);
  check('漏斗统计正常', m.json.funnel?.published >= 1, JSON.stringify(m.json.funnel));

  // 收尾：把身份切回管理员，避免把"发布人"身份留给后续操作/演示
  if (admin) await call('/api/members/actor', { memberId: admin.id });
  check('测试后身份已复位为管理员', (await call('/api/state')).json.actor?.role === 'admin');

  console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====\n`);
  process.exit(fail ? 1 : 0);
})();
