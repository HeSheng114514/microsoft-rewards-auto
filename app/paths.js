/**
 * 统一路径解析
 *
 * 全局数据放在 data/ 下；每个账号拥有完全独立的子目录，包含自己的
 * 浏览器配置目录（登录态）、状态文件与截图。
 *
 *   data/
 *     accounts/
 *       acc-1/
 *         browser-profile/     该账号独立的登录态
 *         state.json           该账号的运行历史与统计
 *         screenshots/
 *         queries.txt          该账号自定义搜索词（可选）
 *     logs/                    全局日志（所有账号共用，行内带账号标识）
 *     settings.json            全局配置 + 账号列表
 *     app.lock
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 项目根目录（app/ 的上一级） */
export const ROOT = path.resolve(__dirname, '..');
export const APP_DIR = __dirname;
export const WEB_DIR = path.join(APP_DIR, 'web');

export const DATA_DIR = path.join(ROOT, 'data');
export const ACCOUNTS_DIR = path.join(DATA_DIR, 'accounts');
export const LOG_DIR = path.join(DATA_DIR, 'logs');
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
export const LOCK_FILE = path.join(DATA_DIR, 'app.lock');

/** 兼容旧版本遗留的单一配置（首次运行会自动迁移） */
export const LEGACY_CONFIG_FILE = path.join(ROOT, 'config.json');
export const LEGACY_STATE_FILE = path.join(DATA_DIR, 'state.json');
export const LEGACY_PROFILE_DIR = path.join(DATA_DIR, 'browser-profile');

/* ---------------- 账号级路径 ---------------- */

export function accountDir(accountId) {
  return path.join(ACCOUNTS_DIR, accountId);
}
export function accountProfileDir(accountId) {
  return path.join(accountDir(accountId), 'browser-profile');
}
export function accountStateFile(accountId) {
  return path.join(accountDir(accountId), 'state.json');
}
export function accountShotDir(accountId) {
  return path.join(accountDir(accountId), 'screenshots');
}
export function accountQueriesFile(accountId) {
  return path.join(accountDir(accountId), 'queries.txt');
}

/** 建立全局目录，若指定账号则同时建立该账号目录 */
export function ensureDirs(accountId = null) {
  const dirs = [DATA_DIR, ACCOUNTS_DIR, LOG_DIR];
  if (accountId) {
    dirs.push(accountDir(accountId), accountProfileDir(accountId), accountShotDir(accountId));
  }
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
}

/** 安全的账号 id（仅允许字母数字与短横线） */
export function sanitizeId(id) {
  return String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
}
