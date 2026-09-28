/**
 * 搜索执行：模拟真人节奏在必应进行搜索，并在积分停止增长时自动停止
 */
import { log } from './logger.js';
import { generateQueries } from './queries.js';
import { bingPoints, dashboardPoints, homeValueMismatch } from './rewards.js';

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
    await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 45000 });
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
  await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 45000 });
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

  const summary = { performed: 0, queries: [], pointsBefore: null, pointsAfter: null, gained: 0, stoppedBy: 'unknown' };

  // 移动端模式：切换 UA / 视口，用于覆盖移动端搜索额度
  if (s.mobileMode) {
    await applyMobileMode(page);
    log.info('已启用移动端模式（UA/视口已切换为手机）。');
  }

  // ---- 起始积分：以 Rewards 仪表盘为账号权威值 ----
  const dashBefore = await dashboardPoints(page);
  await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const headerBefore = await bingPoints(page);

  // 页头会话与账号不一致时，页头数值完全不可用（会按别的账号判断额度）
  const mismatched = homeValueMismatch(headerBefore, dashBefore);
  if (mismatched) {
    log.warn(
      `⚠ 必应页头显示的积分（${headerBefore}）与本账号实际积分（${dashBefore}）不一致：`
      + '说明该浏览器配置里的必应会话仍停留在另一个账号上。已自动改用 Rewards 数据判断额度。'
    );
    log.warn('  建议：在控制台对本账号重新点一次「登录」，并用本账号的必应主页完成登录，以消除该错配。');
  }

  summary.pointsBefore = dashBefore ?? headerBefore;
  summary.headerBefore = headerBefore;
  summary.sessionMismatch = mismatched;

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
    const query = pool[i];
    log.step(`[${i + 1}/${target}] 搜索：「${query}」`);

    let url = '';
    try {
      url = await performSearch(page, query);
    } catch (err) {
      log.warn(`第 ${i + 1} 次搜索出错：${err.message}`);
      continue;
    }
    summary.performed += 1;
    summary.queries.push(query);

    // 浏览行为
    await humanScroll(page, rand(1, 3));

    /*
     * 积分校验策略（按可靠性排序）：
     *   1) 会话错配 / 页头读不到时 —— 直接读 Rewards 仪表盘（账号权威值）
     *   2) 会话正常时 —— 用页头做廉价的相对变化判断，
     *      每 5 次搜索再用仪表盘校准一次，避免长时间偏离真实值
     */
    const useHeader = !summary.sessionMismatch;
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
    }

    // 页头不可用，或没读到增长 -> 用仪表盘复核
    if (!useHeader || now === null || (verifiable && lastPoints != null && now <= lastPoints)) {
      await sleep(1800);
      const dashNow = await readAuthoritative();
      if (dashNow != null) {
        now = dashNow;
        gainSource = '仪表盘';
      }
    } else if (verifiable && (i + 1) % 5 === 0) {
      const dashNow = await readAuthoritative();
      if (dashNow != null && lastPoints != null && homeValueMismatch(now, dashNow)) {
        log.info(`校准积分读数：页头 ${now} → 仪表盘 ${dashNow}`);
        now = dashNow;
        gainSource = '仪表盘(校准)';
      }
    }

    if (now !== null && lastPoints !== null && now > lastPoints) {
      log.success(`积分 +${now - lastPoints}（当前 ${now}，来源：${gainSource}）`);
      lastPoints = now;
      noGainStreak = 0;
      summary.pointsAfter = lastPoints;
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
