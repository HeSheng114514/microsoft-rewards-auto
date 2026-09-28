/**
 * 浏览器管理：启动持久化上下文（保留登录 Cookie）、登录检测、登录引导
 *
 * 每个账号使用各自独立的配置目录，因此登录态彼此隔离、互不影响。
 */
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import {
  ensureDirs, accountProfileDir, accountShotDir, sanitizeId,
} from './paths.js';
import { log } from './logger.js';
import { getCurrentAccountId } from './config.js';
import { homeValueMismatch } from './rewards.js';

const WIN_CANDIDATES = {
  msedge: [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  chrome: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : '',
  ],
};

/** 探测本机是否安装了指定浏览器 */
export function detectBrowser(kind) {
  if (kind === 'chromium') {
    return { kind, execPath: null, available: true, label: 'Playwright Chromium（自动下载）' };
  }
  for (const p of WIN_CANDIDATES[kind] || []) {
    if (p && fs.existsSync(p)) {
      return { kind, execPath: p, available: true, label: kind === 'msedge' ? 'Microsoft Edge' : 'Google Chrome' };
    }
  }
  return { kind, execPath: null, available: false, label: kind === 'msedge' ? 'Microsoft Edge（未安装）' : 'Google Chrome（未安装）' };
}

export function listBrowsers() {
  return ['msedge', 'chrome', 'chromium'].map((k) => detectBrowser(k));
}

/* ---------------- 上下文管理 ---------------- */

/**
 * 按账号维护已打开的浏览器上下文。
 *
 * 关键：必须按账号隔离。早期实现只保存「一个活动上下文」，导致第二个账号
 * 复用了第一个账号的浏览器配置目录 —— 于是读的是别的账号的积分、搜的是
 * 别的账号的会话，任务自然完成不了。
 */
const contexts = new Map(); // accountId -> { context, kind }

export function isBrowserOpen() {
  for (const [, v] of contexts) {
    try { if (!v.context.pages().every((p) => p.isClosed())) return true; } catch { /* 忽略 */ }
  }
  return contexts.size > 0;
}

export function currentBrowserAccount() {
  return [...contexts.keys()][0] || null;
}

/** 已打开浏览器的账号 id 列表 */
export function openBrowserAccounts() {
  return [...contexts.keys()];
}

function resolveAccount(accountId) {
  return sanitizeId(accountId || getCurrentAccountId() || 'acc-1');
}

/**
 * 启动（或复用）**指定账号**的浏览器上下文
 * @param {object} cfg 该账号的生效配置
 * @param {{ forceHeaded?: boolean }} [opts]
 */
export async function launchBrowser(cfg, opts = {}) {
  const accountId = resolveAccount(cfg?.account?.id);

  // 该账号已有打开的上下文 -> 复用
  const existing = contexts.get(accountId);
  if (existing) {
    log.debug(`复用账号 ${accountId} 已打开的浏览器`);
    return { context: existing.context, kind: existing.kind, accountId, reused: true };
  }

  ensureDirs(accountId);
  const bcfg = cfg.browser || {};
  const kind = bcfg.kind || 'msedge';
  const info = detectBrowser(kind);
  const headless = opts.forceHeaded ? false : bcfg.headless !== false;

  if (kind !== 'chromium' && !info.available) {
    throw new Error(`未检测到 ${info.label}，请在设置里改用 Chrome 或 Playwright Chromium。`);
  }

  const headlessArgs = headless
    ? ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--window-size=1440,900']
    : ['--start-maximized'];

  const options = {
    headless: false, // 由 args 控制，避免新版无头模式被 playwright 调整
    args: [
      ...headlessArgs,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=Translate,OptimizationHints,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion',
      `--lang=${bcfg.locale || 'zh-CN'}`,
    ],
    viewport: headless ? { width: 1440, height: 900 } : null,
    locale: bcfg.locale || 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    ignoreDefaultArgs: ['--enable-automation'],
    acceptDownloads: false,
  };

  options.channel = kind === 'chromium' ? 'chromium' : kind;
  const execPath = bcfg.executablePath || info.execPath;
  if (execPath && kind !== 'chromium') options.executablePath = execPath;

  const profileDir = accountProfileDir(accountId);
  log.info(`启动浏览器：${info.label}${headless ? '（后台无窗口）' : '（可见窗口）'} · 账号 ${accountId}`);
  log.debug(`该账号配置目录：${profileDir}`);

  const context = await chromium.launchPersistentContext(profileDir, options);
  contexts.set(accountId, { context, kind });

  context.setDefaultTimeout(bcfg.timeoutMs || 45000);
  context.setDefaultNavigationTimeout(bcfg.timeoutMs || 45000);

  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    } catch { /* 忽略 */ }
  });

  context.on('close', () => {
    contexts.delete(accountId);
    log.debug(`账号 ${accountId} 的浏览器已关闭`);
  });

  return { context, kind, accountId, reused: false };
}

/**
 * 关闭浏览器
 * @param {string} [accountId] 指定账号；不传则关闭所有账号的浏览器
 */
export async function closeBrowser(accountId) {
  const ids = accountId ? [resolveAccount(accountId)] : [...contexts.keys()];
  for (const id of ids) {
    const entry = contexts.get(id);
    if (!entry) continue;
    contexts.delete(id);
    try {
      await entry.context.close();
      log.debug(`账号 ${id} 的浏览器已关闭`);
    } catch (err) {
      log.warn(`关闭账号 ${id} 的浏览器出错:`, err.message);
    }
  }
}

/** 取一个工作页面 */
export async function getPage(ctx) {
  const pages = ctx.pages().filter((p) => !p.isClosed());
  return pages[0] || (await ctx.newPage());
}

/** 出错时截图，便于排查页面改版 */
export async function screenshot(name = 'shot', accountId = null) {
  const id = resolveAccount(accountId || getCurrentAccountId());
  const entry = contexts.get(id);
  if (!entry) return null;
  try {
    const path = await import('node:path');
    ensureDirs(id);
    const page = await getPage(entry.context);
    const file = path.join(accountShotDir(id), `${name}.png`);
    await page.screenshot({ path: file, fullPage: false });
    return file;
  } catch {
    return null;
  }
}

/* ---------------- 登录态 ---------------- */

/** 页头是否出现积分余额（已登录的最可靠标志） */
async function headerPoints(page) {
  try {
    return await page.evaluate(() => {
      for (const s of ['#id_rh_w', '#rh_rwm', '.points-container', '#id_rc']) {
        const el = document.querySelector(s);
        const v = (el?.textContent || '').replace(/[,\s]/g, '');
        if (el && /^\d{2,7}$/.test(v)) return v;
      }
      return null;
    });
  } catch {
    return null;
  }
}

/**
 * 检测是否已登录 Microsoft
 * 判定标准：必应页头出现积分余额，且页面上没有「登录以赚取奖励」提示。
 * 后者是权威的未登录标志（未登录时 Bing 会渲染示例数据，不能只看有没有积分元素）。
 */
export async function isSignedIn(page) {
  try {
    await page.goto('https://cn.bing.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    const body = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (/登录以赚取奖励|Sign in to earn|登录以赚取积分/i.test(body)) return false;
    const pts = await headerPoints(page);
    return !!pts;
  } catch {
    return false;
  }
}

/** 读取当前登录账号的显示名（用于自动标注账号） */
export async function readAccountName(page) {
  try {
    await page.goto('https://rewards.bing.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3500);
    return await page.evaluate(() => {
      // 未登录时 Rewards 会渲染示例数据并带「登录」字样，此时不取名字
      const body = document.body?.innerText || '';
      if (/登录以赚取奖励|登录后|Sign in/i.test(body) && !/可用积分|可用積分/.test(body)) return null;
      const el = document.querySelector('p.pii, p[class*="pii"]');
      const t = (el?.textContent || '').replace(/\s+/g, ' ').trim();
      return t || null;
    });
  } catch {
    return null;
  }
}

/**
 * 退出登录：彻底清除**该账号自己**配置目录里的 Microsoft / 必应身份。
 *
 * 为什么必须彻底：Microsoft 的 SSO（ESTSAUTH 等）若残留，下次打开 Rewards 会
 * 自动回落到上一个账号，于是出现「选了账号二、跑的却是账号一」。
 *
 * 流程：可见窗口走一次真实注销 -> 清空全部 Cookie -> 验证确实已登出。
 * 只影响传入账号的配置目录，其他账号不受影响。
 */
export async function signOut(cfg, onProgress = () => {}) {
  const accountId = resolveAccount(cfg?.account?.id);
  ensureDirs(accountId);
  log.info(`正在重置账号 ${accountId} 的登录状态…`);

  // 用可见窗口，确保注销脚本与重定向都能正常完成
  const { context } = await launchBrowser(
    { ...cfg, browser: { ...(cfg.browser || {}), headless: false } },
    { forceHeaded: true },
  );
  const page = await getPage(context);

  const isSignedOut = async () => {
    try {
      return await page.evaluate(() => {
        const body = document.body?.innerText || '';
        // Rewards 未登录时会显示登录入口
        const hasLoginCta = /登录后|登录以赚取奖励|Sign in to earn|使用 Microsoft 帐户登录|立即登录/.test(body);
        const avail = document.querySelector('a[href*="/redeem"] p.text-pageHeader');
        const points = avail ? Number((avail.innerText || '').replace(/[^\d]/g, '')) : null;
        return hasLoginCta || points == null;
      });
    } catch {
      return false;
    }
  };

  // 1) 真实注销（依次尝试多个注销端点，忽略单个失败）
  onProgress('正在注销当前会话…');
  for (const url of [
    'https://login.live.com/logout.srf',
    'https://login.microsoftonline.com/common/oauth2/v2.0/logout',
    'https://rewards.bing.com/',
  ]) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }

  // 2) 无条件清空该配置目录的全部 Cookie（最可靠）
  let cleared = 0;
  try {
    const all = await context.cookies();
    cleared = all.length;
    await context.clearCookies();
    // 再补一轮：有些 Cookie 会在清理过程中被重新种下
    await page.waitForTimeout(1200);
    await context.clearCookies();
  } catch (err) {
    log.warn('清空 Cookie 时出错：' + err.message);
  }
  onProgress(`已清除 ${cleared} 项 Cookie`);

  // 3) 验证是否真的登出（最多重试 3 次）
  let signedOut = false;
  for (let i = 0; i < 3 && !signedOut; i++) {
    await page.goto('https://rewards.bing.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);
    if (await isSignedOut()) {
      signedOut = true;
      break;
    }
    // 仍显示已登录 -> 再清一次并重走注销
    await context.clearCookies().catch(() => {});
    await page.goto('https://login.live.com/logout.srf', { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }

  if (signedOut) {
    log.success(`账号 ${accountId} 已登出（清除 ${cleared} 项 Cookie）。请重新点「登录」并用本账号登录。`);
  } else {
    log.warn(`账号 ${accountId} 的注销可能未完全生效：页面仍显示已登录。`);
    log.warn('  请在刚打开的浏览器窗口中手动访问 https://login.live.com/logout.srf 完成注销，再点「登录」。');
  }
  return { ok: signedOut, cleared };
}

/**
 * 引导用户手动登录：打开可见窗口，等待登录完成
 */
export async function guideLogin(cfg, onProgress = () => {}, timeoutMs = 4 * 60 * 1000) {
  onProgress('正在打开浏览器窗口，请在弹出的窗口中登录你的 Microsoft 账号…');
  const { context } = await launchBrowser(cfg, { forceHeaded: true });
  const page = await getPage(context);

  // login.live.com 在自动化环境下可能返回 HTTP/2 协议错误，故用 Rewards 页作入口
  await page.goto('https://rewards.bing.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(4000);
  onProgress('浏览器已打开。若页面出现已保存的账号，请点选它；否则输入邮箱与密码，并完成验证码/手机验证。');

  const deadline = Date.now() + timeoutMs;
  let lastNotice = 0;
  let autoClicked = false;
  const safeHost = () => { try { return new URL(page.url()).host; } catch { return ''; } };

  try {
    while (Date.now() < deadline) {
      if (page.isClosed()) return { ok: false, message: '浏览器窗口被关闭，登录已取消。' };
      await page.waitForTimeout(3000);

      const host = safeHost();

      // 仅在登录页、且只尝试一次，帮用户点选已保存的账号磁贴（不代替输入凭据）
      if (!autoClicked && /login\.live\.com|login\.microsoftonline\.com|login\.microsoft\.com/.test(host)) {
        const clicked = await page.evaluate(() => {
          try {
            const tiles = [...document.querySelectorAll('#tilesHolder .tile, #otherTile, div[data-bid]')]
              .filter((el) => {
                const r = el.getBoundingClientRect();
                return r.width > 60 && r.height > 40;
              });
            if (tiles.length) { tiles[0].click(); return true; }
          } catch { /* 忽略 */ }
          return false;
        }).catch(() => false);
        if (clicked) {
          autoClicked = true;
          onProgress('已自动点选浏览器中保存的账号，如需输入密码请手动完成。');
        }
      }

      /*
       * 已登录判定：**以 Rewards 页面为准**。
       * 不能只看必应页头 —— 页头可能停在另一个账号上，会误判为登录成功，
       * 之后便用错误的会话去搜索（这正是「选了账号二却按账号一跑」的成因）。
       */
      const rewardsState = await page.evaluate(() => {
        const body = document.body?.innerText || '';
        const clean = (el) => (el ? (el.innerText || '').replace(/\s+/g, ' ').trim() : '');
        const avail = document.querySelector('a[href*="/redeem"] p.text-pageHeader');
        const points = avail ? Number(clean(avail).replace(/[^\d]/g, '')) : null;
        const signInHint = /登录后|登录以赚取奖励|Sign in to earn|使用 Microsoft 帐户登录/.test(body);
        const name = clean(document.querySelector('p.pii, p[class*="pii"]'));
        return { points, signInHint, name, host: location.host };
      }).catch(() => null);

      const onRewards = /rewards\.bing\.com|microsoft\.com/.test(host);
      const loggedIn = !!(rewardsState && onRewards && !rewardsState.signInHint
        && rewardsState.points != null);

      if (loggedIn) {
        onProgress('检测到登录成功，正在保存登录状态…');
        // 顺带确认必应会话是否也是同一账号（不一致时提示，避免后续搜索算错账号）
        await page.goto('https://cn.bing.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await page.waitForTimeout(3500);
        const headerVal = await page.evaluate(() => {
          for (const s of ['#id_rh_w', '#rh_rwm', '.points-container', '#id_rc']) {
            const el = document.querySelector(s);
            const v = (el?.textContent || '').replace(/[,\s]/g, '');
            if (el && /^\d{2,7}$/.test(v)) return Number(v);
          }
          return null;
        }).catch(() => null);

        const mismatch = headerVal != null && rewardsState.points != null
          && homeValueMismatch(headerVal, rewardsState.points);
        if (mismatch) {
          onProgress(`注意：必应页头显示 ${headerVal} 分，与本账号的 ${rewardsState.points} 分不一致，`
            + '说明必应会话可能仍是别的账号。建议在必应首页确认已切换为本账号。');
        }

        // 回到 Rewards 页保存状态
        await page.goto('https://rewards.bing.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await page.waitForTimeout(3000);
        return { ok: true, name: rewardsState.name || null, bingPoints: headerVal, rewardsPoints: rewardsState.points, sessionMismatch: mismatch };
      }

      if (Date.now() - lastNotice > 20000) {
        lastNotice = Date.now();
        const remain = Math.ceil((deadline - Date.now()) / 1000);
        onProgress(`等待登录中…（剩余 ${remain} 秒）`);
      }
    }
  } catch (err) {
    return { ok: false, message: '登录过程中浏览器被关闭或出错：' + err.message };
  }
  return { ok: false, message: '登录等待超时，请重试。' };
}
