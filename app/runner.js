/**
 * 运行编排：串联一次完整的「自动签到」流程（针对单个账号）
 */
import { log } from './logger.js';
import {
  loadConfig, resolveAccountConfig, getAccount, saveAccountOverrides, setCurrentAccount,
} from './config.js';
import { launchBrowser, closeBrowser, getPage, readAccountName, screenshot } from './browser.js';
import { inspect, analyzeQuota, bingPoints, homeValueMismatch, DASHBOARD } from './rewards.js';
import { runSearches } from './search.js';
import { doAllDashboardTasks, doQuizzes, claimPoints, visitEarn, checkMobileApp } from './tasks.js';
import { loadState, saveState, rollDay, addHistory, todayKey } from './store.js';

let running = false;
let cancelRequested = false;
let runningAccountId = null;

export function isRunning() {
  return running;
}
export function currentRunningAccount() {
  return runningAccountId;
}

export function cancelRun() {
  if (!running) return false;
  cancelRequested = true;
  log.warn('收到取消请求，将在当前步骤结束后停止…');
  return true;
}

/**
 * 执行一次完整流程
 * @param {object} [opts] { trigger, accountId, cfg }
 */
export async function runOnce(opts = {}) {
  if (running) {
    log.warn('已有任务正在执行，忽略本次触发。');
    return { ok: false, reason: 'already-running', accountId: opts.accountId || runningAccountId };
  }

  // 账号上下文：所有 store 操作都会落到该账号
  const account = getAccount(opts.accountId);
  if (!account) {
    log.error('未找到可执行的账号，请先在控制台添加账号。');
    return { ok: false, reason: 'no-account' };
  }
  const accountId = account.id;
  setCurrentAccount(accountId);

  const cfg = opts.cfg || resolveAccountConfig(accountId);
  const trigger = opts.trigger || 'manual';

  running = true;
  runningAccountId = accountId;
  cancelRequested = false;

  const startedAt = new Date();
  rollDay(accountId);

  const prefix = `[${account.label || accountId}]`;
  log.info('════════════════════════════════════════');
  log.info(`${prefix} 开始执行自动签到（触发方式：${triggerLabel(trigger)}）`);
  log.info('════════════════════════════════════════');

  saveState(accountId, { lastResult: 'running', lastRun: startedAt.toISOString() });

  const record = {
    accountId,
    accountLabel: account.label || accountId,
    trigger,
    startedAt: startedAt.toISOString(),
    endedAt: null,
    date: todayKey(startedAt),
    status: 'running',
    pointsBefore: null,
    pointsAfter: null,
    searches: 0,
    claimed: null,
    dailySet: null,
    mobileApp: null,
    message: '',
    signedIn: false,
  };

  let step = 'launch';
  try {
    // ---------- 1. 启动浏览器 ----------
    step = 'launch';
    const { context } = await launchBrowser(cfg);
    const page = await getPage(context);

    // ---------- 2. 登录检测（以 Rewards 页面为准） ----------
    step = 'login-check';
    log.step(`${prefix} [1/6] 检查登录状态…`);
    /*
     * 登录判定必须基于 Rewards 页面，而不是必应页头：
     * 实测同一个浏览器配置里，必应页头可能停在**另一个账号**的会话上，
     * 只看页头会误判为已登录，随后就用错误的会话去搜索。
     */
    const loginInfo = await inspect(page);
    const rewardsSignedIn = !!loginInfo.signedIn && !!(loginInfo.rawPoints != null || loginInfo.level);
    record.signedIn = rewardsSignedIn;
    if (!rewardsSignedIn) {
      const msg = '未检测到该账号已登录 Rewards。请在控制台该账号上点击「登录」，在弹出的浏览器窗口中用**本账号**完成登录（只需一次）。';
      log.error(`${prefix} ${msg}`);
      record.status = 'failed';
      record.message = msg;
      const cur = loadState(accountId);
      saveState(accountId, { account: { ...cur.account, signedIn: false } });
      return finalize(record, accountId);
    }
    log.success(`${prefix} 登录状态正常（Rewards 账号：${loginInfo.level || '已登录'}）。`);

    // Rewards 与必应会话是否一致（页头停在别的账号 -> 搜索会算到别人头上）
    const headerNow = await bingPoints(page);
    if (homeValueMismatch(headerNow, loginInfo.rawPoints)) {
      record.sessionMismatch = true;
      log.warn(
        `${prefix} ⚠ 必应会话与 Rewards 账号不一致：`
        + `必应页头 ${headerNow} 分，本账号实际 ${loginInfo.rawPoints} 分。`
      );
      log.warn(`${prefix}   这通常表示该配置目录里的必应会话还停留在另一个账号上。`);
      log.warn(`${prefix}   本次将只按 Rewards 数据判断额度；建议对该账号重新登录一次并确认必应页头显示本账号。`);
    }

    // 未标注时读取账号显示名（Rewards 页面上的名字）
    if (!account.emailHint) {
      const name = await readAccountName(page);
      if (name) saveAccountOverrides(accountId, { emailHint: name });
    }

    if (cancelRequested) throw new Error('cancelled');

    // ---------- 3. 读取账户信息与额度 ----------
    step = 'inspect';
    log.step(`${prefix} [2/6] 读取账户信息与今日任务…`);
    const info = loginInfo;
    const pointsBefore = info.rawPoints;
    record.pointsBefore = pointsBefore;
    const quota = analyzeQuota(info);
    record.quotaItems = quota.items;
    saveState(accountId, {
      account: {
        signedIn: true,
        points: pointsBefore,
        level: info.level,
        updatedAt: new Date().toISOString(),
      },
    });

    if (pointsBefore != null) log.success(`${prefix} 当前可用积分：${pointsBefore}`);
    for (const it of quota.items) {
      log.info(`  · ${it.label || it.kind}：${it.done}/${it.total}（剩余 ${it.remaining}）`);
    }
    if (!quota.items.length) log.info('  未读取到明确的额度信息，将依据积分增长情况自动判断。');
    const pendingTasks = (info.dailyTasks || []).filter((t) => !t.done).length;
    if (pendingTasks) log.info(`  每日活动待完成：${pendingTasks} 项`);

    if (cancelRequested) throw new Error('cancelled');

    // ---------- 4. 执行搜索 ----------
    const searchCfg = cfg.search || {};
    if (searchCfg.enabled !== false) {
      step = 'search';
      log.step(`${prefix} [3/6] 开始自动搜索赚取积分…`);
      const targetCount = quota.searchNeed && quota.searchTotal > 1 ? quota.searchNeed : 0;
      const sres = await runSearches(page, cfg, { targetCount });
      record.searches = sres.performed;
      record.searchDetail = {
        queries: sres.queries.slice(0, 100),
        stoppedBy: sres.stoppedBy,
        gained: sres.gained,
        pointsBefore: sres.pointsBefore,
        pointsAfter: sres.pointsAfter,
      };
      log.success(`${prefix} 搜索完成：实际搜索 ${sres.performed} 次，积分增长 ${sres.gained >= 0 ? '+' : ''}${sres.gained}`);
    } else {
      log.info(`${prefix} [3/6] 搜索功能已关闭，跳过。`);
    }

    if (cancelRequested) throw new Error('cancelled');

    // ---------- 5. 仪表盘任务（每日活动 + 新手引导等） ----------
    const taskCfg = cfg.tasks || {};
    if (taskCfg.enabled !== false && taskCfg.doDailySet !== false) {
      step = 'daily-set';
      log.step(`${prefix} [4/6] 执行仪表盘任务（每日活动 / 新手引导）…`);
      record.dailySet = await doAllDashboardTasks(page, cfg);
      if (record.dailySet.skipped?.length) {
        record.manualTasks = record.dailySet.skipped.map((t) => ({ title: t.title, points: t.points, href: t.href }));
      }
    } else {
      log.info(`${prefix} [4/6] 任务处理已关闭，跳过。`);
    }

    if (cancelRequested) throw new Error('cancelled');

    // ---------- 6. 移动应用签到检测 / 领取积分 / 刷新任务页 ----------
    if (taskCfg.enabled !== false) {
      if (taskCfg.checkMobileApp !== false) {
        step = 'mobile-app';
        log.step(`${prefix} [5/6] 检查「移动应用签到」…`);
        record.mobileApp = await checkMobileApp(page, cfg);
      }
      if (taskCfg.claimPoints !== false) {
        step = 'claim';
        log.step(`${prefix} 处理可领取积分…`);
        record.claimed = await claimPoints(page);
      }
      if (taskCfg.visitEarn !== false) {
        log.step(`${prefix} [6/6] 刷新积分赚取页…`);
        await visitEarn(page);
      }
      if (taskCfg.doQuizzes) {
        log.step(`${prefix} 尝试完成每日测验…`);
        await doQuizzes(page);
      }
    } else {
      log.info(`${prefix} [5/6] 任务处理已关闭，跳过。`);
    }

    // ---------- 收尾 ----------
    step = 'finalize';
    const finalInfo = await inspect(page).catch(() => null);
    const pointsAfter = finalInfo?.rawPoints ?? (await bingPoints(page));
    record.pointsAfter = pointsAfter;
    if (pointsAfter != null) {
      const cur = loadState(accountId);
      saveState(accountId, { account: { ...cur.account, points: pointsAfter, updatedAt: new Date().toISOString() } });
    }

    record.status = 'ok';
    record.message = buildMessage(record);
    log.info('════════════════════════════════════════');
    log.success(`${prefix} 本次执行完成：${record.message}`);
    if (record.pointsBefore != null && record.pointsAfter != null) {
      const g = record.pointsAfter - record.pointsBefore;
      log.info(`${prefix} 积分：${record.pointsBefore} → ${record.pointsAfter}（${g >= 0 ? '+' : ''}${g}）`);
    }
    // 明确列出仍需人工处理的任务，避免"以为都做完了"
    if (record.manualTasks?.length) {
      log.info(`${prefix} 仍需你手动完成的任务（共 ${record.manualTasks.length} 项）：`);
      for (const t of record.manualTasks) {
        log.info(`   · ${t.title}${t.points ? ` +${t.points}` : ''}  ${t.href || ''}`);
      }
    }
    if (record.dailySet?.totalPending > 0) {
      log.info(`${prefix} 本次发现待办任务 ${record.dailySet.totalPending} 项，已处理 ${record.dailySet.completed} 项。`);
      if (record.dailySet.remaining != null) {
        log.info(`${prefix} 处理后再查：还剩 ${record.dailySet.remaining} 项未完成（部分任务积分入账有延迟）。`);
      }
    }
    log.info('════════════════════════════════════════');
    return finalize(record, accountId);
  } catch (err) {
    const cancelled = err.message === 'cancelled' || cancelRequested;
    record.status = cancelled ? 'cancelled' : 'failed';
    record.message = cancelled ? '任务已被手动取消' : `执行失败（步骤：${step}）：${err.message}`;
    if (cancelled) log.warn(`${prefix} ${record.message}`);
    else log.error(`${prefix} ${record.message}`);
    if (cfg.advanced?.screenshotOnError && !cancelled) {
      const file = await screenshot(`error-${accountId}-${Date.now()}`).catch(() => null);
      if (file) {
        record.screenshot = file;
        log.info('失败页面截图已保存:', file);
      }
    }
    return finalize(record, accountId);
  } finally {
    try {
      if (!cfg.advanced?.keepBrowserOpen) await closeBrowser();
    } catch { /* 忽略 */ }
    running = false;
    runningAccountId = null;
    cancelRequested = false;
  }
}

function finalize(record, accountId) {
  record.endedAt = new Date().toISOString();
  const st = loadState(accountId);
  saveState(accountId, {
    lastRun: record.endedAt,
    lastRunDate: record.date,
    lastResult: record.status,
    todayRuns: (st.todayRuns || 0) + (record.trigger === 'manual' ? 0 : 1),
    todayDate: record.date,
  });
  addHistory(accountId, record);

  const prefix = `[${record.accountLabel}]`;
  if (record.status !== 'ok') {
    log.info('════════════════════════════════════════');
    log.info(`${prefix} 本次执行结果：${record.status} · ${record.message}`);
    if (record.pointsBefore != null && record.pointsAfter != null) {
      const g = record.pointsAfter - record.pointsBefore;
      log.info(`${prefix} 积分：${record.pointsBefore} → ${record.pointsAfter}（${g >= 0 ? '+' : ''}${g}）`);
    }
    log.info('════════════════════════════════════════');
  }
  return { ok: record.status === 'ok', status: record.status, record, message: record.message, accountId };
}

function buildMessage(record) {
  const parts = [];
  if (record.searches) parts.push(`搜索 ${record.searches} 次`);
  if (record.dailySet?.completed) parts.push(`完成任务 ${record.dailySet.completed} 项`);
  if (record.claimed?.claimed) parts.push(`领取积分 ${record.claimed.amount ?? ''}`);
  const gain = (record.pointsAfter ?? 0) - (record.pointsBefore ?? 0);
  if (record.pointsBefore != null && record.pointsAfter != null) parts.push(`积分 +${gain}`);
  return parts.length ? parts.join('，') : '流程执行完毕';
}

function triggerLabel(t) {
  return { manual: '手动', schedule: '定时', startup: '启动补跑', cli: '命令行' }[t] || t;
}

export { loadConfig, DASHBOARD };
