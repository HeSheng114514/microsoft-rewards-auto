/**
 * 网络健康判定与熔断
 *
 * 背景：曾出现网络整体断开（ERR_CONNECTION_CLOSED）时，工具仍在傻跑满 40 次搜索，
 * 每次都要等 60 秒超时，随后三个任务阶段又各自等一次超时——白白耗时十几分钟，
 * 而且日志里全是重复的超时噪声，看不出「其实是断网了」。
 *
 * 这里提供两件事：
 *   1. 错误分类：把 Playwright 的报错归类为 offline / timeout / other
 *   2. 熔断器：连续若干次 offline 错误后判定网络不可用，让上层快速中止整轮
 */
import { log } from './logger.js';

/** 明确的「网络不可用 / 连接被掐断」类错误特征 */
const OFFLINE_PATTERNS = [
  /ERR_CONNECTION_CLOSED/i,
  /ERR_CONNECTION_RESET/i,
  /ERR_CONNECTION_REFUSED/i,
  /ERR_CONNECTION_TIMED_OUT/i,
  /ERR_INTERNET_DISCONNECTED/i,
  /ERR_NETWORK_CHANGED/i,
  /ERR_NAME_NOT_RESOLVED/i,
  /ERR_NAME_RESOLUTION_FAILED/i,
  /ERR_ADDRESS_UNREACHABLE/i,
  /ERR_TUNNEL_CONNECTION_FAILED/i,
  /ERR_PROXY_CONNECTION_FAILED/i,
  /ERR_SSL_PROTOCOL_ERROR/i,
  /ERR_EMPTY_RESPONSE/i,
  /net::ERR_/i,
  /chrome-error:\/\/chromewebdata/i,
  // Edge 在连接失败时会把导航"打断"到错误页
  /interrupted by another navigation to "chrome-error/i,
  /Target page, context or browser has been closed/i,
  /Protocol error \(Page\.navigate\)/i,
];

/** 超时类（可能是网络慢，也可能是断网导致） */
const TIMEOUT_PATTERNS = [
  /Timeout \d+ms exceeded/i,
  /page\.goto: Timeout/i,
  /waitForSelector: Timeout/i,
  /waitForFunction: Timeout/i,
  /NS_BINDING_ABORTED/i,
];

/**
 * 归类错误
 * @param {Error|string} err
 * @returns {'offline'|'timeout'|'other'}
 */
export function classifyNetError(err) {
  const msg = typeof err === 'string' ? err : (err?.message || String(err || ''));
  if (!msg) return 'other';
  if (OFFLINE_PATTERNS.some((re) => re.test(msg))) return 'offline';
  if (TIMEOUT_PATTERNS.some((re) => re.test(msg))) return 'timeout';
  return 'other';
}

export function isOfflineError(err) {
  return classifyNetError(err) === 'offline';
}

/**
 * 熔断器：累计连续的网络失败
 *
 * 用法：
 *   const guard = new NetworkGuard({ threshold: 3 });
 *   try { ... } catch (e) { guard.recordFailure(e); }
 *   成功一次就 guard.recordSuccess()
 *   if (guard.isOffline()) 中止本轮
 */
export class NetworkGuard {
  constructor({ threshold = 3, name = '' } = {}) {
    this.threshold = Math.max(1, threshold);
    this.name = name;
    this.consecutive = 0;
    this.totalOffline = 0;
    this.lastError = null;
    this.tripped = false;
  }

  recordFailure(err) {
    const kind = classifyNetError(err);
    if (kind === 'offline') {
      this.consecutive += 1;
      this.totalOffline += 1;
      this.lastError = err?.message || String(err || '');
      if (this.consecutive >= this.threshold && !this.tripped) {
        this.tripped = true;
        log.error(
          `${this.name ? `[${this.name}] ` : ''}连续 ${this.consecutive} 次网络错误，判定当前网络不可用，`
          + '本轮已中止（避免继续无效重试）。',
        );
        log.warn(`  最后一次错误：${this.lastError.split('\n')[0].slice(0, 160)}`);
        log.warn('  请检查：网络连接 / 代理设置 / 是否被防火墙或 DNS 拦截，恢复后可重新执行。');
      }
    } else if (kind === 'timeout') {
      // 超时不直接算断网，但连续超时同样可疑，计数减半递进
      this.consecutive += 0.5;
      this.lastError = err?.message || String(err || '');
      if (this.consecutive >= this.threshold && !this.tripped) {
        this.tripped = true;
        log.error(
          `${this.name ? `[${this.name}] ` : ''}连续多次超时，判定网络连接异常，本轮已中止。`,
        );
        log.warn(`  最后一次错误：${this.lastError.split('\n')[0].slice(0, 160)}`);
      }
    }
    return kind;
  }

  recordSuccess() {
    this.consecutive = 0;
  }

  isOffline() {
    return this.tripped;
  }

  /** 供上层抛出、中断整轮流程 */
  toError(stepLabel = '') {
    const msg = `网络不可用${stepLabel ? `（${stepLabel}）` : ''}：连续 ${this.totalOffline} 次连接失败，已中止本轮`;
    const err = new Error(msg);
    err.code = 'NETWORK_OFFLINE';
    err.isNetworkOffline = true;
    return err;
  }
}

/**
 * 判断当前页面是否已是浏览器错误页（Edge/Chrome 连接失败时）
 * @param {import('playwright-core').Page} page
 */
export async function isErrorPage(page) {
  try {
    const url = page.url() || '';
    if (/^chrome-error:\/\//.test(url)) return true;
    return await page.evaluate(() => {
      // Chrome/Edge 错误页特征
      const body = document.body?.innerText || '';
      return /ERR_[A-Z_]+|无法访问此网站|This site can.?t be reached|检查代理服务器/.test(body);
    });
  } catch {
    return false;
  }
}

/**
 * 安全导航：带重试与错误页恢复
 *
 * 解决的真实问题：Rewards 是 SPA，页面内部还会发起导航；
 * 当我们的 goto 与它互相打断时，会得到
 *   `Navigation to "..." is interrupted by another navigation to "chrome-error://chromewebdata/"`
 * 之后页面停留在错误页，后续任何操作都失败。
 *
 * 策略：
 *   1. 首次失败且是「被打断」类 -> 先停稳（等 load）再重试
 *   2. 若已在 chrome-error 页 -> 先导航到 about:blank 复位，再重试
 *   3. 重试用尽则抛出，由上层决定（熔断器会记录）
 *
 * @param {import('playwright-core').Page} page
 * @param {string} url
 * @param {{timeout?:number, attempts?:number, waitUntil?:string, label?:string}} [opts]
 */
export async function safeGoto(page, url, opts = {}) {
  const timeout = Math.max(5000, Number(opts.timeout || 30000));
  const attempts = Math.max(1, Number(opts.attempts || 3));
  const waitUntil = opts.waitUntil || 'domcontentloaded';
  let lastErr = null;

  for (let i = 1; i <= attempts; i++) {
    try {
      // 页面卡在错误页时，先复位，否则下一次导航常被"打断"
      if (await isErrorPage(page)) {
        await page.goto('about:blank', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(300);
      }
      const res = await page.goto(url, { waitUntil, timeout });
      // 导航完成但仍落到错误页 -> 视为失败
      if (await isErrorPage(page)) {
        throw new Error('navigation landed on chrome-error page');
      }
      return res;
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || '');
      const interrupted = /interrupted by another navigation/i.test(msg);
      const transient = interrupted || /ERR_ABORTED|NS_BINDING_ABORTED/i.test(msg);

      // 断网类错误不在这里重试（交给熔断器判定，重试只会浪费时间）
      if (classifyNetError(err) === 'offline' && !interrupted) {
        throw err;
      }
      if (i >= attempts) break;

      // 被内部导航打断：等页面自己稳定一下再重试
      const wait = interrupted ? 1500 : 800;
      await page.waitForTimeout(wait).catch(() => {});
      try {
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 });
      } catch { /* 忽略 */ }
    }
  }
  const label = opts.label ? `${opts.label}: ` : '';
  throw new Error(`${label}打开页面失败（重试 ${attempts} 次）：${String(lastErr?.message || '').split('\n')[0]}`);
}

/** 把网络类错误的超时压短，避免单次失败代价过高 */
export const FAST_FAIL_TIMEOUT_MS = 15000;

/**
 * 网络连通性预检：尝试打开 Rewards 仪表盘
 *
 * 目的：断网时在**最开始**就给出明确结论，而不是让每个阶段各等一次 60 秒超时。
 * @param {import('playwright-core').Page} page
 * @param {{url?: string, timeout?: number}} [opts]
 * @returns {Promise<{ok:boolean, reason?:string, detail?:string, kind?:string}>}
 */
export async function checkNetwork(page, opts = {}) {
  const url = opts.url || 'https://rewards.bing.com/dashboard';
  const timeout = Math.max(5000, Number(opts.timeout || FAST_FAIL_TIMEOUT_MS));

  /*
   * 注意：不能一上来就用 isErrorPage() 短路返回失败。
   * 页面可能只是**上一次**导航失败后停留在错误页，而当前网络其实已恢复。
   * 正确做法是：先真正尝试导航，失败后再看是否落到错误页。
   */
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    const status = res ? res.status() : null;

    /*
     * 关于 "页面是否有内容"：不能用「domcontentloaded 后立刻读 innerText」判断。
     * Rewards 是 React 流式渲染，DOMContentLoaded 时页面往往还是空壳，
     * 实测会误判成"断网"。因此改为**等待关键元素出现**（最多若干秒）。
     */
    const ready = await page.waitForFunction(
      () => {
        const t = (document.body?.innerText || '').trim();
        // 足够长的正文，或出现了 Rewards 的标志性容器
        return t.length > 60
          || !!document.querySelector('#shell, #dailyset, #streaks, #quests, a[href*="/redeem"]');
      },
      undefined,
      { timeout: Math.min(20000, timeout) },
    ).then(() => true).catch(() => false);

    if (await isErrorPage(page)) {
      return {
        ok: false, kind: 'offline',
        reason: `页面被重定向到浏览器错误页${status ? `（HTTP ${status}）` : ''}`,
        detail: `HTTP ${status ?? 'n/a'} @ ${url}`,
      };
    }

    // 渲染完成 -> 网络是通的，即使状态码不是 200 也放行
    if (ready) {
      return { ok: true, httpStatus: status ?? null };
    }

    // 等不到内容 + 有 4xx/5xx -> 判为站点不可用
    if (status != null && status >= 400) {
      return {
        ok: false, kind: 'server',
        reason: `站点返回 HTTP ${status} 且页面未渲染出内容`,
        detail: `HTTP ${status} @ ${url}`,
      };
    }

    return { ok: false, kind: 'timeout', reason: '页面在限定时间内未渲染出内容（可能连接极慢或被拦截）' };
  } catch (err) {
    const kind = classifyNetError(err);
    const detail = String(err?.message || '').split('\n')[0].slice(0, 200);
    if (kind === 'offline') {
      return { ok: false, kind: 'offline', reason: '无法连接到 Rewards 站点（网络断开或被拦截）', detail };
    }
    if (kind === 'timeout') {
      return { ok: false, kind: 'timeout', reason: `连接超时（${Math.round(timeout / 1000)} 秒内未完成）`, detail };
    }
    return { ok: false, kind: 'other', reason: '打开 Rewards 页面失败', detail };
  }
}
