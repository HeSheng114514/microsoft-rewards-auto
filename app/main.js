/**
 * 主入口
 *   node app/main.js                    启动控制台（默认，按计划自动执行所有账号）
 *   node app/main.js --once             立即执行一次后退出
 *   node app/main.js --once --all       依次执行全部启用的账号
 *   node app/main.js --account=acc-2 ... 指定账号（配合 --once / --login）
 *   node app/main.js --login            打开浏览器引导登录
 *   node app/main.js --add-account [名称] 新增账号
 *   node app/main.js --list-accounts    列出所有账号
 *   node app/main.js --tray             仅后台托盘常驻（不打开控制台）
 *   node app/main.js --install-tray     注册开机自启
 *   node app/main.js --uninstall-tray   取消开机自启
 *   node app/main.js --status           打印当前状态
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, DATA_DIR, LOCK_FILE, ensureDirs } from './paths.js';
import { log, pruneLogs } from './logger.js';
import {
  getAccounts, getAccount, addAccount, resolveAccountConfig, loadSettings, saveAccountOverrides,
} from './config.js';
import { loadState, saveState } from './store.js';
import { runOnce } from './runner.js';
import { startScheduler } from './scheduler.js';
import { createServer } from './server.js';
import { startTray, stopTray, setTrayEnabled, setAutostart, checkTrayHealth } from './tray.js';
import { guideLogin, closeBrowser } from './browser.js';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const argValue = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const STARTUP_FLAG = path.join(DATA_DIR, '.booting');

/* ---------------- 单实例保护 ---------------- */
function readLock() {
  try {
    if (!fs.existsSync(LOCK_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (data.pid) {
      try { process.kill(data.pid, 0); return data; } catch { /* 进程已退出 */ }
    }
  } catch { /* 忽略 */ }
  return null;
}

function writeLock() {
  ensureDirs();
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8');
}

function clearLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch { /* 忽略 */ }
}

function openUrl(url) {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else {
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

async function consoleAlreadyRunning(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** 选择目标账号：--account= 指定，否则取第一个启用的账号 */
function pickAccount() {
  const id = argValue('account');
  if (id) {
    const acc = getAccount(id);
    if (!acc) {
      log.error(`未找到账号 ${id}。可用 --list-accounts 查看。`);
      process.exit(1);
    }
    return acc;
  }
  const accounts = getAccounts();
  const acc = accounts.find((a) => a.enabled !== false) || accounts[0];
  if (!acc) {
    log.error('还没有任何账号，请先执行：node app/main.js --add-account 名称');
    process.exit(1);
  }
  return acc;
}

/* ---------------- 各模式实现 ---------------- */
async function modeOnce() {
  if (has('--all')) {
    const list = getAccounts().filter((a) => a.enabled !== false);
    log.info(`依次执行 ${list.length} 个账号`);
    let failed = 0;
    for (const a of list) {
      const res = await runOnce({ trigger: 'cli', accountId: a.id });
      if (!res.ok) failed += 1;
    }
    await closeBrowser();
    process.exit(failed ? 1 : 0);
  }
  const acc = pickAccount();
  log.info(`单次执行模式 · 账号 [${acc.label}]`);
  const res = await runOnce({ trigger: 'cli', accountId: acc.id });
  await closeBrowser();
  process.exit(res.ok ? 0 : 1);
}

async function modeLogin() {
  const acc = pickAccount();
  const cfg = resolveAccountConfig(acc.id);
  log.info(`登录引导 · 账号 [${acc.label}]：请在弹出的浏览器窗口中登录 Microsoft 账号。`);
  const r = await guideLogin(cfg, (m) => log.info(m));
  if (r.ok) {
    if (r.name) saveAccountOverrides(acc.id, { emailHint: r.name });
    const cur = loadState(acc.id);
    saveState(acc.id, {
      account: { ...cur.account, signedIn: true, name: r.name || null, updatedAt: new Date().toISOString() },
    });
    log.success(`账号 [${acc.label}] 登录完成，登录状态已保存。`);
    console.log('\n✅ 登录成功！现在可以启动自动签到：npm start\n');
  } else {
    log.error('登录未完成：' + (r.message || '未知原因'));
  }
  await closeBrowser();
  process.exit(r.ok ? 0 : 1);
}

async function modeAddAccount() {
  const nameArg = args.find((a) => !a.startsWith('--') && a !== process.argv[1]);
  const acc = addAccount({ label: nameArg || `账号 ${getAccounts().length + 1}` });
  ensureDirs(acc.id);
  log.success(`已新增账号 [${acc.label}]（${acc.id}）`);
  console.log(`\n下一步：为该账号登录\n  node app/main.js --login --account=${acc.id}\n`);
  process.exit(0);
}

async function modeListAccounts() {
  const accounts = getAccounts();
  const settings = loadSettings();
  console.log('账号列表：');
  for (const a of accounts) {
    const st = loadState(a.id);
    const cfg = resolveAccountConfig(a.id);
    console.log(`  ${a.id}  ${a.label}${a.emailHint ? ` <${a.emailHint}>` : ''}`
      + `  ${a.enabled === false ? '[已停用]' : '[启用]'}`
      + `  登录:${st.account?.signedIn ? '是' : '否'}`
      + `  积分:${st.account?.points ?? '—'}`
      + `  定时:${settings.application.schedule.enabled === false ? '关闭' : settings.application.schedule.dailyTimes.join('/')}`
      + `  搜索上限:${cfg.search.maxSearches}${cfg.search.mobileMode ? ' 移动端' : ''}`);
  }
  process.exit(0);
}

async function modeInstallTray() {
  const settings = loadSettings();
  settings.application.tray = { ...settings.application.tray, enabled: true, autostart: true };
  const { saveApplication } = await import('./config.js');
  saveApplication({ tray: settings.application.tray });
  await setAutostart(true);
  log.info('已注册开机自启。托盘需要主程序运行时才能启动，请在主程序运行后保持托盘开启。');
  process.exit(0);
}

async function modeUninstallTray() {
  await setAutostart(false);
  await stopTray();
  process.exit(0);
}

async function modeStatus() {
  const settings = loadSettings();
  const accounts = getAccounts().map((a) => {
    const st = loadState(a.id);
    return {
      id: a.id,
      label: a.label,
      enabled: a.enabled !== false,
      signedIn: st.account?.signedIn || false,
      points: st.account?.points ?? null,
      lastRun: st.lastRun || null,
      lastResult: st.lastResult || null,
      todayRuns: st.todayRuns || 0,
      totalRuns: st.totalRuns || 0,
      totalPointsEarned: st.totalPointsEarned || 0,
    };
  });
  console.log(JSON.stringify({ schedule: settings.application.schedule, accounts }, null, 2));
  process.exit(0);
}

/** 后台托盘模式（不启动控制台 UI） */
async function modeTrayOnly() {
  const lock = readLock();
  if (lock) {
    log.info('主程序已在运行（PID ' + lock.pid + '），本进程退出。');
    process.exit(0);
  }
  writeLock();
  startScheduler();
  await startTray();
  log.info('后台托盘模式已启动。');
  setInterval(() => { /* 守护 */ }, 1 << 30);
}

/** 默认模式：控制台 + 调度器 + 托盘 */
async function modeConsole() {
  ensureDirs();
  const settings = loadSettings();
  const port = Number(settings.application.server?.port || 8787);

  const lock = readLock();
  if (lock) {
    log.warn(`检测到程序已在运行（PID ${lock.pid}）。`);
    if (await consoleAlreadyRunning(port)) {
      log.info('正在打开已运行的控制台页面…');
      openUrl(`http://127.0.0.1:${port}`);
    }
    process.exit(0);
  }

  if (await consoleAlreadyRunning(port)) {
    log.error(`端口 ${port} 已被其他程序占用。请修改 data/settings.json 中 server.port 后重试。`);
    process.exit(1);
  }

  writeLock();
  pruneLogs(settings.application.advanced?.logRetentionDays || 14);

  const { listen } = createServer();
  let url;
  try {
    ({ url } = await listen());
  } catch (err) {
    log.error('控制台启动失败：' + err.message);
    clearLock();
    process.exit(1);
  }

  startScheduler();

  if (settings.application.server?.openOnStart !== false) {
    setTimeout(() => openUrl(url), 600);
  }

  const booting = fs.existsSync(STARTUP_FLAG);
  if (booting) { try { fs.unlinkSync(STARTUP_FLAG); } catch { /* 忽略 */ } }

  if (settings.application.tray?.enabled !== false) {
    setTimeout(() => {
      startTray().then(async () => {
        setTimeout(async () => {
          const h = await checkTrayHealth();
          if (!h.alive) log.warn('托盘未成功启动，可稍后在设置中重新开启。');
          else log.debug('托盘进程探活正常，PID=' + h.pid);
        }, 3000);
      });
    }, 1500);
  }

  if (settings.application.tray?.autostart !== false && !booting) {
    const startupDir = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    const lnk = path.join(startupDir, 'Microsoft Rewards 自动签到.lnk');
    if (startupDir && fs.existsSync(startupDir) && !fs.existsSync(lnk)) {
      await setAutostart(true).catch(() => {});
    }
  }

  const accounts = getAccounts();
  const enabled = accounts.filter((a) => a.enabled !== false);
  const notLoggedIn = accounts.filter((a) => !loadState(a.id).account?.signedIn);

  log.info('──────────────────────────────────────────');
  log.info(`已加载 ${accounts.length} 个账号（启用 ${enabled.length} 个）`);
  if (notLoggedIn.length) {
    log.warn(`以下账号尚未登录，请在控制台点击「登录」：${notLoggedIn.map((a) => a.label).join('、')}`);
  }
  log.info('保持本进程运行即可按计划自动执行；可关闭控制台页面，程序会继续在托盘后台运行。');
  log.info(`控制台地址：${url}`);
  log.info('──────────────────────────────────────────');
}

/* ---------------- 参数分发 ---------------- */
(async () => {
  try {
    if (has('--help') || has('-h')) {
      console.log(`Microsoft Rewards 自动签到（支持多账号）

用法：
  node app/main.js                       启动控制台（默认）
  node app/main.js --once                立即执行一次后退出
  node app/main.js --once --all          依次执行全部启用的账号
  node app/main.js --once --account=acc-2 只执行指定账号
  node app/main.js --login               引导登录（配合 --account= 指定账号）
  node app/main.js --add-account [名称]   新增账号
  node app/main.js --list-accounts       列出所有账号
  node app/main.js --tray                仅后台托盘常驻
  node app/main.js --install-tray        注册开机自启
  node app/main.js --uninstall-tray      取消开机自启
  node app/main.js --status              打印当前状态
`);
      process.exit(0);
    }

    if (has('--add-account')) return modeAddAccount();
    if (has('--list-accounts')) return modeListAccounts();
    if (has('--once')) return modeOnce();
    if (has('--login')) return modeLogin();
    if (has('--install-tray')) return modeInstallTray();
    if (has('--uninstall-tray')) return modeUninstallTray();
    if (has('--status')) return modeStatus();
    if (has('--tray')) return modeTrayOnly();
    return modeConsole();
  } catch (err) {
    log.error('程序启动失败：' + (err.stack || err.message));
    clearLock();
    process.exit(1);
  }
})();

/* ---------------- 优雅退出 ---------------- */
let exiting = false;
async function shutdown(signal) {
  if (exiting) return;
  exiting = true;
  log.info(`收到 ${signal}，正在退出…`);
  try {
    const { stopScheduler } = await import('./scheduler.js');
    stopScheduler();
  } catch { /* 忽略 */ }
  await closeBrowser().catch(() => {});
  clearLock();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  log.error('未捕获异常：' + (err.stack || err.message));
});
process.on('unhandledRejection', (err) => {
  log.error('未处理的 Promise 拒绝：' + (err?.stack || err));
});
