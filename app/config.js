/**
 * 配置管理：全局默认设置 + 账号列表 + 账号级覆盖
 *
 * data/settings.json
 * {
 *   application: { schedule, browser, search, tasks, server, tray, advanced },
 *   accounts: [
 *     { id, label, emailHint, enabled, createdAt,
 *       overrides: { search: {...}, tasks: {...}, browser: {...} } }
 *   ]
 * }
 *
 * 新账号会继承当时的全局设置作为自身初始值，之后各自独立修改。
 */
import fs from 'node:fs';
import {
  DATA_DIR, SETTINGS_FILE, LEGACY_CONFIG_FILE, ACCOUNTS_DIR,
  ensureDirs, accountDir, sanitizeId,
} from './paths.js';

/* ---------------- 默认值 ---------------- */

export const DEFAULT_APPLICATION = {
  schedule: {
    enabled: true,              // 总开关：打开软件即按计划自动执行
    mode: 'daily',              // daily=每天固定时刻 | interval=每隔 N 分钟
    dailyTimes: ['09:10'],      // mode=daily 时的执行时刻，支持多个
    intervalMinutes: 240,       // mode=interval 时的间隔
    runOnStart: false,          // 软件启动后忽略计划时刻，强制补跑一次（catchUp 已能覆盖大多数场景）
    catchUp: true,              // 错过计划时刻是否在窗口内补跑（**强烈建议保持开启**）
    catchUpHours: 12,           // 补跑窗口（小时）。超过这个时长就不再补跑，避免深夜任务被白天无意义地补
    maxRunsPerDay: 2,           // 每个账号每天最多自动执行次数
    skipWeekends: false,
    staggerSeconds: 90,         // 多账号之间的错峰启动间隔（秒）
  },
  browser: {
    kind: 'msedge',             // msedge | chrome | chromium
    headless: true,             // 无窗口运行（推荐）
    executablePath: '',         // 留空自动探测
    locale: 'zh-CN',
    market: 'zh-CN',
    timeoutMs: 45000,
  },
  search: {
    enabled: true,
    autoFillToCap: true,        // 自动刷到积分不再增长为止
    maxSearches: 40,            // 安全上限
    minDelayMs: 2500,
    maxDelayMs: 7000,
    stopAfterNoGain: 3,         // 连续 N 次不增长即判定刷满
    verifyPoints: true,
    readNews: true,
    querySource: 'mixed',       // mixed | news | custom
    customQueries: [],
    mobileMode: false,          // 用移动端 UA 执行搜索（覆盖移动端搜索额度）
  },
  tasks: {
    enabled: true,
    doDailySet: true,           // 完成「每日活动」里的搜索类任务
    doQuests: true,             // 完成积分赚取页的「拼图任务」（punchcard）
    claimPoints: true,          // 自动领取「可领取」积分
    visitEarnPage: true,        // 访问积分赚取页
    doQuizzes: false,           // 尝试每日测验（实验性）
    checkMobileApp: true,       // 检测「移动应用签到」状态并明确提示
  },
  server: { host: '127.0.0.1', port: 8787, openOnStart: true },
  tray: { enabled: true, autostart: true, minimizeToTray: true },
  advanced: {
    logRetentionDays: 14,
    keepBrowserOpen: false,
    screenshotOnError: true,
    debug: false,
  },
};

export const DEFAULT_ACCOUNT_OVERRIDES = {
  search: { enabled: true, maxSearches: 40, mobileMode: false, querySource: 'mixed', customQueries: [] },
  tasks: { enabled: true, doDailySet: true, doQuests: true, claimPoints: true, visitEarnPage: true, doQuizzes: false, checkMobileApp: true },
  browser: { kind: 'msedge', headless: true, executablePath: '' },
};

/* ---------------- 工具 ---------------- */

function deepMerge(base, override) {
  if (override === null || override === undefined) return base;
  if (Array.isArray(base) || Array.isArray(override)) return override;
  if (typeof base !== 'object' || typeof override !== 'object') return override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

/** 生成不重复的账号 id（同时避让磁盘上已存在的目录，避免相互覆盖） */
function newAccountId(existing = []) {
  const used = new Set(existing.map((a) => a.id));
  try {
    for (const d of fs.readdirSync(ACCOUNTS_DIR)) used.add(d);
  } catch { /* 目录不存在时忽略 */ }
  let i = 1;
  while (used.has(`acc-${i}`)) i += 1;
  return `acc-${i}`;
}

/* ---------------- 账号规范化 ---------------- */

export function normalizeAccount(a) {
  return {
    id: sanitizeId(a.id) || 'acc-1',
    label: a.label || a.emailHint || a.id || '未命名账号',
    emailHint: a.emailHint || '',
    enabled: a.enabled !== false,
    createdAt: a.createdAt || new Date().toISOString(),
    overrides: {
      search: { ...DEFAULT_ACCOUNT_OVERRIDES.search, ...(a.overrides?.search || {}) },
      tasks: { ...DEFAULT_ACCOUNT_OVERRIDES.tasks, ...(a.overrides?.tasks || {}) },
      browser: { ...DEFAULT_ACCOUNT_OVERRIDES.browser, ...(a.overrides?.browser || {}) },
    },
  };
}

/* ---------------- 读写 ---------------- */

export function defaultSettings() {
  return { application: structuredClone(DEFAULT_APPLICATION), accounts: [] };
}

/**
 * 读取 settings.json；不存在但存在旧版 config.json 时自动迁移。
 */
export function loadSettings() {
  ensureDirs();
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      return {
        application: deepMerge(DEFAULT_APPLICATION, raw.application || {}),
        accounts: (Array.isArray(raw.accounts) ? raw.accounts : []).map(normalizeAccount),
      };
    }
  } catch (err) {
    console.error('[config] settings.json 读取失败：', err.message);
  }

  const migrated = defaultSettings();
  if (fs.existsSync(LEGACY_CONFIG_FILE)) {
    try {
      const legacy = JSON.parse(fs.readFileSync(LEGACY_CONFIG_FILE, 'utf8'));
      migrated.application = deepMerge(DEFAULT_APPLICATION, legacy);
      console.log('[config] 检测到旧版 config.json，已迁移为全局设置。');
    } catch { /* 忽略损坏的旧配置 */ }
  }
  migrated.accounts.push(
    normalizeAccount({
      id: 'acc-1',
      label: '主账号',
      overrides: {
        search: {
          enabled: migrated.application.search.enabled,
          maxSearches: migrated.application.search.maxSearches,
          mobileMode: migrated.application.search.mobileMode,
          querySource: migrated.application.search.querySource,
          customQueries: migrated.application.search.customQueries,
        },
        tasks: { ...migrated.application.tasks, doQuizzes: migrated.application.tasks.doQuizzes },
        browser: {
          kind: migrated.application.browser.kind,
          headless: migrated.application.browser.headless,
          executablePath: migrated.application.browser.executablePath,
        },
      },
    }),
  );
  return migrated;
}

export function saveSettings(settings) {
  const clean = {
    application: deepMerge(DEFAULT_APPLICATION, settings.application || {}),
    accounts: (settings.accounts || []).map(normalizeAccount),
  };
  ensureDirs();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(clean, null, 2), 'utf8');
  return clean;
}

/** 生成一个新账号对象（继承当前全局设置） */
export function createAccountObject(existingAccounts = [], extra = {}) {
  const app = loadSettings().application;
  return normalizeAccount({
    id: newAccountId(existingAccounts),
    label: extra.label || '新账号',
    emailHint: extra.emailHint || '',
    enabled: true,
    createdAt: new Date().toISOString(),
    overrides: {
      search: {
        enabled: app.search.enabled,
        maxSearches: app.search.maxSearches,
        mobileMode: app.search.mobileMode,
        querySource: app.search.querySource,
        customQueries: app.search.customQueries,
      },
      tasks: { ...app.tasks },
      browser: {
        kind: app.browser.kind,
        headless: app.browser.headless,
        executablePath: app.browser.executablePath,
      },
    },
  });
}

/* ---------------- 账号操作 ---------------- */

export function getAccounts() {
  return loadSettings().accounts;
}

export function getAccount(id) {
  const accounts = getAccounts();
  if (!id) return accounts.find((a) => a.enabled !== false) || accounts[0] || null;
  return accounts.find((a) => a.id === id) || null;
}

export function addAccount(extra = {}) {
  const settings = loadSettings();
  const acc = createAccountObject(settings.accounts, extra);
  settings.accounts.push(acc);
  saveSettings(settings);
  ensureDirs(acc.id);
  return acc;
}

export function updateAccount(id, patch) {
  const settings = loadSettings();
  const idx = settings.accounts.findIndex((a) => a.id === id);
  if (idx < 0) return null;
  settings.accounts[idx] = normalizeAccount(deepMerge(settings.accounts[idx], patch));
  saveSettings(settings);
  return settings.accounts[idx];
}

export function removeAccount(id, { deleteData = false } = {}) {
  const settings = loadSettings();
  settings.accounts = settings.accounts.filter((a) => a.id !== id);
  saveSettings(settings);
  if (deleteData) {
    try { fs.rmSync(accountDir(id), { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
  return true;
}

/** 保存某账号的局部覆盖 */
export function saveAccountOverrides(accountId, patch) {
  const settings = loadSettings();
  const idx = settings.accounts.findIndex((a) => a.id === accountId);
  if (idx < 0) return null;
  const cur = settings.accounts[idx];
  const next = deepMerge(cur, patch || {});
  // 顶层字段（label/emailHint/enabled）直接生效
  if (patch && patch.label !== undefined) next.label = patch.label;
  if (patch && patch.emailHint !== undefined) next.emailHint = patch.emailHint;
  if (patch && patch.enabled !== undefined) next.enabled = patch.enabled;
  settings.accounts[idx] = normalizeAccount(next);
  saveSettings(settings);
  return settings.accounts[idx];
}

/** 全局默认设置的读写 */
export function saveApplication(patch) {
  const settings = loadSettings();
  settings.application = deepMerge(settings.application, patch);
  saveSettings(settings);
  return settings.application;
}

/* ---------------- 生效配置 ---------------- */

/**
 * 计算某账号的最终生效配置（全局 + 账号覆盖）
 * 返回扁平结构，便于现有代码直接使用 cfg.search / cfg.tasks ...
 */
export function resolveAccountConfig(accountId) {
  const settings = loadSettings();
  const acc = settings.accounts.find((a) => a.id === accountId) || settings.accounts[0] || null;
  const app = settings.application;
  const ov = acc?.overrides || {};

  return {
    account: acc,
    application: app,
    schedule: { ...app.schedule },
    browser: deepMerge(app.browser, ov.browser || {}),
    search: deepMerge(app.search, ov.search || {}),
    tasks: deepMerge(app.tasks, ov.tasks || {}),
    server: { ...app.server },
    tray: { ...app.tray },
    advanced: { ...app.advanced },
  };
}

/** 当前默认账号（供无账号上下文的调用点使用） */
let currentAccountId = null;
export function setCurrentAccount(id) {
  currentAccountId = id;
}
export function getCurrentAccountId() {
  return currentAccountId;
}

/** 兼容旧调用：按账号解析配置 */
export function loadConfig(accountId = null) {
  const accounts = getAccounts();
  const id = accountId || currentAccountId || accounts.find((a) => a.enabled !== false)?.id || accounts[0]?.id;
  return resolveAccountConfig(id);
}

/** 兼容旧调用：保存全局应用设置 */
export function saveConfig(cfg) {
  const patch = {};
  for (const k of ['schedule', 'browser', 'search', 'tasks', 'server', 'tray', 'advanced']) {
    if (cfg && cfg[k]) patch[k] = cfg[k];
  }
  return saveApplication(patch);
}

export function updateConfig(patch) {
  return saveApplication(patch);
}

export const DEFAULT_CONFIG = DEFAULT_APPLICATION;
export { DATA_DIR };
