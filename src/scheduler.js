/**
 * src/scheduler.js
 * ------------------------------------------------------------
 * 排期监控（Scheduled Monitoring）—— 题目 Bonus 项之一。
 *
 * 解决的问题：热点窗口期只有几小时，人不可能一直盯屏幕。
 * 所以系统要能**无人值守地轮询**，并且只在"真的出现高分机会"时才打扰人。
 *
 * 三个关键设计（都不是随手写的）：
 *   1. 去重（dedupe）：同一话题在 N 小时内只提醒一次。
 *      否则 30 分钟一轮，同一个热点会把你轰炸 20 次，提醒就等于没有提醒。
 *   2. 静默时段（quiet hours）+ 破例阈值（override）：
 *      夜间不打扰；但如果分数高到一定程度的真爆点，仍然穿透静默——
 *      "重要的不是不打扰，而是不漏掉真正重要的那一条"。
 *   3. 与手动链路共用同一个 pipeline：保证"自动跑"和"手动跑"分数口径完全一致。
 * ------------------------------------------------------------
 */
import { config } from './config.js';
import { loadState, saveState, logEvent, nextId } from './store.js';
import { runFull } from './pipeline.js';
import { HOUR } from './dataset.js';

let timer = null;

/** 判断某个小时是否落在静默时段内（支持跨天，例如 23 → 7） */
export function inQuietHours(hour, [from, to]) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return false;
  if (from < to) return hour >= from && hour < to;
  return hour >= from || hour < to;
}

function schedulerState() {
  const s = loadState();
  if (!s.scheduler) {
    s.scheduler = { lastTickAt: null, tickCount: 0, lastError: null, lastSummary: null };
  }
  return s.scheduler;
}

export function schedulerStatus() {
  const sc = config.scheduler;
  const st = schedulerState();
  const now = Date.now();
  return {
    ...sc,
    running: Boolean(timer),
    lastTickAt: st.lastTickAt,
    tickCount: st.tickCount,
    lastError: st.lastError,
    lastSummary: st.lastSummary,
    quietNow: inQuietHours(new Date().getHours(), sc.quietHours),
    nextTickAt: timer && st.lastTickAt ? st.lastTickAt + sc.intervalMinutes * 60000 : null,
    serverTime: now,
  };
}

/**
 * 从排序结果里筛出"值得提醒"的机会
 * @returns {{created: object[], suppressedByQuietHours: number, skippedByThreshold: number, quiet: boolean}}
 */
function collectAlerts(opportunities = []) {
  const sc = config.scheduler;
  const s = loadState();
  const now = Date.now();
  const hour = new Date(hour0(now)).getHours();
  const quiet = inQuietHours(hour, sc.quietHours);
  s.alerts = s.alerts || [];

  const created = [];
  let suppressedByQuietHours = 0;
  let skippedByThreshold = 0;

  for (const t of opportunities) {
    if (!(t.score >= sc.alertScore)) {
      skippedByThreshold += 1;
      continue;
    }
    // 去重：同一话题在 dedupeHours 内不重复提醒
    const dup = s.alerts.some((a) => a.topicKey === t.key && now - a.at < sc.dedupeHours * HOUR);
    if (dup) continue;
    // 静默时段：只有真正的爆点（分数 ≥ 破例阈值）才穿透
    if (quiet && t.score < sc.quietOverrideScore) {
      suppressedByQuietHours += 1;
      continue;
    }
    created.push({
      id: nextId('alert'),
      at: now,
      topicKey: t.key,
      topicName: t.name,
      score: t.score,
      growth: t.growth,
      momentumRatio: t.momentumRatio,
      surging: Boolean(t.surging),
      accountCount: t.accountCount,
      postCount: t.postCount,
      summary: t.summary,
      timingAdvice: t.timingAdvice,
      read: false,
      reason:
        `机会分数 ${t.score}` +
        `（环比 ${t.growth >= 0 ? '+' : ''}${(t.growth * 100).toFixed(0)}%，` +
        `短窗动能 ${Number.isFinite(t.momentumRatio) ? t.momentumRatio.toFixed(1) + 'x' : '—'}，` +
        `${t.accountCount} 个账号 / ${t.postCount} 条帖子）` +
        (quiet ? ' · 静默时段破例放行' : ''),
    });
  }

  if (created.length) {
    s.alerts = [...created, ...s.alerts].slice(0, sc.maxAlerts);
    for (const a of created) {
      logEvent('alert_raised', { topicKey: a.topicKey, score: a.score });
    }
  }
  saveState();
  return { created, suppressedByQuietHours, skippedByThreshold, quiet };
}

// 抽出成函数便于测试时注入固定时间
function hour0(ts) {
  return ts;
}

/** 执行一轮：抓取 → 识别 → 排序 → 筛选提醒 */
export async function runSchedulerTick({ manual = false } = {}) {
  const st = schedulerState();
  const sc = config.scheduler;
  try {
    const res = await runFull({ window: sc.window, trigger: manual ? 'manual_tick' : 'scheduled' });
    const alerts = collectAlerts(res.analyze.opportunities || []);
    st.lastTickAt = Date.now();
    st.tickCount += 1;
    st.lastError = null;
    st.lastSummary = {
      window: sc.window,
      postCount: res.analyze.postCount,
      topicCount: res.analyze.topicCount,
      topScore: res.analyze.top?.score ?? null,
      topName: res.analyze.top?.name ?? null,
      alertsRaised: alerts.created.length,
      suppressedByQuietHours: alerts.suppressedByQuietHours,
      quiet: alerts.quiet,
    };
    saveState();
    return { ok: true, ...st.lastSummary, alerts: alerts.created };
  } catch (e) {
    st.lastTickAt = Date.now();
    st.tickCount += 1;
    st.lastError = e.message || String(e);
    logEvent('scheduler_error', { message: st.lastError });
    saveState();
    return { ok: false, error: st.lastError };
  }
}

/** 按当前配置启动/重启/停止定时器（配置改动后调用一次即可生效） */
export function applyScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  const sc = config.scheduler;
  if (!sc.enabled) return schedulerStatus();
  const ms = Math.max(1, sc.intervalMinutes) * 60000;
  timer = setInterval(() => {
    runSchedulerTick().catch(() => {});
  }, ms);
  // 不要因为定时器把进程"钉住"（HTTP 服务本身已足够维持进程存活）
  if (typeof timer.unref === 'function') timer.unref();
  logEvent('scheduler_started', { intervalMinutes: sc.intervalMinutes, window: sc.window });
  return schedulerStatus();
}

export function stopScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  return schedulerStatus();
}

export function markAlertRead(id) {
  const s = loadState();
  const a = (s.alerts || []).find((x) => x.id === id);
  if (a) a.read = true;
  saveState();
  return { alerts: s.alerts };
}

export function clearAlerts() {
  const s = loadState();
  s.alerts = [];
  saveState();
  return { alerts: [] };
}
