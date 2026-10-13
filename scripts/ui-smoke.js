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

// 逐个 tab 切换
for (const tab of ['accounts', 'trends', 'ranking', 'studio', 'published', 'metrics', 'settings']) {
  document.querySelector(`#tabs button[data-tab="${tab}"]`).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(600);
  const view = document.querySelector(`#view-${tab}`);
  assert(view.classList.contains('active'), `Tab 切换到 ${tab} 成功`);
}

await sleep(1200);
assert(text('#metrics-body').includes('North Star'), '数据看板渲染出 North Star 指标');
assert(document.querySelectorAll('#weights-editor input[type=range]').length === 6, '设置页有 6 个权重滑杆');

// 演示模式
document.querySelector('#btn-tour').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(400);
assert(!document.querySelector('#tour').hidden, '演示模式面板已打开');
for (let i = 0; i < 8; i++) {
  document.querySelector('#tour-next').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(250);
}
assert(text('#toast').includes('演示结束') || document.querySelector('#tour').hidden, '演示模式可走完并关闭');

console.log('\n--- 运行时错误 ---');
if (errors.length) {
  errors.forEach((e) => console.log('  ❌', e));
  process.exitCode = 1;
} else {
  console.log('  无');
}
window.close();
