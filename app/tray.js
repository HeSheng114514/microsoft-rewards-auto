/**
 * 系统托盘：通过 PowerShell 的 NotifyIcon 在任务栏托盘常驻
 * 提供：打开控制台 / 立即执行 / 暂停定时 / 退出程序
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { APP_DIR, ROOT, ensureDirs, DATA_DIR } from './paths.js';
import { log } from './logger.js';
import { loadSettings, saveApplication } from './config.js';

const PS_SCRIPT = path.join(APP_DIR, 'tray.ps1');
const PID_FILE = path.join(DATA_DIR, 'tray.pid');

/** 托盘相关设置为全局设置（不区分账号） */
function traySettings() {
  const s = loadSettings().application;
  return { tray: s.tray || {}, port: s.server?.port || 8787 };
}

function pwshPath() {
  const cand = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'),
    'pwsh.exe',
    'powershell.exe',
  ];
  for (const c of cand) {
    try { if (c.includes('\\') && fs.existsSync(c)) return c; } catch { /* 忽略 */ }
  }
  return 'powershell.exe';
}

function readPid() {
  try {
    if (!fs.existsSync(PID_FILE)) return null;
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    if (!pid) return null;
    process.kill(pid, 0); // 探活
    return pid;
  } catch {
    return null;
  }
}

export async function checkTrayHealth() {
  const { tray } = traySettings();
  const byPid = readPid();
  const byScan = byPid ? byPid : await findTrayProcess();
  return { wanted: tray.enabled !== false, alive: !!byScan, pid: byScan };
}

export async function startTray() {
  const { tray, port } = traySettings();
  if (tray.enabled === false) {
    log.info('系统托盘已在设置中关闭，跳过。');
    return { ok: false, reason: 'disabled' };
  }
  if (readPid()) {
    log.debug('托盘进程已在运行。');
    return { ok: true, reused: true };
  }

  ensureDirs();
  const shell = pwshPath();

  try {
    // 用 cmd start 完全脱离父进程树：这样父进程退出/被结束也不会带走托盘
    const quoted = (s) => `"${String(s).replace(/"/g, '')}"`;
    const inner = [
      quoted(shell),
      '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass',
      '-File', quoted(PS_SCRIPT),
      '-Port', String(port),
      '-Root', quoted(ROOT),
    ].join(' ');

    const child = spawn('cmd.exe', ['/c', 'start', '', '/b', inner], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: ROOT,
    });
    child.unref();
    log.success(`系统托盘已启动。关闭控制台页面后，软件仍会在后台按计划执行。`);
    // cmd start 不返回子进程 pid，稍后通过进程名探测
    return { ok: true, viaCmd: true };
  } catch (err) {
    // 回退：直接 spawn
    try {
      const child = spawn(shell, [
        '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass',
        '-File', PS_SCRIPT, '-Port', String(port), '-Root', ROOT,
      ], { detached: true, stdio: 'ignore', windowsHide: true, cwd: ROOT });
      child.unref();
      if (child.pid) fs.writeFileSync(PID_FILE, String(child.pid), 'utf8');
      log.success(`系统托盘已启动（进程 ${child.pid}）。`);
      return { ok: true, pid: child.pid };
    } catch (err2) {
      log.error('启动系统托盘失败：' + err2.message);
      return { ok: false, error: err2.message };
    }
  }
}

/** 探测系统里是否有我们的托盘进程（cmd start 方式拿不到 pid） */
export function findTrayProcess() {
  return new Promise((resolve) => {
    const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'powershell.exe\'" | Where-Object { $_.CommandLine -like \'*tray.ps1*\' } | Select-Object -First 1 -ExpandProperty ProcessId';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      if (err) return resolve(null);
      const pid = Number(String(stdout).trim().split(/\r?\n/)[0]);
      resolve(Number.isFinite(pid) && pid > 0 ? pid : null);
    });
  });
}

export async function stopTray() {
  let pid = readPid();
  if (!pid) pid = await findTrayProcess();
  if (pid) {
    try {
      process.kill(pid);
      log.info('系统托盘已关闭。');
    } catch { /* 忽略 */ }
  }
  // 双保险：按命令行特征再清理一次
  await new Promise((resolve) => {
    const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'powershell.exe\'" | Where-Object { $_.CommandLine -like \'*tray.ps1*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15000 }, () => resolve());
  });
  try { fs.unlinkSync(PID_FILE); } catch { /* 忽略 */ }
  return { ok: true };
}

/** 设置面板里切换托盘开关 */
export async function setTrayEnabled(enabled) {
  saveApplication({ tray: { enabled: !!enabled } });
  if (enabled) {
    const r = await startTray();
    return { enabled: true, ...r };
  }
  await stopTray();
  return { enabled: false };
}

/** 注册 / 注销开机自启（写入用户启动项文件夹的快捷方式） */
export async function setAutostart(enabled) {
  const startupDir = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const lnk = path.join(startupDir, 'Microsoft Rewards 自动签到.lnk');
  if (!fs.existsSync(startupDir)) return { ok: false, error: '未找到启动项文件夹' };
  if (!enabled) {
    try { fs.unlinkSync(lnk); log.info('已取消开机自启。'); } catch { /* 忽略 */ }
    return { ok: true, enabled: false };
  }
  const vbs = path.join(APP_DIR, 'startup-boot.vbs');
  const ps = `
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut('${lnk.replace(/'/g, "''")}')
$sc.TargetPath = '${process.execPath.replace(/'/g, "''")}'
$sc.Arguments = '"${vbs.replace(/'/g, "''")}"'
$sc.WorkingDirectory = '${ROOT.replace(/'/g, "''")}'
$sc.WindowStyle = 7
$sc.Description = 'Microsoft Rewards 自动签到（后台托盘）'
$sc.Save()
`;
  return new Promise((resolve) => {
    execFile(pwshPath(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true }, (err) => {
      if (err) {
        log.warn('注册开机自启失败：' + err.message);
        resolve({ ok: false, error: err.message });
      } else {
        log.success('已设置开机自启（后台静默启动到托盘）。');
        resolve({ ok: true, enabled: true, lnk });
      }
    });
  });
}

export async function quitApp() {
  await stopTray();
  const { stopScheduler } = await import('./scheduler.js');
  stopScheduler();
}
