/**
 * 定时调度器（多账号）
 *
 * 软件启动后常驻运行，按配置在每天固定时刻（或多个时刻）为**每个启用的账号**
 * 依次自动执行；支持错过补跑、每账号每日次数上限、周末跳过，
 * 以及账号之间的错峰启动（避免多个浏览器同时打开）。
 */
import { log } from './logger.js';
import { loadSettings, resolveAccountConfig, getAccounts } from './config.js';
import { loadState, saveState, todayKey, rollDay } from './store.js';
import { runOnce, isRunning, currentRunningAccount } from './runner.js';

const TICK_MS = 20_000;
let timer = null;
let started = false;
let staggerCounter = 0;

/** 解析 "HH:MM" */
function parseTime(str) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { h, min, minutes: h * 60 + min };
}

function fmtTime(t) {
  return `${String(t.h).padStart(2, '0')}:${String(t.min).padStart(2, '0')}`;
}

function fmtLocal(d) {
  if (!d) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function slotAlreadyRun(dateKey, accountId, timeStr) {
  const st = loadState(accountId);
  return (st.triggerLog || []).some((x) => x.date === dateKey && x.slot === timeStr);
}

function markSlot(dateKey, accountId, timeStr) {
  const st = loadState(accountId);
  const list = Array.isArray(st.triggerLog) ? st.triggerLog : [];
  list.push({ date: dateKey, slot: timeStr, at: new Date().toISOString() });
  saveState(accountId, { triggerLog: list.slice(-200) });
}

/** 调度器整体状态（供控制台展示） */
export function schedulerStatus() {
  const settings = loadSettings();
  const s = settings.application.schedule;

  const perAccount = settings.accounts.map((a) => {
    const st = loadState(a.id);
    const next = computeNextRun(a.id);
    return {
      id: a.id,
      label: a.label,
      enabled: a.enabled !== false,
      nextRunAt: next ? next.toISOString() : null,
      nextRunLocal: fmtLocal(next),
      lastRun: st.lastRun || null,
      lastResult: st.lastResult || null,
      todayRuns: st.todayRuns || 0,
      todayDate: st.todayDate || null,
    };
  });

  const upcoming = perAccount
    .filter((p) => p.enabled && p.nextRunAt)
    .map((p) => new Date(p.nextRunAt))
    .sort((x, y) => x - y);
  const nextRunAt = upcoming[0] || null;

  return {
    started,
    enabled: s.enabled !== false,
    mode: s.mode,
    dailyTimes: s.dailyTimes,
    intervalMinutes: s.intervalMinutes,
    maxRunsPerDay: s.maxRunsPerDay,
    staggerSeconds: s.staggerSeconds,
    catchUp: s.catchUp !== false,
    catchUpHours: s.catchUpHours == null ? 12 : s.catchUpHours,
    runOnStart: !!s.runOnStart,
    nextRunAt: nextRunAt ? nextRunAt.toISOString() : null,
    nextRunLocal: fmtLocal(nextRunAt),
    running: isRunning(),
    runningAccount: currentRunningAccount(),
    accountCount: settings.accounts.length,
    enabledCount: settings.accounts.filter((a) => a.enabled !== false).length,
    perAccount,
  };
}

/** 计算某账号的下一次计划执行时间 */
export function computeNextRun(accountId, now = new Date()) {
  const settings = loadSettings();
  const s = settings.application.schedule;
  if (s.enabled === false) return null;

  const account = settings.accounts.find((a) => a.id === accountId);
  if (!account || account.enabled === false) return null;

  const st = loadState(accountId);

  if (s.mode === 'interval') {
    const mins = Math.max(1, Number(s.intervalMinutes || 60));
    const last = st.lastRun ? new Date(st.lastRun) : null;
    if (!last) return new Date(now.getTime() + 5000);
    const next = new Date(last.getTime() + mins * 60_000);
    return next > now ? next : new Date(now.getTime() + 5000);
  }

  const times = (s.dailyTimes || []).map(parseTime).filter(Boolean).sort((a, b) => a.minutes - b.minutes);
  if (!times.length) return null;
  const cur = now.getHours() * 60 + now.getMinutes();
  const dateKey = todayKey(now);

  for (const t of times) {
    if (t.minutes > cur && !slotAlreadyRun(dateKey, accountId, fmtTime(t))) {
      const d = new Date(now);
      d.setHours(t.h, t.min, 0, 0);
      return d;
    }
  }
  const t0 = times[0];
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(t0.h, t0.min, 0, 0);
  return d;
}

/** 判断某账号此刻是否到期 */
function isDue(account, now, { manual = false } = {}) {
  const s = loadSettings().application.schedule;
  const st = rollDay(account.id);
  const dateKey = todayKey(now);

  const maxRuns = Math.max(1, Number(s.maxRunsPerDay || 2));
  if ((st.todayRuns || 0) >= maxRuns) return null;

  if (s.mode === 'interval') {
    const mins = Math.max(1, Number(s.intervalMinutes || 60));
    const last = st.lastRun ? new Date(st.lastRun) : null;
    if (!last) return { slot: `${dateKey}#interval-${now.getTime()}`, note: '首次运行' };
    if (now.getTime() - last.getTime() >= mins * 60_000) {
      return { slot: `${dateKey}#interval-${Math.floor(now.getTime() / 60_000)}`, note: `间隔 ${mins} 分钟` };
    }
    return null;
  }

  const times = (s.dailyTimes || []).map((x) => ({ raw: x, t: parseTime(x) })).filter((x) => x.t);
  for (const { raw, t } of times) {
    const slotDate = new Date(now);
    slotDate.setHours(t.h, t.min, 0, 0);
    const diffMin = (now.getTime() - slotDate.getTime()) / 60_000;

    /*
     * 常规巡检：到点（1 分钟内）或（开启补跑且在补跑窗口内）
     * 手动检查：忽略补跑窗口——用户主动要求就执行，只受每账号每日上限约束
     */
    const windowHours = Math.max(0.25, Number(s.catchUpHours ?? 12));
    const due = manual
      ? true
      : diffMin >= 0 && (diffMin <= 1 || (s.catchUp && diffMin <= windowHours * 60));

    if (due && !slotAlreadyRun(dateKey, account.id, raw)) {
      const note = diffMin <= 1 ? '按计划执行'
        : (manual ? `手动检查补跑（迟到 ${Math.round(diffMin)} 分钟）` : `补跑（迟到 ${Math.round(diffMin)} 分钟）`);
      return { slot: raw, note };
    }
  }
  return null;
}

/**
 * 单次巡检：一个账号执行完再轮到下一个
 * @param {'schedule'|'startup'} trigger 触发方式（写入执行记录用）
 * @param {{ manual?: boolean }} [opts] manual=true 时忽略补跑窗口（用于「立即检查计划」）
 */
export async function tick(trigger = 'schedule', opts = {}) {
  const manual = !!opts.manual;
  const settings = loadSettings();
  const s = settings.application.schedule;

  if (s.enabled === false) return;
  if (isRunning()) return;

  const now = new Date();
  if (s.skipWeekends && (now.getDay() === 0 || now.getDay() === 6)) return;

  const accounts = getAccounts().filter((a) => a.enabled !== false);
  if (!accounts.length) return;

  // 错峰：每个 tick 只启动一个账号，之间隔 N 个 tick
  const staggerTicks = Math.max(1, Math.ceil((Number(s.staggerSeconds || 90) * 1000) / TICK_MS));
  if (!manual && staggerCounter > 0) {
    staggerCounter -= 1;
    return;
  }

  for (const account of accounts) {
    const due = isDue(account, now, { manual });
    if (!due) continue;

    const moreWaiting = accounts.some((a) => a.id !== account.id && !!isDue(a, now, { manual }));
    if (moreWaiting) {
      staggerCounter = staggerTicks;
      log.debug(`多账号错峰：本次执行 [${account.label}]，约 ${(staggerTicks * TICK_MS) / 1000} 秒后执行下一个。`);
    }

    log.info(`⏰ 定时触发 [${account.label}]：${due.note}`);
    markSlot(todayKey(now), account.id, due.slot);
    await runOnce({ trigger, accountId: account.id, cfg: resolveAccountConfig(account.id) });
    return; // 一轮只跑一个账号
  }
}

/**
 * 手动立即巡检一次（忽略补跑窗口与错峰等待）
 * 用于控制台「立即检查计划」按钮——用户主动要求时就去执行，
 * 只受「每账号每天最多执行」约束，避免重复刷取。
 */
export async function checkNow() {
  if (isRunning()) return { ok: false, reason: 'already-running' };
  staggerCounter = 0;
  await tick('schedule', { manual: true });
  return { ok: true };
}

/** 启动调度器 */
export function startScheduler() {
  if (timer) return;
  started = true;
  const settings = loadSettings();
  const s = settings.application.schedule;
  const enabledCount = settings.accounts.filter((a) => a.enabled !== false).length;

  log.info(
    `调度器已启动：模式=${s.mode === 'interval' ? `每 ${s.intervalMinutes} 分钟` : `每天 ${(s.dailyTimes || []).join(' / ')}`}，`
    + `启用账号 ${enabledCount}/${settings.accounts.length} 个，每账号每天最多 ${s.maxRunsPerDay} 次，`
    + `错峰 ${s.staggerSeconds || 90} 秒`,
  );

  /*
   * 错过时刻的处理说明（这是最容易让人误以为「不执行」的地方）：
   *   catchUp=true  -> 过了计划时刻之后才打开软件，仍会在补跑窗口内补跑
   *   catchUp=false -> 只认「计划时刻那一刻」，错过就等第二天，且不会有任何提示
   */
  if (s.mode !== 'interval') {
    const winHours = s.catchUpHours == null ? 12 : s.catchUpHours;
    if (s.catchUp === false) {
      log.warn(
        `提示：当前「错过时刻自动补跑」是关闭的。若计划时刻（${(s.dailyTimes || []).join(' / ')}）电脑未开机或软件未运行，`
        + '当天将不会执行且没有提示。建议在设置里开启「错过时刻自动补跑」。',
      );
    } else {
      log.info(`补跑窗口：错过计划时刻后 ${winHours} 小时内仍会自动补跑（可在设置中调整）。`);
      if (s.runOnStart) log.info('已启用「软件启动后立即检查计划」：打开软件后会立刻检查并补跑。');
    }
  }

  // 启动后立即巡检一次（支持「启动补跑」）
  setTimeout(() => {
    if (s.mode === 'interval') return;
    if (!s.runOnStart && s.catchUp === false) return; // 两者都关就没有可补的
    tick('startup').catch((e) => log.error('启动补跑失败:', e.message));
  }, 8000);

  timer = setInterval(() => {
    if (process.env.DSH_SCHED_DEBUG) {
      log.debug(`[调度心跳] timer=${!!timer} 运行中=${isRunning()} 错峰计数=${staggerCounter}`);
    }
    tick('schedule').catch((e) => log.error('调度巡检出错:', e.message));
  }, TICK_MS);

  if (timer.unref) timer.unref();
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

export function refreshNextRun() {
  staggerCounter = 0;
}
