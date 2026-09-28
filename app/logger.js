/**
 * 日志系统：同时输出到控制台、按天写文件，并广播给 Web 控制台（SSE）
 */
import fs from 'node:fs';
import path from 'node:path';
import { LOG_DIR, ensureDirs } from './paths.js';

const listeners = new Set();
let buffer = [];
const MAX_BUFFER = 500;

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function logFile() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return path.join(LOG_DIR, `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.log`);
}

function emit(level, args) {
  const msg = args
    .map((a) => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'object') {
        try { return JSON.stringify(a); } catch { return String(a); }
      }
      return String(a);
    })
    .join(' ');
  const entry = { time: ts(), level, message: msg, epoch: Date.now() };

  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);

  const line = `[${entry.time}] [${level.toUpperCase()}] ${msg}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);

  try {
    ensureDirs();
    fs.appendFileSync(logFile(), line + '\n', 'utf8');
  } catch { /* 日志写盘失败不阻断主流程 */ }

  for (const fn of listeners) {
    try { fn(entry); } catch { /* 单个订阅者异常不影响其他 */ }
  }
}

export const log = {
  info: (...a) => emit('info', a),
  warn: (...a) => emit('warn', a),
  error: (...a) => emit('error', a),
  success: (...a) => emit('success', a),
  step: (...a) => emit('step', a),
  debug: (...a) => emit('debug', a),
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function recentLogs() {
  return buffer.slice(-300);
}

/** 清理过期日志 */
export function pruneLogs(retentionDays = 14) {
  try {
    const cutoff = Date.now() - retentionDays * 86400_000;
    for (const f of fs.readdirSync(LOG_DIR)) {
      const full = path.join(LOG_DIR, f);
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
    }
  } catch { /* 忽略 */ }
}
