# Microsoft Rewards 自动签到 —— 系统托盘
# 由 app/tray.js 启动，常驻任务栏通知区域
param(
  [int]$Port = 8787,
  [string]$Root = ''
)

$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:Base = "http://127.0.0.1:$Port"
$script:Paused = $false
$script:Status = $null

function Get-Status {
  try {
    return Invoke-RestMethod -Uri "$($script:Base)/api/status" -TimeoutSec 5
  } catch {
    return $null
  }
}

function Invoke-Api {
  param([string]$Path, [string]$Method = 'POST', [string]$Body = '{}')
  try {
    Invoke-RestMethod -Uri "$($script:Base)$Path" -Method $Method -ContentType 'application/json' -Body $Body -TimeoutSec 8 | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Open-Console {
  Start-Process "http://127.0.0.1:$Port"
}

# ---------------- 托盘图标 ----------------
$notify = New-Object System.Windows.Forms.NotifyIcon
try {
  $notify.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon((Get-Process -Id $PID).Path)
} catch {
  $notify.Icon = [System.Drawing.SystemIcons]::Application
}
$notify.Text = 'Microsoft Rewards 自动签到'
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$itemOpen = $menu.Items.Add('打开控制台')
$itemRun = $menu.Items.Add('立即执行一次')
$itemSep1 = $menu.Items.Add('-')
$itemToggle = $menu.Items.Add('暂停定时执行')
$itemSep2 = $menu.Items.Add('-')
$itemQuit = $menu.Items.Add('退出程序')

$itemOpen.add_Click({ Open-Console })
$itemRun.add_Click({
  if (Invoke-Api -Path '/api/run') {
    $notify.ShowBalloonTip(2500, 'Rewards 自动签到', '已开始执行，正在自动搜索与处理任务…', 'Info')
  } else {
    $notify.ShowBalloonTip(2500, 'Rewards 自动签到', '启动失败，可能已有任务在执行。', 'Warning')
  }
})
$itemToggle.add_Click({
  $script:Paused = -not $script:Paused
  if ($script:Paused) {
    Invoke-Api -Path '/api/config' -Body '{"schedule":{"enabled":false}}' | Out-Null
    $itemToggle.Text = '恢复定时执行'
    $notify.Text = 'Rewards 自动签到（已暂停）'
  } else {
    Invoke-Api -Path '/api/config' -Body '{"schedule":{"enabled":true}}' | Out-Null
    $itemToggle.Text = '暂停定时执行'
    $notify.Text = 'Microsoft Rewards 自动签到'
  }
})
$itemQuit.add_Click({
  Invoke-Api -Path '/api/tray' -Body '{"action":"quit"}' | Out-Null
  $notify.Visible = $false
  $notify.Dispose()
  [System.Windows.Forms.Application]::Exit()
  [Environment]::Exit(0)
})
$notify.ContextMenuStrip = $menu
$notify.add_MouseDoubleClick({ Open-Console })

# ---------------- 状态轮询 ----------------
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 15000
$timer.add_Tick({
  $s = Get-Status
  if ($null -eq $s -or -not $s.ok) {
    $notify.Text = 'Rewards 自动签到（未连接）'
    return
  }
  $script:Status = $s.data
  $d = $s.data
  $pts = if ($null -ne $d.account.points) { $d.account.points } else { '?' }
  $state = if ($d.running) { '执行中' } elseif ($d.account.signedIn) { '待命' } else { '未登录' }
  # 通知区域文本上限 63 字符
  $notify.Text = "Rewards 自动签到 · $state · 积分 $pts"
})
$timer.Start()

# 首次连接提示
$first = Get-Status
if ($null -eq $first -or -not $first.ok) {
  $notify.ShowBalloonTip(3000, 'Rewards 自动签到', '托盘已启动，但未连接到主程序。', 'Warning')
} else {
  $pts = if ($null -ne $first.data.account.points) { $first.data.account.points } else { '?' }
  $notify.ShowBalloonTip(3000, 'Rewards 自动签到已就绪', "已最小化到托盘，将按计划自动执行。当前积分：$pts", 'Info')
}

[System.Windows.Forms.Application]::Run()
