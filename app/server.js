/**
 * 本地 Web 控制台：HTTP 服务 + JSON API + SSE 实时日志（多账号）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WEB_DIR } from './paths.js';
import {
  loadSettings, saveApplication, resolveAccountConfig, getAccounts, getAccount,
  addAccount, updateAccount, removeAccount, saveAccountOverrides,
  DEFAULT_APPLICATION, DEFAULT_ACCOUNT_OVERRIDES,
} from './config.js';
import { loadState, saveState, todayKey, dropStateCache } from './store.js';
import { log, subscribe, recentLogs } from './logger.js';
import { runOnce, isRunning, cancelRun, currentRunningAccount } from './runner.js';
import { startScheduler, stopScheduler, schedulerStatus, refreshNextRun, computeNextRun, checkNow } from './scheduler.js';
import { listBrowsers, guideLogin, closeBrowser, isBrowserOpen, signOut } from './browser.js';
import { inspect } from './rewards.js';
import { launchBrowser, getPage } from './browser.js';
import {
  scanBackup, exportBackup, inspectBackup, importBackup, backupDir,
} from './backup.js';

/** 备份文件名安全化：只允许字母数字、点、横线、下划线、中文 */
function sanitizeBackupName(name) {
  const s = String(name || '').trim();
  if (!s) return null;
  // 直接拒绝任何路径成分（而不是净化后接受），语义更明确
  if (/[\\/]/.test(s)) return null;
  if (s.includes('..')) return null;
  if (!/^[\w\u4e00-\u9fa5.\-]+$/.test(s)) return null;
  if (!s.toLowerCase().endsWith('.zip')) return null;
  if (s.length > 120) return null;
  return s;
}

function defaultBackupName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `rewards-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.zip`;
}

function defaultUploadName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `uploaded-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.zip`;
}

const sseClients = new Set();
/** 备份导出任务表（大备份异步执行，避免请求超时） */
const backupTasks = new Map();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

subscribe((entry) => broadcast('log', entry));

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 2_000_000) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

/**
 * 读取原始请求体（二进制），用于备份文件上传
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [maxBytes]
 * @returns {Promise<Buffer>}
 */
function readRawBody(req, maxBytes = 512 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error(`文件过大（超过 ${Math.round(maxBytes / 1048576)} MB）`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function serveStatic(res, file, type) {
  try {
    if (!fs.existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const body = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('读取失败: ' + err.message);
  }
}

function fmtLocal(d) {
  if (!d) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 单个账号的状态快照 */
export function buildAccountStatus(accountId) {
  const acc = getAccount(accountId);
  if (!acc) return null;
  const st = loadState(acc.id);
  const cfg = resolveAccountConfig(acc.id);
  const today = todayKey();
  const todayHistory = (st.history || []).filter((h) => h.date === today);
  const next = computeNextRun(acc.id);

  return {
    id: acc.id,
    label: acc.label,
    emailHint: acc.emailHint,
    enabled: acc.enabled !== false,
    createdAt: acc.createdAt,
    account: st.account || {},
    last: (st.history || [])[0] || null,
    /** 最近一次执行是否检测到「必应会话与 Rewards 账号不一致」 */
    sessionMismatch: !!(st.history || [])[0]?.sessionMismatch,
    today: {
      date: today,
      runs: todayHistory.filter((h) => h.trigger !== 'manual').length,
      searches: todayHistory.reduce((a, h) => a + (h.searches || 0), 0),
      gain: todayHistory.reduce((a, h) => a + Math.max(0, (h.pointsAfter ?? 0) - (h.pointsBefore ?? 0)), 0),
    },
    totals: { runs: st.totalRuns || 0, earned: st.totalPointsEarned || 0 },
    nextRunAt: next ? next.toISOString() : null,
    nextRunLocal: fmtLocal(next),
    config: cfg,
    overrides: acc.overrides,
  };
}

/** 全局 + 全部账号快照 */
function buildStatus() {
  const settings = loadSettings();
  const accounts = settings.accounts.map((a) => buildAccountStatus(a.id)).filter(Boolean);
  const sch = schedulerStatus();

  return {
    now: new Date().toISOString(),
    accounts,
    scheduler: sch,
    running: isRunning(),
    runningAccount: currentRunningAccount(),
    browserOpen: isBrowserOpen(),
    browsers: listBrowsers(),
    application: settings.application,
    defaults: { application: DEFAULT_APPLICATION, overrides: DEFAULT_ACCOUNT_OVERRIDES },
  };
}

export function createServer() {
  const settings = loadSettings();
  const host = settings.application.server?.host || '127.0.0.1';
  const port = Number(settings.application.server?.port || 8787);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;

    const remote = req.socket.remoteAddress || '';
    if (!/^(127\.|::1|::ffff:127\.|localhost)/.test(remote)) {
      return json(res, 403, { ok: false, error: '仅允许本机访问' });
    }

    try {
      /* ---------------- 静态资源 ---------------- */
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        return serveStatic(res, path.join(WEB_DIR, 'index.html'), 'text/html');
      }
      if (req.method === 'GET' && p === '/app.css') {
        return serveStatic(res, path.join(WEB_DIR, 'app.css'), 'text/css');
      }
      if (req.method === 'GET' && p === '/app.js') {
        return serveStatic(res, path.join(WEB_DIR, 'app.js'), 'application/javascript');
      }
      if (req.method === 'GET' && p === '/favicon.ico') {
        const ico = path.join(WEB_DIR, 'favicon.ico');
        if (fs.existsSync(ico)) {
          const buf = fs.readFileSync(ico);
          res.writeHead(200, { 'Content-Type': 'image/x-icon', 'Content-Length': buf.length, 'Cache-Control': 'max-age=86400' });
          return res.end(buf);
        }
        res.writeHead(204);
        return res.end();
      }

      /* ---------------- SSE ---------------- */
      if (req.method === 'GET' && p === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write('retry: 3000\n\n');
        res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
        for (const e of recentLogs()) res.write(`event: log\ndata: ${JSON.stringify(e)}\n\n`);
        sseClients.add(res);
        const ping = setInterval(() => {
          try { res.write(': ping\n\n'); } catch { /* 忽略 */ }
        }, 20000);
        req.on('close', () => {
          clearInterval(ping);
          sseClients.delete(res);
        });
        return;
      }

      /* ---------------- 状态与配置 ---------------- */
      if (p === '/api/status' && req.method === 'GET') {
        return json(res, 200, { ok: true, data: buildStatus() });
      }

      if (p === '/api/logs' && req.method === 'GET') {
        return json(res, 200, { ok: true, data: recentLogs() });
      }

      if (p === '/api/history' && req.method === 'GET') {
        const id = url.searchParams.get('account');
        const acc = getAccount(id);
        if (!acc) return json(res, 200, { ok: true, data: [] });
        return json(res, 200, { ok: true, data: (loadState(acc.id).history || []).slice(0, 100) });
      }

      // 全局默认设置
      if (p === '/api/settings' && req.method === 'POST') {
        const patch = await readBody(req);
        const saved = saveApplication(patch);
        stopScheduler();
        startScheduler();
        log.info('全局设置已更新。');
        broadcast('status', buildStatus());
        return json(res, 200, { ok: true, data: saved });
      }

      // 兼容旧接口
      if (p === '/api/config' && req.method === 'POST') {
        const patch = await readBody(req);
        const saved = saveApplication(patch);
        refreshNextRun();
        stopScheduler();
        startScheduler();
        log.info('配置已更新。');
        broadcast('status', buildStatus());
        return json(res, 200, { ok: true, data: saved });
      }

      /* ---------------- 账号管理 ---------------- */
      if (p === '/api/accounts' && req.method === 'GET') {
        return json(res, 200, { ok: true, data: getAccounts() });
      }

      if (p === '/api/accounts' && req.method === 'POST') {
        const body = await readBody(req);
        const acc = addAccount({ label: body.label || '新账号', emailHint: body.emailHint || '' });
        log.success(`已添加账号 [${acc.label}]（${acc.id}）。请点击「登录」完成该账号的授权。`);
        broadcast('status', buildStatus());
        return json(res, 200, { ok: true, data: acc });
      }

      if (p === '/api/accounts/update' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.id) return json(res, 400, { ok: false, error: '缺少账号 id' });
        const acc = updateAccount(body.id, body.patch || {});
        if (!acc) return json(res, 404, { ok: false, error: '账号不存在' });
        stopScheduler();
        startScheduler();
        log.info(`账号 [${acc.label}] 设置已更新。`);
        broadcast('status', buildStatus());
        return json(res, 200, { ok: true, data: acc });
      }

      if (p === '/api/accounts/remove' && req.method === 'POST') {
        const body = await readBody(req);
        const accounts = getAccounts();
        if (accounts.length <= 1) {
          return json(res, 400, { ok: false, error: '至少需要保留一个账号。' });
        }
        if (!getAccount(body.id)) return json(res, 404, { ok: false, error: '账号不存在' });
        removeAccount(body.id, { deleteData: !!body.deleteData });
        dropStateCache(body.id);
        log.warn(`已删除账号 ${body.id}${body.deleteData ? '（含其登录数据）' : ''}。`);
        broadcast('status', buildStatus());
        return json(res, 200, { ok: true });
      }

      /* ---------------- 执行控制 ---------------- */
      if (p === '/api/run' && req.method === 'POST') {
        if (isRunning()) return json(res, 200, { ok: false, error: '已有任务正在执行' });
        const body = await readBody(req).catch(() => ({}));
        const acc = getAccount(body.account || url.searchParams.get('account'));
        if (!acc) return json(res, 400, { ok: false, error: '账号不存在' });
        runOnce({ trigger: 'manual', accountId: acc.id }).catch((e) => log.error('手动执行失败:', e.message));
        return json(res, 200, { ok: true, message: `已开始执行账号 [${acc.label}]` });
      }

      if (p === '/api/run-all' && req.method === 'POST') {
        if (isRunning()) return json(res, 200, { ok: false, error: '已有任务正在执行' });
        const list = getAccounts().filter((a) => a.enabled !== false);
        (async () => {
          for (const a of list) {
            log.info(`▶ 依次执行账号 [${a.label}]（${a.id}）`);
            await runOnce({ trigger: 'manual', accountId: a.id });
          }
        })().catch((e) => log.error('批量执行失败:', e.message));
        return json(res, 200, { ok: true, message: `已开始依次执行 ${list.length} 个账号` });
      }

      if (p === '/api/cancel' && req.method === 'POST') {
        const ok = cancelRun();
        return json(res, 200, { ok, message: ok ? '已请求取消' : '当前没有正在执行的任务' });
      }

      /* ---------------- 立即检查计划（补跑错过时刻） ---------------- */
      if (p === '/api/check-now' && req.method === 'POST') {
        if (isRunning()) return json(res, 200, { ok: false, error: '已有任务正在执行' });
        log.info('手动触发计划检查…');
        checkNow().catch((e) => log.error('计划检查失败：' + e.message));
        return json(res, 200, { ok: true, message: '已开始检查计划，若有错过的时刻会立即补跑' });
      }

      /* ---------------- 登录 ---------------- */
      if (p === '/api/login' && req.method === 'POST') {
        if (isRunning()) return json(res, 200, { ok: false, error: '任务执行中，请稍后再试' });
        const body = await readBody(req).catch(() => ({}));
        const acc = getAccount(body.account || url.searchParams.get('account'));
        if (!acc) return json(res, 400, { ok: false, error: '账号不存在' });
        const cfg = resolveAccountConfig(acc.id);
        log.info(`开始登录引导 [${acc.label}]，请在弹出的浏览器窗口中登录…`);
        guideLogin(cfg, (msg) => {
          log.info(msg);
          broadcast('notice', { message: msg });
        }).then((r) => {
          if (r.ok) {
            if (r.name) saveAccountOverrides(acc.id, { emailHint: r.name });
            log.success(`账号 [${acc.label}] 登录成功，登录状态已保存。`);
            broadcast('notice', { message: `[${acc.label}] 登录成功`, level: 'success' });
            const cur = loadState(acc.id);
            saveState(acc.id, { account: { ...cur.account, signedIn: true, name: r.name || null, updatedAt: new Date().toISOString() } });
            closeBrowser().catch(() => {});
            broadcast('status', buildStatus());
          } else {
            log.error(`账号 [${acc.label}] 登录未完成：` + (r.message || ''));
            broadcast('notice', { message: r.message || '登录未完成', level: 'error' });
          }
        }).catch((e) => {
          log.error('登录过程出错：' + e.message);
          broadcast('notice', { message: '登录过程出错：' + e.message, level: 'error' });
        });
        return json(res, 200, { ok: true, message: `已打开 [${acc.label}] 的登录窗口` });
      }

      /* ---------------- 重置登录（清除该账号身份 Cookie） ---------------- */
      if (p === '/api/signout' && req.method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const acc = getAccount(body.account || url.searchParams.get('account'));
        if (!acc) return json(res, 400, { ok: false, error: '账号不存在' });
        (async () => {
          try {
            const cfg = resolveAccountConfig(acc.id);
            const r = await signOut(cfg, (msg) => {
              log.info(`[${acc.label}] ${msg}`);
              broadcast('notice', { message: `[${acc.label}] ${msg}` });
            });
            await closeBrowser(acc.id);
            const cur = loadState(acc.id);
            saveState(acc.id, {
              account: { ...cur.account, signedIn: false, updatedAt: new Date().toISOString() },
            });
            if (r.ok) {
              log.info(`账号 [${acc.label}] 已重置登录，请重新点「登录」并确认用的是本账号。`);
              broadcast('notice', { message: `[${acc.label}] 已重置登录，请重新登录`, level: 'success' });
            } else {
              broadcast('notice', { message: `[${acc.label}] 注销可能未完全生效，请在浏览器窗口中手动注销`, level: 'error' });
            }
            broadcast('status', buildStatus());
          } catch (e) {
            log.error(`[${acc.label}] 重置登录失败：` + e.message);
          }
        })();
        return json(res, 200, { ok: true, message: `正在重置 [${acc.label}] 的登录状态` });
      }

      /* ---------------- 刷新账户信息 ---------------- */
      if (p === '/api/refresh' && req.method === 'POST') {
        if (isRunning()) return json(res, 200, { ok: false, error: '任务执行中' });
        const body = await readBody(req).catch(() => ({}));
        const acc = getAccount(body.account || url.searchParams.get('account'));
        if (!acc) return json(res, 400, { ok: false, error: '账号不存在' });
        log.info(`正在刷新账号 [${acc.label}] 的信息…`);
        (async () => {
          try {
            const cfg = resolveAccountConfig(acc.id);
            const { context } = await launchBrowser(cfg);
            const page = await getPage(context);
            const info = await inspect(page);
            const cur = loadState(acc.id);
            saveState(acc.id, {
              account: {
                ...cur.account,
                signedIn: info.signedIn,
                points: info.rawPoints,
                level: info.level,
                updatedAt: new Date().toISOString(),
              },
            });
            log.success(`[${acc.label}] 账户信息已刷新，可用积分：${info.rawPoints ?? '未知'}`);
            broadcast('status', buildStatus());
            if (!cfg.advanced?.keepBrowserOpen) await closeBrowser();
          } catch (e) {
            log.error(`[${acc.label}] 刷新失败：` + e.message);
          }
        })();
        return json(res, 200, { ok: true, message: '正在刷新' });
      }

      /* ---------------- 备份与恢复 ---------------- */
      if (p === '/api/backup/scan' && req.method === 'GET') {
        const cats = (url.searchParams.get('cats') || '').split(',').map((s) => s.trim()).filter(Boolean);
        const data = scanBackup(cats.length ? cats : null);
        return json(res, 200, { ok: true, data });
      }

      // 导出备份（服务器侧打包，完成后返回下载地址）
      if (p === '/api/backup/export' && req.method === 'POST') {
        const body = await readBody(req);
        const cats = Array.isArray(body.cats) ? body.cats : [];
        if (!cats.length) return json(res, 400, { ok: false, error: '请至少选择一项备份内容' });
        try {
          const name = sanitizeBackupName(body.name) || defaultBackupName();
          const file = path.join(backupDir(), name);

          // 异步执行，立刻返回任务 id，避免大备份（可达数百 MB）把请求拖超时
          const taskId = `bk-${Date.now()}`;
          backupTasks.set(taskId, { id: taskId, state: 'running', stage: 'starting', done: 0, total: 0, startedAt: new Date().toISOString() });
          broadcast('backup-progress', backupTasks.get(taskId));

          (async () => {
            const t = backupTasks.get(taskId);
            try {
              const r = await exportBackup(file, cats, (prog) => {
                Object.assign(t, {
                  stage: prog.stage,
                  done: prog.done || 0,
                  total: prog.total || 0,
                  current: prog.current || '',
                });
                broadcast('backup-progress', { ...t });
              });
              Object.assign(t, {
                state: 'done',
                stage: 'done',
                name: path.basename(r.file),
                size: r.size,
                manifest: r.manifest,
                finishedAt: new Date().toISOString(),
              });
            } catch (err) {
              Object.assign(t, { state: 'failed', error: err.message, finishedAt: new Date().toISOString() });
              log.error('导出备份失败：' + err.message);
            }
            broadcast('backup-progress', { ...t });
            // 5 分钟后清理任务记录
            setTimeout(() => backupTasks.delete(taskId), 5 * 60_000);
          })();

          return json(res, 200, { ok: true, data: { taskId, name } });
        } catch (err) {
          log.error('导出备份失败：' + err.message);
          return json(res, 500, { ok: false, error: err.message });
        }
      }

      // 查询导出进度
      if (p === '/api/backup/progress' && req.method === 'GET') {
        const id = url.searchParams.get('task');
        const t = backupTasks.get(id);
        if (!t) return json(res, 404, { ok: false, error: '任务不存在或已过期' });
        return json(res, 200, { ok: true, data: t });
      }

      // 下载已生成的备份
      if (p === '/api/backup/download' && req.method === 'GET') {
        const name = sanitizeBackupName(url.searchParams.get('name'));
        if (!name) return json(res, 400, { ok: false, error: '文件名非法' });
        const file = path.join(backupDir(), name);
        if (!fs.existsSync(file)) return json(res, 404, { ok: false, error: '文件不存在' });
        const buf = fs.readFileSync(file);
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}"`,
          'Content-Length': buf.length,
          'Cache-Control': 'no-store',
        });
        return res.end(buf);
      }

      // 列出已有备份
      if (p === '/api/backup/list' && req.method === 'GET') {
        const dir = backupDir();
        const list = fs.readdirSync(dir)
          .filter((f) => f.endsWith('.zip'))
          .map((f) => {
            const full = path.join(dir, f);
            const st = fs.statSync(full);
            return { name: f, size: st.size, mtime: st.mtime.toISOString() };
          })
          .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
        return json(res, 200, { ok: true, data: { dir, list } });
      }

      // 删除某个备份
      if (p === '/api/backup/delete' && req.method === 'POST') {
        const body = await readBody(req);
        const name = sanitizeBackupName(body.name);
        if (!name) return json(res, 400, { ok: false, error: '文件名非法' });
        const file = path.join(backupDir(), name);
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
          log.info(`已删除备份 ${name}`);
        }
        return json(res, 200, { ok: true });
      }

      // 上传备份文件（二进制），校验后返回预览
      if (p === '/api/backup/upload' && req.method === 'POST') {
        const name = sanitizeBackupName(url.searchParams.get('name')) || defaultUploadName();
        const buf = await readRawBody(req);
        if (!buf.length) return json(res, 400, { ok: false, error: '上传内容为空' });
        if (!(buf[0] === 0x50 && buf[1] === 0x4b)) {
          return json(res, 400, { ok: false, error: '不是有效的 ZIP 文件' });
        }
        const file = path.join(backupDir(), name);
        fs.writeFileSync(file, buf);
        try {
          const prev = await inspectBackup(file);
          log.info(`已接收备份文件 ${name}（${(buf.length / 1024).toFixed(1)} KB）`);
          return json(res, 200, { ok: true, data: { name, size: buf.length, preview: prev } });
        } catch (err) {
          fs.rmSync(file, { force: true });
          log.warn('上传的备份文件校验失败：' + err.message);
          return json(res, 400, { ok: false, error: err.message });
        }
      }

      // 从备份恢复
      if (p === '/api/backup/restore' && req.method === 'POST') {
        if (isRunning()) return json(res, 200, { ok: false, error: '任务执行中，请稍后再恢复' });
        const body = await readBody(req);
        const name = sanitizeBackupName(body.name);
        if (!name) return json(res, 400, { ok: false, error: '请指定备份文件' });
        const file = path.join(backupDir(), name);
        if (!fs.existsSync(file)) return json(res, 404, { ok: false, error: '备份文件不存在' });

        try {
          const r = await importBackup(file, {
            mode: body.mode === 'overwrite' ? 'overwrite' : 'merge',
            cats: Array.isArray(body.cats) ? body.cats : undefined,
          });
          broadcast('status', buildStatus());
          return json(res, 200, { ok: true, data: r });
        } catch (err) {
          log.error('恢复备份失败：' + err.message);
          return json(res, 500, { ok: false, error: err.message });
        }
      }

      /* ---------------- 托盘 ---------------- */
      if (p === '/api/tray' && req.method === 'POST') {
        const body = await readBody(req);
        const { setTrayEnabled, quitApp } = await import('./tray.js');
        if (body.action === 'quit') {
          log.info('收到退出指令，正在关闭…');
          json(res, 200, { ok: true, message: '正在退出' });
          setTimeout(async () => {
            await closeBrowser();
            await quitApp();
            process.exit(0);
          }, 300);
          return;
        }
        const r = await setTrayEnabled(!!body.enabled);
        return json(res, 200, { ok: true, data: r });
      }

      if (p === '/api/browsers' && req.method === 'GET') {
        return json(res, 200, { ok: true, data: listBrowsers() });
      }

      return json(res, 404, { ok: false, error: 'not found' });
    } catch (err) {
      log.error(`请求处理失败 ${p}: ${err.message}`);
      return json(res, 500, { ok: false, error: err.message });
    }
  });

  return {
    server,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        log.info(`控制台已就绪：http://${host}:${port}`);
        resolve({ host, port, url: `http://${host}:${port}` });
      });
    }),
    broadcast,
  };
}
