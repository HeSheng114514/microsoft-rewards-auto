/**
 * 反馈环：模拟网络完全断开时，runSearches 的行为
 *
 * 用假 page 对象模拟所有导航都抛 ERR_CONNECTION_CLOSED，
 * 断言工具应当"快速失败"而不是跑满 target 次。
 *
 * 用法: node tools/repro-offline-search.mjs
 * 退出码 0 = 行为正确；1 = 复现了 bug（跑满次数）
 */
import { runSearches } from '../app/search.js';

/** 造一个假 page：所有导航都失败，记录调用次数 */
function makeOfflinePage() {
  const stats = { goto: 0, evaluate: 0 };
  const page = {
    async goto(url) {
      stats.goto += 1;
      const err = new Error(
        `page.goto: net::ERR_CONNECTION_CLOSED at ${url}\nCall log:\n  - navigating to "${url}", waiting until "domcontentloaded"`,
      );
      err.name = 'Error';
      throw err;
    },
    async evaluate() { stats.evaluate += 1; return null; },
    async waitForTimeout() {},
    async waitForSelector() { throw new Error('page.waitForSelector: Target page closed'); },
    async click() { throw new Error('closed'); },
    async type() { throw new Error('closed'); },
    async fill() { throw new Error('closed'); },
    async keyboard() { throw new Error('closed'); },
    keyboard: { async press() { throw new Error('closed'); } },
    mouse: { async wheel() {} },
    async setViewportSize() {},
    async setExtraHTTPHeaders() {},
    context() {
      return {
        async newCDPSession() { return null; },
        async cookies() { return []; },
      };
    },
    isClosed() { return false; },
  };
  return { page, stats };
}

const cfg = {
  account: { id: 'acc-test' },
  search: {
    enabled: true,
    autoFillToCap: true,
    maxSearches: 40,
    minDelayMs: 100,
    maxDelayMs: 200,
    stopAfterNoGain: 3,
    verifyPoints: true,
    readNews: false,
    querySource: 'mixed',
    customQueries: [],
    mobileMode: false,
  },
  advanced: {},
};

const t0 = Date.now();
const { page, stats } = makeOfflinePage();

let result;
let threw = null;
try {
  result = await runSearches(page, cfg, { targetCount: 40 });
} catch (e) {
  threw = e;
}
const elapsed = Date.now() - t0;

console.log('=== 离线场景测试结果 ===');
console.log(`耗时: ${elapsed} ms`);
console.log(`goto 调用次数: ${stats.goto}`);
console.log(`抛异常: ${threw ? threw.message.slice(0, 80) : '否'}`);
if (result) {
  console.log(`performed: ${result.performed}`);
  console.log(`stoppedBy: ${result.stoppedBy}`);
  console.log(`consecutiveErrors: ${result.consecutiveErrors ?? '(未记录)'}`);
}

/*
 * 判定：
 *   期望行为 —— 连续网络错误若干次后应当**提前中止**，
 *              而不是把 40 次全部跑完。
 *   bug 行为 —— 跑满 target 次（goto 次数 ≈ 40）
 */
const MAX_ACCEPTABLE_GOTO = 10;
const abortedEarly = stats.goto <= MAX_ACCEPTABLE_GOTO;

console.log('\n=== 判定 ===');
if (abortedEarly) {
  console.log(`✅ 已提前中止（仅尝试 ${stats.goto} 次）—— 行为正确`);
  process.exit(0);
} else {
  console.log(`❌ 复现 BUG：网络完全断开却仍尝试了 ${stats.goto} 次搜索（应 ≤ ${MAX_ACCEPTABLE_GOTO}）`);
  process.exit(1);
}
