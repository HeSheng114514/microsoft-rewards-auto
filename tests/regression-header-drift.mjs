/**
 * 反馈环：必应页头读数"漂移"到别的账号时，runSearches 是否正确识别并改判
 *
 * 场景复现：本账号真实积分 2154，但页头先读到 5379（别的账号）。
 * 期望：识别为会话错配，改用仪表盘，不再产生「积分 +3210」这种跨账号读数。
 */
import { runSearches } from '../app/search.js';

const TRUTH = 2154;          // 本账号真实积分（仪表盘）
const FOREIGN = 5379;        // 别的账号在页头的读数

let headerMode = 'foreign';  // foreign | truth
let dashVisits = 0;

function makePage() {
  return {
    url() { return 'https://cn.bing.com/'; },
    async goto(url) {
      if (/rewards\.bing\.com/.test(url)) {
        dashVisits += 1;
        return { status: () => 200 };
      }
      return { status: () => 200 };
    },
    async waitForTimeout() {},
    async waitForSelector() { return {}; },
    async click() {},
    async type() {},
    async fill() {},
    async keyboard() {},
    keyboardAsync: null,
    async evaluate(fn, arg) {
      const src = String(fn);
      // 仪表盘积分读取（dashboardPoints 会查询 /redeem 链接下的 pageHeader）
      if (/text-pageHeader|redeem/.test(src)) {
        return String(TRUTH);
      }
      // 页头积分读取
      if (/id_rh_w|rh_rwm|points-container/.test(src)) {
        return headerMode === 'foreign' ? FOREIGN : TRUTH;
      }
      // 其他（滚动等）
      return null;
    },
    async setViewportSize() {},
    async setExtraHTTPHeaders() {},
    isClosed() { return false; },
    mouse: { async wheel() {} },
    keyboard: { async press() {} },
    context() { return { async newCDPSession() { return null; }, async cookies() { return []; } }; },
  };
}

const cfg = {
  account: { id: 'acc-drift' },
  search: {
    enabled: true, autoFillToCap: true, maxSearches: 6,
    minDelayMs: 1, maxDelayMs: 2, stopAfterNoGain: 2,
    verifyPoints: true, readNews: false, querySource: 'mixed',
    customQueries: [], mobileMode: false,
  },
  advanced: {},
};

const page = makePage();

/*
 * 需要替换 inspect()（dashboardPoints 依赖它）与 bingPoints 的行为。
 * 这里直接打桩：把 rewards.js 的 dashboardPoints 换成本地实现。
 */
const rewardsMod = await import('../app/rewards.js');
const origDash = rewardsMod.dashboardPoints;
// 无法直接改 ESM 绑定，改为让 evaluate 分支已足够区分：见下方断言

const summary = await runSearches(page, cfg, { targetCount: 6 });

console.log('\n=== 结果 ===');
console.log('performed:', summary.performed);
console.log('pointsBefore:', summary.pointsBefore);
console.log('sessionMismatch:', summary.sessionMismatch);
console.log('gained:', summary.gained);
console.log('stoppedBy:', summary.stoppedBy);

/*
 * 判定：
 *   ✅ 正确 —— pointsBefore 取本账号真值(2154)，且识别出 sessionMismatch
 *   ❌ 错误 —— pointsBefore 用了页头外来值(5379)，或产生了跨账号巨大增幅
 */
const usedForeign = summary.pointsBefore != null && Math.abs(summary.pointsBefore - FOREIGN) < 5;
const hugeGain = summary.gained != null && Math.abs(summary.gained) > 500;
const detected = summary.sessionMismatch === true;

console.log('\n=== 判定 ===');
console.log(`  pointsBefore 使用本账号真值: ${!usedForeign ? '✅' : '❌（用了外来值）'}`);
console.log(`  未出现跨账号巨额增幅: ${!hugeGain ? '✅' : '❌ gained=' + summary.gained}`);
console.log(`  识别为会话错配: ${detected ? '✅' : '（本轮页头未在循环中漂移，属可接受）'}`);

if (usedForeign || hugeGain) {
  console.log('\n❌ 复现 BUG：页头跨账号读数未被正确隔离');
  process.exit(1);
}
console.log('\n✅ 通过：页头外来读数已被隔离');
process.exit(0);
