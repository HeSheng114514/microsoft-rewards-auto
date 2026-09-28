/* Microsoft Rewards 自动签到 - 控制台前端（多账号） */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const api = async (path, opts) => {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
    return res.json();
  };

  let status = null;          // /api/status 返回
  let current = null;         // 当前选中账号快照
  let currentId = localStorage.getItem('dsh-rewards-account') || null;
  let saving = false;

  /* ---------------- 视图切换 ---------------- */
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
      btn.classList.add('active');
      $('view-' + btn.dataset.view).classList.add('active');
    });
  });
  $('btnGoHistory').addEventListener('click', () => document.querySelector('[data-view="history"]').click());
  $('btnGoAccounts').addEventListener('click', () => document.querySelector('[data-view="accounts"]').click());

  /* ---------------- 提示 ---------------- */
  let toastTimer = null;
  function toast(msg, kind = '') {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast ' + kind;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
  }

  /* ---------------- 工具 ---------------- */
  const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('zh-CN'));
  const relTime = (iso) => {
    if (!iso) return '—';
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    return `${Math.floor(diff / 86400)} 天前`;
  };
  const fmtDate = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  const STATUS_LABEL = { ok: '成功', failed: '失败', cancelled: '已取消', running: '执行中' };
  const TRIGGER_LABEL = { manual: '手动', schedule: '定时', startup: '启动补跑', cli: '命令行' };

  /* ---------------- 账号选择 ---------------- */
  function renderAccountSelect() {
    const sel = $('accountSelect');
    const accounts = (status && status.accounts) || [];
    if (!accounts.length) {
      sel.innerHTML = '<option>（无账号）</option>';
      return;
    }
    sel.innerHTML = accounts.map((a) =>
      `<option value="${esc(a.id)}"${a.id === currentId ? ' selected' : ''}>${esc(a.label)}${a.enabled === false ? '（已停用）' : ''}</option>`).join('');
    const acc = current && current.account;
    $('accountMeta').textContent = current
      ? `${acc && acc.signedIn ? '已登录' : '未登录'} · 积分 ${fmt(acc && acc.points)}`
      : '—';
  }

  $('accountSelect').addEventListener('change', (e) => {
    currentId = e.target.value;
    localStorage.setItem('dsh-rewards-account', currentId);
    current = ((status && status.accounts) || []).find((a) => a.id === currentId) || null;
    renderAll();
  });

  /* ---------------- 渲染：总览 ---------------- */
  function renderDashboard() {
    const a = current;
    const acc = (a && a.account) || {};

    $('headAccount').textContent = a ? `· ${a.label}` : '';
    $('brandSub').textContent = status && status.running
      ? `正在执行 ${status.runningAccount || ''}…`
      : (acc.signedIn ? '已就绪，等待计划' : '有账号未登录');

    $('stPoints').textContent = fmt(acc.points);
    $('stLevel').textContent = acc.signedIn
      ? `${acc.level || '已登录'} · 更新于 ${relTime(acc.updatedAt)}`
      : (a ? '未登录，请点击「登录本账号」' : '—');

    $('stTodayGain').textContent = '+' + fmt((a && a.today && a.today.gain) || 0);
    $('stTodayRuns').textContent = `今日自动执行 ${(a && a.today && a.today.runs) || 0} 次 · 搜索 ${(a && a.today && a.today.searches) || 0} 次`;

    const sch = (status && status.scheduler) || {};
    const nr = (a && a.nextRunAt) || sch.nextRunAt;
    $('stNext').textContent = nr ? fmtDate(nr) : '未启用';
    $('stNextHint').textContent = sch.enabled
      ? (sch.mode === 'interval'
        ? `每隔 ${sch.intervalMinutes} 分钟`
        : `每天 ${(sch.dailyTimes || []).join(' / ')} · 共 ${sch.enabledCount} 个账号`)
      : '定时执行已关闭';

    $('stTotals').textContent = `${fmt(a && a.totals && a.totals.runs)} / ${fmt(a && a.totals && a.totals.earned)}`;
    $('stAccount').textContent = a && a.last ? `上次执行：${fmtDate(a.last.startedAt)}` : '尚未执行过';

    const badge = $('runBadge');
    const last = a && a.last;
    if (status && status.running) {
      badge.className = 'badge running';
      badge.textContent = '执行中';
      $('runDetail').textContent = `正在执行账号 ${status.runningAccount || ''}，请稍候…`;
      $('btnRun').disabled = true;
      $('btnRunAll').disabled = true;
      $('btnCancel').hidden = false;
    } else {
      $('btnRun').disabled = false;
      $('btnRunAll').disabled = false;
      $('btnCancel').hidden = true;
      if (!last) {
        badge.className = 'badge idle';
        badge.textContent = '空闲';
        $('runDetail').textContent = '尚未执行过，点击「本账号执行」开始。';
      } else {
        const cls = { ok: 'ok', failed: 'failed', cancelled: 'warn', running: 'running' }[last.status] || 'idle';
        badge.className = 'badge ' + cls;
        badge.textContent = STATUS_LABEL[last.status] || last.status;
        $('runDetail').textContent = `${fmtDate(last.startedAt)} · ${last.message || ''}`;
      }
    }

    const box = $('quotaList');
    const items = last && last.quotaItems;
    if (!items || !items.length) {
      box.innerHTML = '<div class="muted">暂无额度数据，执行一次后显示。</div>';
    } else {
      box.innerHTML = items.map((it) => {
        const pct = it.total ? Math.min(100, Math.round((it.done / it.total) * 100)) : 0;
        return `<div class="quota-item">
          <div class="quota-top">
            <span class="quota-name">${esc(it.label || it.kind)}</span>
            <span class="quota-num">${it.done} / ${it.total}${it.remaining ? ` · 剩 ${it.remaining}` : ''}</span>
          </div>
          <div class="quota-bar"><div class="quota-fill ${pct >= 100 ? 'done' : ''}" style="width:${pct}%"></div></div>
        </div>`;
      }).join('');
    }

    // 任务清单
    renderTasks(last);

    const ov = $('accountOverview');
    const accounts = (status && status.accounts) || [];
    ov.innerHTML = accounts.length ? accounts.map((x) => `
      <div class="list-row">
        <div class="grow">
          <div class="title">${esc(x.label)}${x.id === currentId ? ' · 当前' : ''}${x.enabled === false ? ' · 已停用' : ''}</div>
          <div class="sub">${esc(x.emailHint || x.id)} · ${x.account && x.account.signedIn ? '已登录' : '未登录'} · 下次 ${x.nextRunLocal ? fmtDate(x.nextRunAt) : '—'}</div>
        </div>
        <span class="pill">${fmt(x.account && x.account.points)} 分</span>
        <span class="pill ${x.account && x.account.signedIn ? 'ok' : ''}">${x.account && x.account.signedIn ? '正常' : '待登录'}</span>
      </div>`).join('') : '<div class="muted">暂无账号</div>';

    const rec = $('recentList');
    const list = ((a && a.recentHistory) || []).slice(0, 5);
    rec.innerHTML = list.length ? list.map(rowHtml).join('') : '<div class="muted">暂无记录</div>';
  }

  /** 任务清单：本次发现 / 已自动完成 / 仍需人工 */
  function renderTasks(last) {
    const box = $('taskList');
    const summary = $('taskSummary');
    if (!last || !last.dailySet) {
      box.innerHTML = '<div class="muted">执行一次后显示本次发现的任务与处理结果。</div>';
      summary.textContent = '';
      return;
    }
    const ds = last.dailySet;
    const items = ds.items || [];
    const manual = last.manualTasks || [];
    summary.textContent = `发现 ${ds.totalPending || 0} 项 · 自动完成 ${ds.completed || 0} 项 · 待人工 ${manual.length} 项`;

    const rows = [];
    for (const it of items) {
      rows.push(`<div class="list-row">
        <div class="grow">
          <div class="title">${esc(it.title || '(未命名任务)')}${it.points ? ` <span class="pill">+${it.points}</span>` : ''}</div>
          <div class="sub">${it.kind === 'search' ? '每日活动' : '引导/访问'} 任务</div>
        </div>
        <span class="pill ${it.ok ? 'ok' : 'failed'}">${it.ok ? '已自动完成' : '失败'}</span>
      </div>`);
    }
    for (const t of manual) {
      rows.push(`<div class="list-row">
        <div class="grow">
          <div class="title">${esc(t.title)}${t.points ? ` <span class="pill">+${t.points}</span>` : ''}</div>
          <div class="sub">需你手动完成${t.href ? ` · ${esc(t.href)}` : ''}</div>
        </div>
        <span class="pill" style="color:#e8b339">待人工</span>
      </div>`);
    }
    box.innerHTML = rows.length ? rows.join('') : '<div class="muted">本次没有发现待办任务（可能今日已完成）。</div>';
  }

  function rowHtml(h) {
    const gain = (h.pointsAfter || 0) - (h.pointsBefore || 0);
    const cls = { ok: 'ok', failed: 'failed', cancelled: 'cancelled' }[h.status] || '';
    const label = STATUS_LABEL[h.status] || h.status;
    const trig = TRIGGER_LABEL[h.trigger] || h.trigger;
    return `<div class="list-row">
      <div class="grow">
        <div class="title">${esc(h.message || label)}</div>
        <div class="sub">${fmtDate(h.startedAt)} · ${trig}${h.searches ? ` · 搜索 ${h.searches} 次` : ''}${h.pointsBefore != null ? ` · 积分 ${h.pointsBefore} → ${h.pointsAfter == null ? '?' : h.pointsAfter}` : ''}</div>
      </div>
      ${gain > 0 ? `<span class="pill ok">+${gain}</span>` : ''}
      <span class="pill ${cls}">${label}</span>
    </div>`;
  }

  /* ---------------- 渲染：账号管理 ---------------- */
  function renderAccounts() {
    const box = $('accountCards');
    const accounts = (status && status.accounts) || [];
    if (!accounts.length) {
      box.innerHTML = '<div class="card"><div class="muted">还没有账号，点击右上角「添加账号」。</div></div>';
      return;
    }
    box.innerHTML = accounts.map((a) => {
      const acc = a.account || {};
      return `<div class="account-card${a.id === currentId ? ' selected' : ''}${a.enabled === false ? ' disabled' : ''}">
        <div class="ac-head">
          <div class="ac-name">${esc(a.label)}</div>
          <span class="pill ${acc.signedIn ? 'ok' : ''}">${acc.signedIn ? '已登录' : '未登录'}</span>
        </div>
        <div class="ac-email">${esc(a.emailHint || '未标注邮箱')} · ${esc(a.id)}</div>
        ${a.sessionMismatch ? '<div class="ac-warn">⚠ 必应与 Rewards 账号不一致，建议重新登录本账号</div>' : ''}
        <div class="ac-stats">
          <div class="ac-stat"><div class="k">可用积分</div><div class="v">${fmt(acc.points)}</div></div>
          <div class="ac-stat"><div class="k">今日获得</div><div class="v">+${fmt(a.today && a.today.gain)}</div></div>
          <div class="ac-stat"><div class="k">下次执行</div><div class="v" style="font-size:12.5px">${a.nextRunAt ? fmtDate(a.nextRunAt) : '—'}</div></div>
        </div>
        <div class="ac-actions">
          <button class="btn sm primary" data-act="run" data-id="${esc(a.id)}">执行</button>
          <button class="btn sm" data-act="login" data-id="${esc(a.id)}">登录</button>
          <button class="btn sm" data-act="refresh" data-id="${esc(a.id)}">刷新</button>
          <button class="btn sm ghost" data-act="signout" data-id="${esc(a.id)}">重置登录</button>
          <button class="btn sm" data-act="select" data-id="${esc(a.id)}">选中</button>
          <button class="btn sm ghost" data-act="rename" data-id="${esc(a.id)}">改名</button>
          <button class="btn sm ghost" data-act="toggle" data-id="${esc(a.id)}">${a.enabled === false ? '启用' : '停用'}</button>
          <button class="btn sm ghost" data-act="remove" data-id="${esc(a.id)}" style="color:#ef5b5b">删除</button>
        </div>
      </div>`;
    }).join('');
  }

  $('accountCards').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const id = btn.dataset.id;
    const acc = ((status && status.accounts) || []).find((a) => a.id === id) || {};

    if (act === 'select') {
      currentId = id;
      localStorage.setItem('dsh-rewards-account', id);
      $('accountSelect').value = id;
      current = acc;
      renderAll();
      return;
    }
    if (act === 'run') return doRun(id);
    if (act === 'login') return doLogin(id);
    if (act === 'refresh') return doRefresh(id);
    if (act === 'signout') {
      if (!confirm(`重置账号「${acc.label}」的登录状态？\n\n只会清除该账号自己的登录 Cookie（不影响其他账号），之后请重新点「登录」并用本账号登录。`)) return;
      const r = await api('/api/signout', { method: 'POST', body: JSON.stringify({ account: id }) });
      if (r.ok) toast('正在重置该账号登录状态，完成后请重新登录', 'ok');
      else toast(r.error || '重置失败', 'err');
      return refresh();
    }
    if (act === 'rename') {
      const label = prompt('账号名称（自定义，便于区分）', acc.label || '');
      if (label == null) return;
      const emailHint = prompt('备注（可用邮箱前缀，可留空）', acc.emailHint || '');
      await api('/api/accounts/update', {
        method: 'POST',
        body: JSON.stringify({ id, patch: { label, emailHint: emailHint || '' } }),
      });
      toast('已更新账号信息', 'ok');
      return refresh();
    }
    if (act === 'toggle') {
      await api('/api/accounts/update', {
        method: 'POST',
        body: JSON.stringify({ id, patch: { enabled: acc.enabled === false } }),
      });
      toast(acc.enabled === false ? '已启用该账号' : '已停用该账号', 'ok');
      return refresh();
    }
    if (act === 'remove') {
      if (!confirm(`确定删除账号「${acc.label}」吗？\n其运行历史会一并移除。`)) return;
      const deleteData = confirm('是否同时删除该账号的浏览器登录数据？\n确定=删除登录数据，取消=保留（下次可免登录）');
      const r = await api('/api/accounts/remove', { method: 'POST', body: JSON.stringify({ id, deleteData }) });
      if (r.ok) toast('账号已删除', 'ok');
      else toast(r.error || '删除失败', 'err');
      if (currentId === id) currentId = null;
      return refresh();
    }
  });

  $('btnAddAccount').addEventListener('click', async () => {
    const label = prompt('新账号名称（例如：主号 / 小号A）', '新账号');
    if (label == null) return;
    const r = await api('/api/accounts', { method: 'POST', body: JSON.stringify({ label }) });
    if (r.ok) {
      currentId = r.data.id;
      localStorage.setItem('dsh-rewards-account', currentId);
      toast('账号已添加，请点击该账号的「登录」完成授权', 'ok');
      await refresh();
      document.querySelector('[data-view="accounts"]').click();
    } else {
      toast(r.error || '添加失败', 'err');
    }
  });

  /* ---------------- 设置表单 ---------------- */
  function fillForm() {
    if (!status) return;
    const global = status.application || {};
    const eff = (current && current.config) || {};
    const scope = $('scopeSelect').value;
    const useGlobal = scope === 'global';

    $('scopeTip').innerHTML = useGlobal
      ? '<p>当前编辑：<strong>全局默认设置</strong>。保存后影响所有账号；账号若有单独覆盖，对应项仍以账号的为准。</p>'
      : `<p>当前编辑：<strong>账号「${esc(current ? current.label : '—')}」</strong>的独立设置。搜索 / 任务 / 浏览器可按账号区分，定时与托盘为全局。</p>`;

    const s = global.schedule || {};
    $('sched_enabled').checked = s.enabled !== false;
    $('sched_mode').value = s.mode || 'daily';
    $('sched_interval').value = s.intervalMinutes == null ? 240 : s.intervalMinutes;
    $('sched_max').value = s.maxRunsPerDay == null ? 2 : s.maxRunsPerDay;
    $('sched_stagger').value = s.staggerSeconds == null ? 90 : s.staggerSeconds;
    $('sched_catchup').checked = s.catchUp !== false;
    $('sched_runOnStart').checked = !!s.runOnStart;
    $('sched_skipWeekends').checked = !!s.skipWeekends;
    fillTimes(s.dailyTimes || ['09:10']);
    toggleMode(s.mode || 'daily');

    const se = useGlobal ? Object.assign({}, global.search) : Object.assign({}, global.search, eff.search || {});
    $('search_enabled').checked = se.enabled !== false;
    $('search_autoFill').checked = se.autoFillToCap !== false;
    $('search_mobileMode').checked = !!se.mobileMode;
    $('search_max').value = se.maxSearches == null ? 40 : se.maxSearches;
    $('search_minDelay').value = Math.round((se.minDelayMs == null ? 2500 : se.minDelayMs) / 1000);
    $('search_maxDelay').value = Math.round((se.maxDelayMs == null ? 7000 : se.maxDelayMs) / 1000);
    $('search_stopNoGain').value = se.stopAfterNoGain == null ? 3 : se.stopAfterNoGain;
    $('search_querySource').value = se.querySource || 'mixed';
    $('search_verify').checked = se.verifyPoints !== false;
    $('search_readNews').checked = se.readNews !== false;

    const t = useGlobal ? Object.assign({}, global.tasks) : Object.assign({}, global.tasks, eff.tasks || {});
    $('tasks_enabled').checked = t.enabled !== false;
    $('tasks_dailySet').checked = t.doDailySet !== false;
    $('tasks_claim').checked = t.claimPoints !== false;
    $('tasks_visitEarn').checked = t.visitEarnPage !== false;
    $('tasks_mobile').checked = t.checkMobileApp !== false;
    $('tasks_quizzes').checked = !!t.doQuizzes;

    const b = useGlobal ? Object.assign({}, global.browser) : Object.assign({}, global.browser, eff.browser || {});
    $('browser_kind').value = b.kind || 'msedge';
    $('browser_headless').checked = b.headless !== false;
    $('advanced_keepOpen').checked = !!(global.advanced && global.advanced.keepBrowserOpen);
    $('advanced_screenshot').checked = !(global.advanced && global.advanced.screenshotOnError === false);

    const tr = global.tray || {};
    $('tray_enabled').checked = tr.enabled !== false;
    $('tray_autostart').checked = tr.autostart !== false;

    renderBrowserTip();
  }

  function fillTimes(times) {
    const box = $('timesList');
    box.innerHTML = '';
    times.forEach((t) => addTimeChip(t));
  }
  function addTimeChip(value) {
    const wrap = document.createElement('div');
    wrap.className = 'time-chip';
    const input = document.createElement('input');
    input.type = 'time';
    input.value = value || '09:00';
    const del = document.createElement('button');
    del.textContent = '×';
    del.title = '删除该时刻';
    del.addEventListener('click', () => wrap.remove());
    wrap.append(input, del);
    $('timesList').appendChild(wrap);
  }
  $('btnAddTime').addEventListener('click', () => addTimeChip('20:00'));

  function toggleMode(mode) {
    document.querySelectorAll('[data-mode]').forEach((el) => {
      el.style.display = el.dataset.mode === mode ? '' : 'none';
    });
  }
  $('sched_mode').addEventListener('change', (e) => toggleMode(e.target.value));
  $('scopeSelect').addEventListener('change', () => fillForm());

  async function renderBrowserTip() {
    try {
      const r = await api('/api/browsers');
      if (!r.ok) return;
      const kind = $('browser_kind').value;
      const b = r.data.find((x) => x.kind === kind);
      $('browserTip').textContent = b
        ? (b.available ? `已检测到：${b.label}${b.execPath ? ' — ' + b.execPath : ''}` : `${b.label} 不可用，请改用其他浏览器`)
        : '';
    } catch { /* 忽略 */ }
  }
  $('browser_kind').addEventListener('change', renderBrowserTip);

  function collect() {
    const times = [...document.querySelectorAll('#timesList input[type="time"]')].map((i) => i.value).filter(Boolean);
    return {
      schedule: {
        enabled: $('sched_enabled').checked,
        mode: $('sched_mode').value,
        dailyTimes: times.length ? [...new Set(times)].sort() : ['09:10'],
        intervalMinutes: Number($('sched_interval').value) || 240,
        maxRunsPerDay: Number($('sched_max').value) || 2,
        staggerSeconds: Number($('sched_stagger').value) || 90,
        catchUp: $('sched_catchup').checked,
        runOnStart: $('sched_runOnStart').checked,
        skipWeekends: $('sched_skipWeekends').checked,
      },
      search: {
        enabled: $('search_enabled').checked,
        autoFillToCap: $('search_autoFill').checked,
        mobileMode: $('search_mobileMode').checked,
        maxSearches: Number($('search_max').value) || 40,
        minDelayMs: (Number($('search_minDelay').value) || 3) * 1000,
        maxDelayMs: (Number($('search_maxDelay').value) || 8) * 1000,
        stopAfterNoGain: Number($('search_stopNoGain').value) || 3,
        querySource: $('search_querySource').value,
        verifyPoints: $('search_verify').checked,
        readNews: $('search_readNews').checked,
      },
      tasks: {
        enabled: $('tasks_enabled').checked,
        doDailySet: $('tasks_dailySet').checked,
        claimPoints: $('tasks_claim').checked,
        visitEarnPage: $('tasks_visitEarn').checked,
        checkMobileApp: $('tasks_mobile').checked,
        doQuizzes: $('tasks_quizzes').checked,
      },
      browser: {
        kind: $('browser_kind').value,
        headless: $('browser_headless').checked,
      },
      advanced: {
        keepBrowserOpen: $('advanced_keepOpen').checked,
        screenshotOnError: $('advanced_screenshot').checked,
      },
      tray: {
        enabled: $('tray_enabled').checked,
        autostart: $('tray_autostart').checked,
      },
    };
  }

  /* ---------------- 表单「脏」状态保护 ----------------
   *
   * 状态轮询每 5 秒刷新一次，若无条件重填表单，用户在输入框里改的值会在
   * 5 秒后被服务器上的旧值覆盖（表现为「改了就自动变回去」）。
   * 因此：只要用户动过设置表单，就暂停自动重填，直到保存完成或手动放弃修改。
   */
  let formDirty = false;

  function markDirty() {
    if (formDirty) return;
    formDirty = true;
    updateDirtyHint();
  }

  function clearDirty() {
    formDirty = false;
    updateDirtyHint();
  }

  function updateDirtyHint() {
    const el = $('dirtyHint');
    if (!el) return;
    // 用 class 控制显示：hidden 属性会被 .dirty-hint 的 display:flex 覆盖
    el.classList.toggle('is-hidden', !formDirty);
    el.hidden = !formDirty;
  }

  /** 给设置表单里的所有输入项挂上变更监听 */
  function bindDirtyWatchers() {
    const view = $('view-settings');
    if (!view) return;
    const handler = (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      // 头部操作区与未保存提示条里的按钮不算「修改表单」
      if (t.closest('.actions') || t.closest('#dirtyHint')) return;
      markDirty();
    };
    view.addEventListener('input', handler);
    view.addEventListener('change', handler);
  }
  bindDirtyWatchers();

  /** 放弃当前修改，恢复到已保存的值 */
  async function discardChanges() {
    clearDirty();
    await refresh();
    clearDirty(); // refresh 会重填表单，之后再次确保标记已清除
    toast('已放弃修改，恢复为已保存的设置');
  }
  const discardBtn = $('btnDiscard');
  if (discardBtn) discardBtn.addEventListener('click', discardChanges);

  /* ---------------- 发送保存 ---------------- */
  async function saveSettings() {
    const scope = $('scopeSelect').value;
    const data = collect();
    saving = true;
    $('btnSave').disabled = true;
    try {
      // 定时 / 托盘 / 高级 属于全局
      await api('/api/settings', {
        method: 'POST',
        body: JSON.stringify({ schedule: data.schedule, tray: data.tray, advanced: data.advanced }),
      });
      if (scope === 'global') {
        await api('/api/settings', { method: 'POST', body: JSON.stringify(data) });
      } else {
        if (!currentId) throw new Error('请先选择一个账号');
        const r = await api('/api/accounts/update', {
          method: 'POST',
          body: JSON.stringify({
            id: currentId,
            patch: { overrides: { search: data.search, tasks: data.tasks, browser: data.browser } },
          }),
        });
        if (!r.ok) throw new Error(r.error || '保存账号设置失败');
      }
      await api('/api/tray', { method: 'POST', body: JSON.stringify({ enabled: $('tray_enabled').checked }) }).catch(() => {});
      clearDirty(); // 保存完成，允许后续轮询重填
      toast(scope === 'global' ? '全局默认设置已保存' : '当前账号设置已保存', 'ok');
      await refresh();
    } catch (e) {
      toast('保存失败：' + e.message + '（你的修改仍保留在表单中，请修正后重试）', 'err');
      // 保存失败不清除脏状态，避免把用户刚填的值刷掉
    } finally {
      $('btnSave').disabled = false;
      setTimeout(() => { saving = false; }, 1200);
    }
  }

  $('btnSave').addEventListener('click', saveSettings);

  // Ctrl+S 也可保存
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      const settingsVisible = $('view-settings')?.classList.contains('active');
      if (settingsVisible) { e.preventDefault(); saveSettings(); }
    }
  });

  $('btnReset').addEventListener('click', () => {
    if (!status || !status.defaults) return;
    const scope = $('scopeSelect').value;
    if (!confirm(scope === 'global' ? '将全局默认恢复为初始值？' : '将当前账号的搜索/任务/浏览器设置恢复为默认？')) return;
    const d = status.defaults;
    if (scope === 'global') {
      status.application = JSON.parse(JSON.stringify(d.application));
    } else if (current) {
      current.config = Object.assign({}, current.config, {
        search: Object.assign({}, d.application.search, d.overrides.search),
        tasks: Object.assign({}, d.application.tasks, d.overrides.tasks),
        browser: Object.assign({}, d.application.browser, d.overrides.browser),
      });
    }
    fillForm();
    toast('已填入默认值，点击「保存设置」生效');
  });

  /* ---------------- 操作 ---------------- */
  async function doRun(accountId) {
    const r = await api('/api/run', { method: 'POST', body: JSON.stringify({ account: accountId || currentId }) });
    if (r.ok) { toast(r.message || '已开始执行', 'ok'); setTimeout(refresh, 800); }
    else toast(r.error || '无法启动', 'err');
  }
  async function doLogin(accountId) {
    const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ account: accountId || currentId }) });
    if (r.ok) toast(r.message || '已打开登录窗口', 'ok');
    else toast(r.error || '无法启动登录', 'err');
  }
  async function doRefresh(accountId) {
    const r = await api('/api/refresh', { method: 'POST', body: JSON.stringify({ account: accountId || currentId }) });
    if (r.ok) toast('正在刷新账户信息…', 'ok');
    else toast(r.error || '刷新失败', 'err');
  }

  $('btnRun').addEventListener('click', () => doRun());
  $('btnLogin').addEventListener('click', () => doLogin());
  $('btnRefresh').addEventListener('click', () => doRefresh());
  $('btnRunAll').addEventListener('click', async () => {
    const r = await api('/api/run-all', { method: 'POST' });
    if (r.ok) { toast(r.message || '已开始', 'ok'); setTimeout(refresh, 800); }
    else toast(r.error || '无法启动', 'err');
  });
  $('btnCancel').addEventListener('click', async () => {
    const r = await api('/api/cancel', { method: 'POST' });
    toast(r.message || '', r.ok ? '' : 'err');
  });

  /* ---------------- 历史 ---------------- */
  async function loadHistory() {
    const box = $('historyList');
    const all = $('historyAll').checked;
    $('historyAccount').textContent = all ? '（全部账号）' : (current ? `· ${current.label}` : '');

    let rows = [];
    if (all) {
      for (const a of (status && status.accounts) || []) {
        const r = await api('/api/history?account=' + encodeURIComponent(a.id));
        if (r.ok) rows.push(...r.data.map((h) => Object.assign({}, h, { accountLabel: h.accountLabel || a.label })));
      }
      rows.sort((x, y) => new Date(y.startedAt) - new Date(x.startedAt));
      rows = rows.slice(0, 100);
    } else {
      const r = await api('/api/history?account=' + encodeURIComponent(currentId || ''));
      rows = r.ok ? r.data : [];
    }

    box.innerHTML = rows.length ? rows.map((h) => {
      const cls = { ok: 'ok', failed: 'failed', cancelled: 'cancelled' }[h.status] || '';
      const label = STATUS_LABEL[h.status] || h.status;
      const gain = (h.pointsAfter || 0) - (h.pointsBefore || 0);
      const trig = TRIGGER_LABEL[h.trigger] || h.trigger;
      const mobile = h.mobileApp && h.mobileApp.done != null ? ` · 移动签到 ${h.mobileApp.done}/${h.mobileApp.total}` : '';
      return `<div class="list-row">
        <div class="grow">
          <div class="title">${h.accountLabel ? esc(`[${h.accountLabel}] `) : ''}${esc(h.message || label)}</div>
          <div class="sub">${fmtDate(h.startedAt)} → ${fmtDate(h.endedAt)} · ${trig}${h.searches ? ` · 搜索 ${h.searches} 次` : ''}${h.dailySet && h.dailySet.completed ? ` · 任务 ${h.dailySet.completed} 项` : ''}${h.claimed && h.claimed.claimed ? ` · 领取 ${h.claimed.amount || ''}` : ''}${mobile}</div>
          ${h.pointsBefore != null ? `<div class="sub">积分 ${h.pointsBefore} → ${h.pointsAfter == null ? '?' : h.pointsAfter}${gain > 0 ? ` ( +${gain} )` : ''}</div>` : ''}
        </div>
        <span class="pill ${cls}">${label}</span>
      </div>`;
    }).join('') : '<div class="muted">暂无记录</div>';
  }
  $('historyAll').addEventListener('change', loadHistory);

  /* ---------------- 日志 ---------------- */
  const logBox = $('logBox');
  function appendLog(e) {
    const line = document.createElement('span');
    line.className = 'log-line ' + (e.level || 'info');
    const time = (e.time || '').split(' ')[1] || '';
    line.innerHTML = `<span class="log-time">${esc(time)}</span>${esc(e.message)}`;
    logBox.appendChild(line);
    while (logBox.childNodes.length > 1000) logBox.removeChild(logBox.firstChild);
    if ($('autoScroll').checked) logBox.scrollTop = logBox.scrollHeight;
  }
  $('btnClearLogs').addEventListener('click', () => { logBox.innerHTML = ''; });

  function connectSSE() {
    const es = new EventSource('/api/events');
    es.addEventListener('log', (ev) => {
      try { appendLog(JSON.parse(ev.data)); } catch { /* 忽略 */ }
    });
    es.addEventListener('notice', (ev) => {
      try {
        const d = JSON.parse(ev.data);
        toast(d.message, d.level === 'success' ? 'ok' : d.level === 'error' ? 'err' : '');
      } catch { /* 忽略 */ }
    });
    es.addEventListener('status', () => refresh());
    es.onopen = () => setConn(true);
    es.onerror = () => setConn(false);
  }

  function setConn(ok) {
    $('connDot').className = 'dot ' + (ok ? 'ok' : 'bad');
    $('connText').textContent = ok ? '已连接' : '连接断开';
  }

  /* ---------------- 拉取与调度 ---------------- */
  function renderAll() {
    renderAccountSelect();
    renderDashboard();
    renderAccounts();
    // 用户正在编辑设置时不要重填表单，否则输入会被轮询覆盖
    if (!saving && !formDirty) fillForm();
    updateDirtyHint();
  }

  async function refresh() {
    try {
      const r = await api('/api/status');
      if (!r.ok) return;
      status = r.data;
      if (!currentId || !status.accounts.some((a) => a.id === currentId)) {
        currentId = (status.accounts[0] && status.accounts[0].id) || null;
        if (currentId) localStorage.setItem('dsh-rewards-account', currentId);
      }
      current = status.accounts.find((a) => a.id === currentId) || null;
      if (current) {
        const h = await api('/api/history?account=' + encodeURIComponent(current.id));
        current.recentHistory = h.ok ? h.data : [];
      }
      renderAll();
      setConn(true);
    } catch {
      setConn(false);
    }
  }

  (async () => {
    const logs = await api('/api/logs').catch(() => ({ ok: false }));
    if (logs.ok) logs.data.forEach(appendLog);
    await refresh();
    await loadHistory();
    connectSSE();
    setInterval(refresh, 5000);
    setInterval(loadHistory, 25000);
  })();
})();
