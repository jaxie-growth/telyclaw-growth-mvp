/**
 * scripts/ui-smoke.js
 * 前端冒烟测试：用 jsdom 加载真实 index.html + app.js，注入 fetch（指向本地服务），
 * 逐个切换 Tab 并触发关键按钮，捕获任何运行时异常。
 * 用法：node scripts/ui-smoke.js   （需先启动 server.js，且已在托管工作区安装 jsdom）
 */
const BASE = process.env.BASE || 'http://localhost:5173';
// jsdom 装在托管工作区（不污染项目依赖），用绝对路径导入
const JSDOM_PATH =
  process.env.JSDOM_PATH ||
  'C:/Users/13594/.workbuddy/binaries/node/workspace/node_modules/jsdom/lib/api.js';
const { JSDOM } = await import(new URL(`file:///${JSDOM_PATH.replace(/^\/+/, '')}`).href);

const errors = [];
const dom = await JSDOM.fromURL(`${BASE}/`, {
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  beforeParse(window) {
    window.fetch = (input, init) => fetch(new URL(String(input), BASE), init);
    window.confirm = () => true;
    window.scrollTo = () => {};
    window.Element.prototype.scrollIntoView = function () {};
    window.addEventListener('error', (e) => errors.push(`window error: ${e.message}`));
    window.addEventListener('unhandledrejection', (e) => errors.push(`unhandled: ${e.reason}`));
  },
});

const { window } = dom;
const { document } = window;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1500);

function assert(cond, msg) {
  if (!cond) errors.push(`断言失败: ${msg}`);
  console.log(`${cond ? '✅' : '❌'} ${msg}`);
}

const has = (sel) => Boolean(document.querySelector(sel));
const text = (sel) => (document.querySelector(sel)?.textContent || '').trim();

assert(has('#overview-stats .stat'), '概览页渲染出统计卡');
assert(document.querySelectorAll('#overview-stats .stat').length === 4, '概览有 4 张统计卡');
assert(text('#accounts-hint').includes('账号'), '账号页提示已渲染');

// 新增：身份切换 / 排期监控 / 机会提醒
assert(document.querySelectorAll('#actor-select option').length >= 4, '身份切换器有成员选项');
assert(has('#scheduler-hint') && text('#scheduler-hint').length > 0, '排期监控状态已渲染');
assert(has('#alerts-list'), '机会提醒面板已渲染');
assert(has('#sched-enabled'), '排期监控开关已渲染');
assert(has('#btn-sched-tick'), '排期"立即执行一轮"按钮已渲染');
assert(has('#studio-role-hint'), '内容工厂的角色提示已渲染');
assert(text('#studio-role-hint').includes('当前身份'), '角色提示展示了当前身份');
assert(document.querySelectorAll('#settings-status').length === 1, '设置页状态位已渲染');
assert(has('#sched-interval') && has('#sched-quiet-from') && has('#sched-override'), '排期设置表单已渲染');

// 逐个 tab 切换
for (const tab of ['accounts', 'trends', 'ranking', 'studio', 'published', 'metrics', 'settings']) {
  document.querySelector(`#tabs button[data-tab="${tab}"]`).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(600);
  const view = document.querySelector(`#view-${tab}`);
  assert(view.classList.contains('active'), `Tab 切换到 ${tab} 成功`);
}

await sleep(1200);
assert(text('#metrics-body').includes('North Star'), '数据看板渲染出 North Star 指标');
assert(document.querySelectorAll('#weights-editor input[type=range]').length === 7, '设置页有 7 个权重滑杆（含爆发动能）');

// 演示模式
document.querySelector('#btn-tour').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(400);
assert(!document.querySelector('#tour').hidden, '演示模式面板已打开');
const tourTotal = Number((text('#tour-step-no').split('/')[1] || '0').trim()) || 9;
for (let i = 0; i < tourTotal; i++) {
  document.querySelector('#tour-next').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(250);
}
assert(text('#toast').includes('演示结束') || document.querySelector('#tour').hidden, '演示模式可走完并关闭');

// 内容工厂：编辑 Agent 评审与角色闸门（需要先有草稿）
document.querySelector('#tabs button[data-tab="studio"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(400);
const drafts = document.querySelectorAll('#drafts-list .draft');
if (drafts.length) {
  assert(has('#drafts-list .review-box'), '草稿卡片渲染出编辑 Agent 评审');
  assert(document.querySelectorAll('#drafts-list .review-box .qc span').length >= 5, '评审包含 5 个维度分数');
  assert(has('#drafts-list [data-assign-select]'), '草稿卡片有审核人分配下拉');
  assert(has('#drafts-list [data-review]'), '草稿卡片有「编辑 Agent 复评」按钮');
  const disabled = [...document.querySelectorAll('#drafts-list .actions .btn[disabled]')];
  assert(disabled.length > 0, `当前身份下部分按钮被权限禁用（${disabled.length} 个）`);
} else {
  console.log('  ⏭ 当前没有草稿，跳过后半段 UI 断言');
}

console.log('\n--- 运行时错误 ---');
if (errors.length) {
  errors.forEach((e) => console.log('  ❌', e));
  process.exitCode = 1;
} else {
  console.log('  无');
}
window.close();
