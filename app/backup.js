/**
 * 备份与恢复
 *
 * 把选定的内容打包成一个 zip（内含 manifest.json 描述元信息），
 * 以及从 zip 恢复到本地（带校验、冲突策略与路径穿越防护）。
 *
 * 可备份的类别（cat）：
 *   settings    全局设置 + 账号列表（含各账号独立设置）
 *   history     运行历史与统计（各账号 state.json，不含登录态）
 *   profiles    浏览器登录态（体积大、含账号 Cookie，敏感）
 *   queries     自定义搜索词库
 *   screenshots 失败截图
 *   logs        运行日志
 *
 * 设计要点：
 *   - 登录态单独成类：它体积最大且最敏感，默认不勾选
 *   - 恢复提供「合并 / 覆盖」两种策略：合并适合换机接续，覆盖适合完整还原
 *   - 全程校验 zip 内部路径，拒绝任何越界写入
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, DATA_DIR, ACCOUNTS_DIR, LOG_DIR, SETTINGS_FILE,
  accountDir, accountProfileDir, accountStateFile, accountShotDir, accountQueriesFile,
  ensureDirs,
} from './paths.js';
import { loadSettings, saveSettings, normalizeAccount } from './config.js';
import { loadState, saveState, dropStateCache } from './store.js';
import { ZipWriter, readZipIndex, extractZip, safeEntryPath } from './zip.js';
import { log } from './logger.js';

export const BACKUP_VERSION = 1;
export const MANIFEST_NAME = 'manifest.json';

/** 可备份类别定义（供前端渲染勾选项与体积预览） */
export const CATEGORIES = [
  {
    cat: 'settings',
    label: '设置与账号列表',
    desc: '全局默认设置、账号清单及每个账号的独立设置（不含登录态）',
    sensitive: false,
  },
  {
    cat: 'history',
    label: '运行历史与统计',
    desc: '各账号的执行记录、积分变化、累计统计',
    sensitive: false,
  },
  {
    cat: 'queries',
    label: '自定义搜索词库',
    desc: '各账号的 queries.txt 自定义关键词',
    sensitive: false,
  },
  {
    cat: 'screenshots',
    label: '失败截图',
    desc: '出错时保存的页面截图',
    sensitive: false,
  },
  {
    cat: 'logs',
    label: '运行日志',
    desc: 'data/logs 下按天记录的日志文件',
    sensitive: false,
  },
  {
    cat: 'profiles',
    label: '浏览器登录态',
    desc: '各账号的浏览器配置目录，含登录 Cookie，可免去重新登录',
    sensitive: true,
  },
];

const CAT_SET = new Set(CATEGORIES.map((c) => c.cat));

/** 递归列出目录下所有文件（相对路径用 / 分隔） */
function listFiles(dir, base = '') {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(abs, rel));
    else if (e.isFile()) out.push({ rel, abs, size: fs.statSync(abs).size });
  }
  return out;
}

/**
 * 扫描各待备份类别的文件与体积（不打包，仅统计）
 * @param {string[]} cats
 */
export function scanBackup(cats = null) {
  const selected = (cats && cats.length ? cats : CATEGORIES.map((c) => c.cat)).filter((c) => CAT_SET.has(c));
  const settings = loadSettings();
  const accounts = settings.accounts || [];

  const result = [];
  for (const def of CATEGORIES) {
    if (!selected.includes(def.cat)) {
      result.push({ ...def, fileCount: 0, bytes: 0, selected: false });
      continue;
    }
    let files = [];
    switch (def.cat) {
      case 'settings':
        files = fs.existsSync(SETTINGS_FILE) ? [{ rel: 'settings.json', abs: SETTINGS_FILE, size: fs.statSync(SETTINGS_FILE).size }] : [];
        break;
      case 'history':
        files = accounts.map((a) => ({ rel: a.id, abs: accountStateFile(a.id) }))
          .filter((f) => fs.existsSync(f.abs))
          .map((f) => ({ ...f, size: fs.statSync(f.abs).size }));
        break;
      case 'queries':
        files = accounts.map((a) => ({ rel: a.id, abs: accountQueriesFile(a.id) }))
          .filter((f) => fs.existsSync(f.abs))
          .map((f) => ({ ...f, size: fs.statSync(f.abs).size }));
        break;
      case 'screenshots':
        for (const a of accounts) {
          for (const f of listFiles(accountShotDir(a.id))) {
            files.push({ rel: `${a.id}/${f.rel}`, abs: f.abs, size: f.size });
          }
        }
        break;
      case 'logs':
        files = listFiles(LOG_DIR).map((f) => ({ rel: f.rel, abs: f.abs, size: f.size }));
        break;
      case 'profiles':
        for (const a of accounts) {
          for (const f of listFiles(accountProfileDir(a.id))) {
            files.push({ rel: `${a.id}/${f.rel}`, abs: f.abs, size: f.size });
          }
        }
        break;
      default: break;
    }
    result.push({
      ...def,
      fileCount: files.length,
      bytes: files.reduce((s, f) => s + f.size, 0),
      selected: true,
    });
  }
  return { categories: result, accounts: accounts.map((a) => ({ id: a.id, label: a.label })) };
}

/**
 * 导出备份到 zip
 * @param {string} outFile
 * @param {string[]} cats
 * @param {(info:{stage:string,done:number,total:number,current?:string})=>void} [onProgress]
 */
export async function exportBackup(outFile, cats, onProgress = () => {}) {
  const selected = (cats && cats.length ? cats : CATEGORIES.map((c) => c.cat)).filter((c) => CAT_SET.has(c));
  if (!selected.length) throw new Error('至少要选择一个备份内容');

  const settings = loadSettings();
  const accounts = settings.accounts || [];
  const tmp = `${outFile}.tmp`;
  fs.rmSync(tmp, { force: true });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  const w = new ZipWriter(tmp);
  const manifest = {
    format: 'microsoft-rewards-auto-backup',
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    appVersion: readAppVersion(),
    platform: process.platform,
    nodeVersion: process.version,
    categories: selected,
    accounts: accounts.map((a) => ({ id: a.id, label: a.label, emailHint: a.emailHint || '' })),
    entryCount: 0,
    totalBytes: 0,
  };

  /** 收集待写入条目 */
  const jobs = [];   // {zipName, abs, cat}
  const push = (cat, zipName, abs) => {
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) jobs.push({ cat, zipName, abs });
  };

  for (const a of accounts) {
    if (selected.includes('history')) push('history', `history/${a.id}.json`, accountStateFile(a.id));
    if (selected.includes('queries')) push('queries', `queries/${a.id}.txt`, accountQueriesFile(a.id));
  }
  if (selected.includes('settings') && fs.existsSync(SETTINGS_FILE)) {
    push('settings', 'settings.json', SETTINGS_FILE);
  }
  if (selected.includes('screenshots')) {
    for (const a of accounts) {
      for (const f of listFiles(accountShotDir(a.id))) {
        push('screenshots', `screenshots/${a.id}/${f.rel}`, f.abs);
      }
    }
  }
  if (selected.includes('logs')) {
    for (const f of listFiles(LOG_DIR)) push('logs', `logs/${f.rel}`, f.abs);
  }
  if (selected.includes('profiles')) {
    onProgress({ stage: 'scan-profiles', done: 0, total: 0 });
    for (const a of accounts) {
      for (const f of listFiles(accountProfileDir(a.id))) {
        push('profiles', `profiles/${a.id}/${f.rel}`, f.abs);
      }
    }
  }

  let totalBytes = 0;
  let done = 0;
  for (const j of jobs) {
    await w.addFile(j.zipName, j.abs);
    totalBytes += fs.statSync(j.abs).size;
    done += 1;
    if (done % 20 === 0 || done === jobs.length) {
      onProgress({ stage: 'packing', done, total: jobs.length, current: j.zipName });
    }
  }

  manifest.entryCount = jobs.length;
  manifest.totalBytes = totalBytes;
  await w.addBuffer(MANIFEST_NAME, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), { compress: true });
  w.close();

  fs.renameSync(tmp, outFile);
  log.success(`备份已导出：${path.basename(outFile)}（${jobs.length} 个文件，原始 ${(totalBytes / 1048576).toFixed(1)} MB）`);
  return { file: outFile, manifest, size: fs.statSync(outFile).size };
}

function readAppVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 读取备份文件的 manifest（用于导入前预览）
 */
export async function inspectBackup(file) {
  const idx = readZipIndex(file);
  const entry = idx.entries.find((e) => e.name === MANIFEST_NAME);
  if (!entry) throw new Error('这不是本工具的备份文件（缺少 manifest.json）');

  const { readZipEntry } = await import('./zip.js');
  const raw = await readZipEntry(file, entry);
  let manifest = null;
  try { manifest = JSON.parse(raw.toString('utf8')); } catch { throw new Error('备份文件的 manifest.json 已损坏'); }

  if (manifest.format !== 'microsoft-rewards-auto-backup') {
    throw new Error('备份格式不匹配（不是本工具导出的文件）');
  }
  if (Number(manifest.version) > BACKUP_VERSION) {
    throw new Error(`备份版本 ${manifest.version} 高于当前程序支持的 ${BACKUP_VERSION}，请先升级程序`);
  }

  // 统计各 tar 内类别实际条目数（settings.json 位于根目录，归入 settings 类）
  const counts = {};
  for (const e of idx.entries) {
    const safe = safeEntryPath(e.name);
    if (!safe || safe === MANIFEST_NAME) continue;
    const cat = safe.includes('/') ? safe.split('/')[0] : 'settings';
    counts[cat] = (counts[cat] || 0) + 1;
  }

  return {
    file,
    zipSize: idx.entries.length ? fs.statSync(file).size : 0,
    manifest,
    entries: idx.entries.length,
    counts,
  };
}

/**
 * 从备份恢复
 * @param {string} file
 * @param {{mode?:'merge'|'overwrite', cats?:string[]}} opts
 */
export async function importBackup(file, opts = {}, onProgress = () => {}) {
  const mode = opts.mode === 'overwrite' ? 'overwrite' : 'merge';
  const preview = await inspectBackup(file);
  const wantCats = (opts.cats && opts.cats.length ? opts.cats : preview.manifest.categories)
    .filter((c) => CAT_SET.has(c));

  // 解压到临时目录（只提取允许的类别）
  const stage = path.join(DATA_DIR, `_restore-${Date.now()}`);
  fs.mkdirSync(stage, { recursive: true });

  try {
    const allowed = new Set(wantCats.map((c) => c));
    const r = await extractZip(file, stage, (entry) => {
      const safe = safeEntryPath(entry.name);
      if (!safe || safe === MANIFEST_NAME) return false;
      // settings.json 位于 zip 根目录（无子目录），需单独归类为 settings
      const cat = safe.includes('/') ? safe.split('/')[0] : 'settings';
      return allowed.has(cat);
    }, (p) => onProgress({ stage: 'extract', ...p }));

    onProgress({ stage: 'apply', done: 0, total: r.extracted });

    const applied = { settings: false, accounts: [], history: 0, queries: 0, screenshots: 0, logs: 0, profiles: 0 };
    const nowIso = new Date().toISOString();

    /* ---- 1. 设置 ---- */
    const stageSettings = path.join(stage, 'settings.json');
    if (allowed.has('settings') && fs.existsSync(stageSettings)) {
      const incoming = JSON.parse(fs.readFileSync(stageSettings, 'utf8'));
      if (mode === 'overwrite') {
        saveSettings(incoming);
        applied.settings = true;
      } else {
        // 合并：保留本地账号，补充备份中的新账号；全局设置以本地为主，缺失项补齐
        const local = loadSettings();
        const byId = new Map(local.accounts.map((a) => [a.id, a]));
        for (const acc of incoming.accounts || []) {
          if (!byId.has(acc.id)) {
            byId.set(acc.id, normalizeAccount(acc));
            applied.accounts.push(`新增 ${acc.label || acc.id}`);
          }
        }
        const merged = {
          application: { ...incoming.application, ...local.application },
          accounts: [...byId.values()],
        };
        saveSettings(merged);
        applied.settings = true;
      }
    }

    /* ---- 2. 历史与统计 ---- */
    const histDir = path.join(stage, 'history');
    if (allowed.has('history') && fs.existsSync(histDir)) {
      for (const f of fs.readdirSync(histDir)) {
        if (!f.endsWith('.json')) continue;
        const id = f.slice(0, -5);
        const incoming = JSON.parse(fs.readFileSync(path.join(histDir, f), 'utf8'));
        if (mode === 'overwrite') {
          saveState(id, incoming);
          dropStateCache(id);
          applied.history += 1;
        } else {
          // 合并：按 startedAt 去重后按时间倒序合并，重算统计
          const cur = loadState(id);
          const seen = new Set((cur.history || []).map((h) => h.startedAt));
          const merged = [...(cur.history || [])];
          for (const h of incoming.history || []) {
            if (!seen.has(h.startedAt)) merged.push(h);
          }
          merged.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
          const trimmed = merged.slice(0, 200);
          saveState(id, {
            history: trimmed,
            totalRuns: trimmed.length,
            totalPointsEarned: trimmed.reduce((s, h) => {
              const g = (h.pointsAfter ?? 0) - (h.pointsBefore ?? 0);
              return s + (g > 0 ? g : 0);
            }, 0),
            account: { ...cur.account, ...(incoming.account || {}) },
          });
          dropStateCache(id);
          applied.history += 1;
        }
      }
    }

    /* ---- 3. 词库 ---- */
    const qDir = path.join(stage, 'queries');
    if (allowed.has('queries') && fs.existsSync(qDir)) {
      for (const f of fs.readdirSync(qDir)) {
        if (!f.endsWith('.txt')) continue;
        const id = f.slice(0, -4);
        ensureDirs(id);
        fs.copyFileSync(path.join(qDir, f), accountQueriesFile(id));
        applied.queries += 1;
      }
    }

    /* ---- 4. 截图 ---- */
    const sDir = path.join(stage, 'screenshots');
    if (allowed.has('screenshots') && fs.existsSync(sDir)) {
      for (const id of fs.readdirSync(sDir)) {
        const src = path.join(sDir, id);
        if (!fs.statSync(src).isDirectory()) continue;
        const dst = accountShotDir(id);
        fs.mkdirSync(dst, { recursive: true });
        for (const f of fs.readdirSync(src)) {
          fs.copyFileSync(path.join(src, f), path.join(dst, f));
          applied.screenshots += 1;
        }
      }
    }

    /* ---- 5. 日志 ---- */
    const lDir = path.join(stage, 'logs');
    if (allowed.has('logs') && fs.existsSync(lDir)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      for (const f of fs.readdirSync(lDir)) {
        const src = path.join(lDir, f);
        if (fs.statSync(src).isFile()) {
          fs.copyFileSync(src, path.join(LOG_DIR, f));
          applied.logs += 1;
        }
      }
    }

    /* ---- 6. 登录态（目录级整体替换） ---- */
    const pDir = path.join(stage, 'profiles');
    if (allowed.has('profiles') && fs.existsSync(pDir)) {
      for (const id of fs.readdirSync(pDir)) {
        const src = path.join(pDir, id);
        if (!fs.statSync(src).isDirectory()) continue;
        const dst = accountProfileDir(id);
        if (mode === 'overwrite') {
          fs.rmSync(dst, { recursive: true, force: true });
        } else if (fs.existsSync(dst)) {
          // 合并模式：备份到本地侧目录，避免破坏现有登录态
          const bak = `${dst}.bak-${Date.now()}`;
          fs.renameSync(dst, bak);
          log.info(`已把现有登录态移动到 ${path.basename(bak)}（合并模式保守处理）`);
        }
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.cpSync(src, dst, { recursive: true });
        applied.profiles += 1;
      }
    }

    const summary = {
      mode,
      categories: wantCats,
      applied,
      from: preview.manifest,
      restoredAt: nowIso,
      extract: r,
    };
    log.success(`备份已恢复（${mode === 'overwrite' ? '覆盖' : '合并'}模式）：`
      + `设置${applied.settings ? '✓' : '—'} 历史${applied.history} 词库${applied.queries} `
      + `截图${applied.screenshots} 日志${applied.logs} 登录态${applied.profiles}`);
    return summary;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/** 备份文件默认存放目录（项目内 backups/） */
export function backupDir() {
  const d = path.join(ROOT, 'backups');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
