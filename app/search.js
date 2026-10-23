/**
 * 搜索执行：模拟真人节奏在必应进行搜索，并在积分停止增长时自动停止
 */
import { log } from './logger.js';
import { generateQueries } from './queries.js';
import {
  bingPoints, dashboardPoints, homeValueMismatch,
  bingHeaderIdentity, evaluateSessionMatch, dashboardAccountName,
} from './rewards.js';
import { NetworkGuard, safeGoto } from './net.js';

const HOME = 'https://cn.bing.com/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1 EdgiOS/125.0';

/** 把页面切换为移动端环境（UA + 视口 + 触摸） */
export async function applyMobileMode(page) {
  try {
    await page.setViewportSize({ width: 414, height: 896 });
    await page.setExtraHTTPHeaders({ 'User-Agent': IPHONE_UA });
    const cdp = await page.context().newCDPSession(page).catch(() => null);
    if (cdp) {
      await cdp.send('Emulation.setUserAgentOverride', { userAgent: IPHONE_UA });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 414, height: 896, deviceScaleFactor: 3, mobile: true,
      });
    }
  } catch { /* 移动端模拟失败不影响主流程 */ }
}

/** 恢复桌面环境 */
export async function applyDesktopMode(page) {
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    const cdp = await page.context().newCDPSession(page).catch(() => null);
    if (cdp) {
      await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
    }
  } catch { /* 忽略 */ }
}

/** 拟人化输入 */
async function humanType(page, selector, text) {
  await page.click(selector).catch(() => {});
  for (const ch of text) {
    await page.type(selector, ch, { delay: rand(40, 160) });
  }
}

/** 随机滚动，制造浏览行为 */
async function humanScroll(page, times = 2) {
  for (let i = 0; i < times; i++) {
    const delta = rand(300, 900);
    await page.mouse.wheel(0, delta).catch(() => {});
    await sleep(rand(400, 1200));
  }
}

/** 从必应首页热榜读取几条真实热点，作为更自然的搜索词 */
export async function readHeadlines(page, limit = 6) {
  try {
    await safeGoto(page, HOME, { timeout: 45000 });
    await page.waitForTimeout(rand(1500, 3000));
    const items = await page.evaluate((n) => {
      const picks = [...document.querySelectorAll('#sp_requery a, .hilite_prop, #rich_news a, a[href*="/search?q="]')]
        .map((a) => (a.innerText || '').trim())
        .filter((t) => t && t.length >= 4 && t.length <= 30 && !/^\d+$/.test(t));
      return [...new Set(picks)].slice(0, n);
    }, limit);
    if (items.length) log.info(`读取到 ${items.length} 条热榜话题`);
    return items;
  } catch (err) {
    log.debug('读取热榜失败（忽略）:', err.message);
    return [];
  }
}

/**
 * 设置搜索框内容并提交
 */
async function performSearch(page, query) {
  await safeGoto(page, HOME, { timeout: 45000 });
  await page.waitForSelector('#sb_form_q', { timeout: 20000 });
  await sleep(rand(600, 1800));
  await humanType(page, '#sb_form_q', query);
  await sleep(rand(200, 900));
  await page.keyboard.press('Enter');
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
  } catch { /* 超时不致命 */ }
  await sleep(rand(1200, 2600));
  return page.url();
}

/**
 * 批量自动搜索，直到：
 *   - 积分连续 N 次不再增长（判定已刷满）
 *   - 达到 maxSearches 上限
 *   - 达到目标额度 targetCount
 *
 * @param {import('playwright-core').Page} page
 * @param {object} cfg 完整配置
 * @param {object} opts { targetCount?: number, reason?: string }
 * @returns {Promise<object>} 执行结果
 */
export async function runSearches(page, cfg, opts = {}) {
  const s = cfg.search || {};
  const maxSearches = Math.max(1, Number(opts.maxSearches ?? s.maxSearches ?? 60));
  const stopAfterNoGain = Math.max(1, Number(s.stopAfterNoGain ?? 3));
  const minDelay = Math.max(500, Number(s.minDelayMs ?? 2500));
  const maxDelay = Math.max(minDelay, Number(s.maxDelayMs ?? 7000));

  const summary = {
    performed: 0, queries: [], pointsBefore: null, pointsAfter: null, gained: 0,
    stoppedBy: 'unknown', failed: 0, consecutiveErrors: 0,
  };

  /*
   * 网络熔断：断网时不要傻跑满 target 次。
   * 每个失败都会喂给 guard，连续 N 次网络类错误即判定离线、中止本轮。
   */
  const guard = new NetworkGuard({ threshold: 3, name: '搜索' });

  // 移动端模式：切换 UA / 视口，用于覆盖移动端搜索额度
  if (s.mobileMode) {
    await applyMobileMode(page);
    log.info('已启用移动端模式（UA/视口已切换为手机）。');
  }

  // ---- 起始积分：以 Rewards 仪表盘为账号权威值 ----
  const dashBefore = await dashboardPoints(page);
  const dashName = await dashboardAccountName(page).catch(() => null);
  await safeGoto(page, HOME, { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const headerBefore = await bingPoints(page);
  const headerName = await bingHeaderIdentity(page);

  /*
   * 页头会话与账号不一致时，页头数值完全不可用（会按别的账号判断额度）。
   * 优先用昵称判定：实测「本账号 个给/2234，页头却显示 生/5489」时，
   * 单看积分可能恰好接近而漏判，比昵称最可靠。
   */
  const matchResult = evaluateSessionMatch({
    headerPoints: headerBefore, headerName, dashPoints: dashBefore, dashName,
  });
  const mismatched = matchResult.mismatch;
  if (mismatched) {
    log.warn(`⚠ 必应页头与本账号不一致：${matchResult.reason}`);
    log.warn('  该浏览器配置里的必应会话停在了另一个账号上，已自动改用 Rewards 数据判断额度。');
    log.warn('  建议：在控制台对该账号点「重置登录」，再重新登录一次本账号。');
  }

  summary.pointsBefore = dashBefore ?? headerBefore;
  summary.headerBefore = headerBefore;
  summary.headerName = headerName;
  summary.sessionMismatch = mismatched;
  summary.sessionMismatchReason = matchResult.reason || null;

  /**
   * 页头是否已不可信（运行期可变）。
   * 开头就错配 -> 直接禁用页头；否则在循环中每轮验算，发现漂移再禁用。
   */
  let headerUnusable = mismatched;

  // 起始积分已知才可做「刷满即停」判定
  const verifiable = s.verifyPoints !== false && summary.pointsBefore != null && summary.pointsBefore > 0;
  if (!verifiable) {
    log.warn('无法读取起始积分，本次将不做「刷满即停」判定，只按次数上限执行。');
  }
  summary.verifiable = verifiable;
  log.info(`开始自动搜索，起始积分：${summary.pointsBefore ?? '未知'}（来源：Rewards 仪表盘）`);

  // 读取账号权威积分（仪表盘），用于搜索过程中的真实校验
  let dashReads = 0;
  const readAuthoritative = async () => {
    dashReads += 1;
    const v = await dashboardPoints(page);
    if (v != null) summary.pointsAfter = v;
    return v;
  };

  // 目标次数：优先显式额度（当日剩余），否则用上限
  const target = opts.targetCount && opts.targetCount > 0 ? Math.min(opts.targetCount, maxSearches) : maxSearches;
  if (opts.targetCount > 0) log.info(`本次目标：约 ${target} 次搜索（依据当日剩余额度）`);

  // 组装搜索词
  const headlines = s.readNews ? await readHeadlines(page, Math.min(target, 6)) : [];
  const generated = generateQueries(target + 10, {
    querySource: s.querySource || 'mixed',
    customQueries: s.customQueries || [],
    accountId: cfg.account?.id || null,
  });
  const pool = [];
  for (let i = 0; i < target; i++) {
    // 前几条混入热点话题，更真实
    const pool3 = i % 2 === 0 && headlines.length ? headlines : generated;
    pool.push(pool3[i % pool3.length] || generated[i % generated.length]);
  }

  let lastPoints = summary.pointsBefore;
  let noGainStreak = 0;

  for (let i = 0; i < target; i++) {
    // 已判定离线则立刻中止，不再做无意义的重试
    if (guard.isOffline()) {
      summary.stoppedBy = 'network-offline';
      log.error(`网络不可用，搜索在第 ${i + 1}/${target} 次前中止。`);
      break;
    }

    const query = pool[i];
    log.step(`[${i + 1}/${target}] 搜索：「${query}」`);

    let url = '';
    try {
      url = await performSearch(page, query);
      guard.recordSuccess();
      summary.consecutiveErrors = 0;
    } catch (err) {
      summary.failed += 1;
      const kind = guard.recordFailure(err);
      summary.consecutiveErrors = Math.floor(guard.consecutive);
      summary.lastErrorKind = kind;

      // 断网类错误：只记一行精简日志，不打印完整 Call log 噪声
      const brief = String(err.message || '').split('\n')[0].slice(0, 120);
      if (kind === 'offline') {
        log.warn(`第 ${i + 1} 次搜索失败（网络）：${brief}`);
      } else {
        log.warn(`第 ${i + 1} 次搜索出错：${brief}`);
      }

      // 记录连续失败，用于最终判定
      if (guard.isOffline()) {
        summary.stoppedBy = 'network-offline';
        log.error(`已连续 ${guard.totalOffline} 次网络失败，停止搜索并结束本轮搜索阶段。`);
        break;
      }
      continue;
    }
    summary.performed += 1;
    summary.queries.push(query);

    // 浏览行为
    await humanScroll(page, rand(1, 3));

    /*
     * 积分校验策略：
     *   优先用页头（廉价、实时），但**每次都验算它是否属于本账号**。
     *
     * 为什么必须每轮验证：必应页头的会话可能在运行过程中"漂移"到别的账号
     * （实测同一浏览器配置里，页头一会儿是本账号、一会儿是另一个账号的积分），
     * 只在开头判断一次会让后续判定全部错乱 —— 出现「积分 +3210」这种跨账号读数，
     * 并让「刷满即停」逻辑失效。
     */
    let useHeader = !headerUnusable;
    let now = null;
    let gainSource = '';

    if (useHeader) {
      now = await bingPoints(page);
      if (verifiable) {
        // 积分入账有延迟，轮询几次
        for (let w = 0; w < 4 && (now === null || lastPoints === null || now <= lastPoints); w++) {
          await sleep(2500);
          const retry = await bingPoints(page);
          if (retry !== null && lastPoints !== null && retry > lastPoints) { now = retry; break; }
          if (retry !== null) now = retry;
        }
      }
      gainSource = '页头';

      /*
       * 立即合理性检查（**不等后面的校准轮次**）：
       * 单次搜索的积分增幅是个位数级别，页头读数若与已知基准相差过大，
       * 几乎必然是页头会话已漂移到别的账号。此时立刻丢弃页头并改读仪表盘，
       * 否则会算出「积分 +3210」这类跨账号读数并污染后续判定。
       */
      if (now != null && lastPoints != null && homeValueMismatch(now, lastPoints)) {
        headerUnusable = true;
        summary.sessionMismatch = true;
        log.warn(
          `⚠ 必应页头读数（${now}）与已知基准（${lastPoints}）差距过大，`
          + '判定页头会话已漂移到其他账号，立即改用仪表盘判断额度。',
        );
        log.warn('  建议对本账号重新「登录」，并确认必应首页显示的是本账号。');
        now = null;            // 丢弃页头读数
        gainSource = '';
        useHeader = false;
      }
    }

    /*
     * 每 3 次搜索（或页头读数可疑时）用仪表盘做权威校验：
     * 若页头与仪表盘差距过大 -> 判定页头属于别的账号，之后本轮永久改用仪表盘。
     */
    const needAuthorityCheck = useHeader && (
      now === null
      || (verifiable && lastPoints != null && now <= lastPoints)
      || (i + 1) % 3 === 0
    );

    if (!useHeader || needAuthorityCheck) {
      await sleep(1800);
      const dashNow = await readAuthoritative();
      if (dashNow != null) {
        if (useHeader && now != null && homeValueMismatch(now, dashNow)) {
          headerUnusable = true;
          summary.sessionMismatch = true;
          log.warn(
            `⚠ 检测到必应页头读数（${now}）与本账号仪表盘（${dashNow}）不一致，`
            + '判定页头会话已漂移到其他账号，本轮起改用仪表盘判断额度。',
          );
          log.warn('  建议对本账号重新「登录」，并确认必应首页显示的是本账号。');
        }
        now = dashNow;
        gainSource = useHeader && !headerUnusable ? '仪表盘(校准)' : '仪表盘';
      }
    }

    /*
     * 更新基准值。
     * 注意：lastPoints 必须始终保持「本账号的真实分数」语义。
     * 只有当读数来源可信（仪表盘，或页头已通过合理性检查）时才更新基准，
     * 否则会把外来账号的分数固化进基准，导致后续所有比较失真。
     */
    if (now !== null && lastPoints !== null && now > lastPoints) {
      /*
       * 单次搜索的合理增幅上限：正常为个位数。
       * 若一次就涨了几百上千分，说明读数串了账号 —— 丢弃，不计入。
       */
      const delta = now - lastPoints;
      const implausible = delta > 50;

      if (implausible) {
        log.warn(
          `⚠ 检测到异常积分增幅 +${delta}（${lastPoints} → ${now}，来源：${gainSource}），`
          + '不符合单次搜索的合理范围，已丢弃该读数（疑似读数串到其他账号）。',
        );
        headerUnusable = true;
        summary.sessionMismatch = true;
        if (gainSource === '页头') {
          // 拿权威值重新校准基准
          const auth = await dashboardPoints(page);
          if (auth != null) lastPoints = auth;
        }
      } else {
        log.success(`积分 +${delta}（当前 ${now}，来源：${gainSource}）`);
        lastPoints = now;
        noGainStreak = 0;
        summary.pointsAfter = lastPoints;
      }
    } else if (!verifiable) {
      // 无法校验时只记录，不判定刷满
      noGainStreak = 0;
    } else {
      noGainStreak += 1;
      log.info(`本次未检测到积分增长（连续 ${noGainStreak}/${stopAfterNoGain} 次）${now !== null ? `，当前 ${now}` : ''}`);
    }

    if (verifiable && s.autoFillToCap && noGainStreak >= stopAfterNoGain) {
      summary.stoppedBy = 'no-gain';
      log.success(`已连续 ${noGainStreak} 次搜索未获得积分，判定今日搜索积分已刷满，停止搜索。`);
      break;
    }

    if (i < target - 1) await sleep(rand(minDelay, maxDelay));
  }

  if (summary.stoppedBy === 'unknown') {
    summary.stoppedBy = summary.performed >= target ? 'target-reached' : 'finished';
    if (summary.stoppedBy === 'target-reached') log.info('已达到本次搜索次数上限。');
  }

  summary.pointsAfter = lastPoints;
  summary.gained = (lastPoints ?? 0) - (summary.pointsBefore ?? 0);
  return summary;
}
