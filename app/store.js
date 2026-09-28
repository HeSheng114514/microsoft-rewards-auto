/**
 * 状态存储：每个账号独立的状态文件（账户快照、运行历史、统计）
 *
 * data/accounts/<id>/state.json
 */
import fs from 'node:fs';
import { accountStateFile, ensureDirs } from './paths.js';
import { getCurrentAccountId, getAccounts } from './config.js';

const DEFAULT_STATE = {
  version: 1,
  account: { signedIn: false, name: null, points: null, level: null, updatedAt: null },
  lastRun: null,          // ISO 时间
  lastRunDate: null,      // YYYY-MM-DD
  lastResult: null,       // ok | partial | failed | running | cancelled
  todayRuns: 0,
  todayDate: null,
  totalRuns: 0,
  totalPointsEarned: 0,
  history: [],            // 运行记录数组
};

const cache = new Map();

/** 解析账号 id：优先传入，其次当前上下文，最后取第一个账号 */
export function resolveAccountId(accountId) {
  if (accountId) return accountId;
  const cur = getCurrentAccountId();
  if (cur) return cur;
  const accounts = getAccounts();
  return accounts[0]?.id || 'acc-1';
}

export function loadState(accountId) {
  const id = resolveAccountId(accountId);
  if (cache.has(id)) return cache.get(id);

  ensureDirs(id);
  let state = structuredClone(DEFAULT_STATE);
  try {
    const file = accountStateFile(id);
    if (fs.existsSync(file)) {
      state = { ...structuredClone(DEFAULT_STATE), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    }
  } catch { /* 损坏则用默认值 */ }
  cache.set(id, state);
  return state;
}

export function saveState(accountIdOrPatch, maybePatch) {
  let id;
  let patch;
  if (typeof accountIdOrPatch === 'string') {
    id = accountIdOrPatch;
    patch = maybePatch;
  } else {
    id = resolveAccountId(null);
    patch = accountIdOrPatch;
  }
  const s = loadState(id);
  if (patch) Object.assign(s, patch);
  try {
    ensureDirs(id);
    fs.writeFileSync(accountStateFile(id), JSON.stringify(s, null, 2), 'utf8');
  } catch { /* 忽略 */ }
  return s;
}

export function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 跨天时重置该账号当天的运行计数 */
export function rollDay(accountId) {
  const s = loadState(accountId);
  const t = todayKey();
  if (s.todayDate !== t) {
    saveState(accountId, { todayDate: t, todayRuns: 0 });
  }
  return s;
}

export function addHistory(accountId, entry) {
  const s = loadState(accountId);
  s.history.unshift(entry);
  if (s.history.length > 200) s.history = s.history.slice(0, 200);
  s.totalRuns = (s.totalRuns || 0) + 1;
  if (entry.pointsAfter != null && entry.pointsBefore != null) {
    const gain = entry.pointsAfter - entry.pointsBefore;
    if (gain > 0) s.totalPointsEarned = (s.totalPointsEarned || 0) + gain;
  }
  saveState(accountId);
  return s;
}

/** 供外部（如账号删除后）清理缓存 */
export function dropStateCache(accountId) {
  cache.delete(accountId);
}
