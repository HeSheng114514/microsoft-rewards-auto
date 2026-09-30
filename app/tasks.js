/**
 * 任务执行：每日活动、新手任务（开始使用 Rewards）、可领取积分、积分赚取页
 *
 * 关键教训：仪表盘上「开始使用 Rewards」区块**没有 id**，它的任务（设定奖励目标
 * +50、完成每日任务集 +50、浏览赚取页面 +10）也是 <a href> 而非搜索链接。
 * 早期只解析 #dailyset，导致这些任务被整体漏掉。
 */
import { log } from './logger.js';
import {
  inspect, analyzeQuota, fetchEarnTasks, collectTasks, fetchQuests, inspectQuest, DASHBOARD, EARN,
} from './rewards.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

/**
 * 执行「拼图任务」（/earn 页 #quests 里的 punchcard）
 *
 * 这类任务的要点：
 *   1. 它们**只存在于 /earn 页**，仪表盘上看不到（早期漏掉的就是它们）
 *   2. 子活动带每日解锁门：完成一格后需等 24 小时才能推进下一格
 *   3. CTA **只在当前可推进的那一格上渲染** —— 找到 CTA 就等于找到了能做的事
 *   4. 部分拼图明确要求「必须在桌面奖励应用中完成」，网页端无法代劳
 */
export async function doQuests(page, cfg) {
  const result = { total: 0, attempted: 0, clicked: 0, needsApp: [], waiting: [], items: [] };

  let quests = [];
  try {
    quests = await fetchQuests(page);
  } catch (err) {
    log.warn('读取拼图任务失败：', err.message);
    return result;
  }

  result.total = quests.length;
  if (!quests.length) {
    log.info('拼图任务：没有发现任务。');
    return result;
  }

  for (const q of quests) {
    if (q.done) {
      log.info(`拼图「${q.title}」已全部完成 ${q.progress}。`);
      result.items.push({ title: q.title, progress: q.progress, ok: true, note: '已完成' });
      continue;
    }

    let info;
    try {
      info = await inspectQuest(page, q.href);
    } catch (err) {
      log.warn(`拼图「${q.title}」解析失败：${err.message}`);
      continue;
    }

    const label = `拼图「${q.title}」${q.points ? ` +${q.points}` : ''} [${info.progress || q.progress || '?'}]`;

    // 必须在桌面 App 内完成
    if (info.requiresApp) {
      result.needsApp.push({ title: q.title, points: q.points, progress: info.progress || q.progress, href: q.href });
      log.warn(`${label} 需要「桌面奖励应用」内完成，网页端无法自动做（页面已明确说明）。`);
      result.items.push({ title: q.title, progress: info.progress, ok: false, note: '需桌面奖励应用' });
      continue;
    }

    // 当前没有可点击的 CTA -> 等待 24 小时门，或已无可推进项
    if (!info.ctas.length) {
      const reason = info.done && info.total != null && info.done >= info.total
        ? '已全部完成'
        : '当前无可执行动作（多为已完成上一格，需等 24 小时解锁下一格）';
      result.waiting.push({ title: q.title, points: q.points, progress: info.progress || q.progress, reason, href: q.href });
      log.info(`${label} 暂无可执行动作：${reason}`);
      result.items.push({ title: q.title, progress: info.progress, ok: false, note: reason });
      continue;
    }

    // 有 CTA -> 逐个点击（新标签页），点击后复核进度
    log.step(`${label} 发现 ${info.ctas.length} 个可执行动作。`);
    const before = info.progress;
    let clickedAny = false;

    for (const cta of info.ctas) {
      result.attempted += 1;
      log.step(`  执行 CTA「${cta.text}」 -> ${cta.href.slice(0, 70)}`);
      try {
        // 每次点击前回到拼图页，保证元素是最新渲染状态
        await page.goto(q.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(rand(2500, 4000));

        const handle = await page.evaluateHandle((href) => {
          const links = [...document.querySelectorAll('a[href]')];
          return links.find((a) => a.href === href) || null;
        }, cta.href);
        const el = handle.asElement();
        if (!el) {
          log.info('    该 CTA 已不在页面上（可能已处理），跳过。');
          continue;
        }

        const popupPromise = page.context().waitForEvent('page', { timeout: 15000 }).catch(() => null);
        await el.click().catch(() => {});
        const popup = await popupPromise;

        if (popup) {
          await popup.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
          await sleep(rand(4000, 6500));
          await popup.mouse.wheel(0, rand(300, 900)).catch(() => {});
          await sleep(rand(1500, 3000));
          await popup.close().catch(() => {});
        } else {
          await sleep(rand(3500, 5500));
          await page.mouse.wheel(0, rand(300, 800)).catch(() => {});
        }
        clickedAny = true;
        result.clicked += 1;
      } catch (err) {
        log.warn(`    执行失败：${err.message}`);
      }
      await sleep(rand(1500, 3000));
    }

    // 复核进度
    try {
      await sleep(2500);
      const recheck = await inspectQuest(page, q.href);
      const after = recheck.progress;
      const advanced = before && after && before !== after;
      if (advanced) log.success(`${label} 进度推进：${before} → ${after}`);
      else if (clickedAny) log.info(`${label} 已执行动作，进度暂仍为 ${after}（入账可能有延迟）。`);
      result.items.push({
        title: q.title,
        progress: after,
        ok: clickedAny,
        note: advanced ? `进度 ${before} → ${after}` : '已执行动作',
      });
    } catch { /* 复核失败不影响主流程 */ }
  }

  return result;
}

/**
 * 通用「访问型」任务执行：打开链接、模拟浏览、必要时点一下页面主按钮
 * 适用于：浏览赚取页面、新手引导类任务、积分赚取页活动
 */
export async function visitTask(page, task) {
  const item = { title: task.title, points: task.points ?? null, ok: false, note: '' };
  try {
    await page.goto(task.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(rand(2500, 4500));

    // 有些任务需要一个「领取/开始」之类的点击（排除无障碍跳转与导航项）
    const clicked = await page.evaluate(() => {
      const txt = (el) => (el ? (el.innerText || '').replace(/\s+/g, ' ').trim() : '');
      const NOISE = /^(跳至内容|跳到主要内容|Skip to|跳转|上一页|下一页|返回|首页|登录)$/;
      const cands = [...document.querySelectorAll('button, a[role="button"]')]
        .filter((b) => {
          const t = txt(b);
          const r = b.getBoundingClientRect();
          return t && t.length < 24 && !NOISE.test(t) && r.width > 0 && r.height > 0
            && /^(领取|开始|立即|继续|查看|浏览|参与|签到|获取)$/.test(t);
        });
      if (cands.length) { cands[0].click(); return txt(cands[0]); }
      return null;
    }).catch(() => null);
    if (clicked) {
      log.info(`  已点击「${clicked}」`);
      await sleep(rand(1800, 3200));
    }

    await page.mouse.wheel(0, rand(300, 900)).catch(() => {});
    await sleep(rand(1200, 2400));
    item.ok = true;
    return item;
  } catch (err) {
    item.note = err.message;
    return item;
  }
}

/**
 * 执行仪表盘上所有可自动完成的任务
 * - kind=search        每日活动的搜索任务（顺带拿分）
 * - kind=visit         访问型（赚取页、新手引导等）
 * - kind=quiz          测验类
 * - kind=reward-goal   设定奖励目标（需要挑选礼品卡，无法自动完成 -> 跳过并提示）
 */
export async function doAllDashboardTasks(page, cfg) {
  const result = {
    attempted: 0, completed: 0, skipped: [], waiting: [], items: [], totalPending: 0, pending: [],
  };

  /**
   * 按「真人行为」执行任务：在仪表盘上点击卡片本身（target=_blank 会开新标签页）。
   * 直接 page.goto 到目标 URL 时，服务端的归属判定可能不认，导致任务不记积分。
   */
  const clickOnDashboard = async (task) => {
    await page.goto(DASHBOARD, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(rand(2000, 3500));

    // 定位到对应卡片（优先用 URL 中的 offerId 特征，其次用标题文本）
    const handle = await page.evaluateHandle((t) => {
      const txt = (el) => (el ? (el.innerText || '').replace(/\s+/g, ' ').trim() : '');
      const links = [...document.querySelectorAll('a[href]')];
      // 1) 标题完全匹配
      let hit = links.find((a) => {
        const card = a.closest('div');
        const s = txt(a) || txt(card);
        return t.title && s.includes(t.title);
      });
      // 2) URL 前缀匹配
      if (!hit && t.href) {
        const base = t.href.split('?')[0];
        hit = links.find((a) => a.href.startsWith(base) && /search|earn|redeem/.test(a.href));
      }
      return hit || null;
    }, { title: task.title, href: task.href });

    const el = handle.asElement();
    if (!el) return { ok: false, note: '未在仪表盘上找到该任务卡片' };

    const popupPromise = page.context().waitForEvent('page', { timeout: 15000 }).catch(() => null);
    await el.click().catch(() => {});
    const popup = await popupPromise;

    if (popup) {
      // 新标签页：这就是真人的行为路径
      await popup.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
      await sleep(rand(3500, 6000));
      await popup.mouse.wheel(0, rand(300, 900)).catch(() => {});
      await sleep(rand(1500, 3000));
      await popup.close().catch(() => {});
      return { ok: true, note: '已通过点击卡片在新标签页完成' };
    }

    // 没有开新标签页，说明是站内跳转
    await sleep(rand(3000, 5000));
    await page.mouse.wheel(0, rand(300, 900)).catch(() => {});
    await sleep(rand(1500, 2500));
    return { ok: true, note: '已在当前标签页完成' };
  };

  let info;
  try {
    info = await inspect(page);
  } catch (err) {
    log.warn('读取仪表盘任务失败：', err.message);
    return result;
  }

  const all = info.tasks || [];
  const pending = all.filter((t) => !t.done);
  result.totalPending = pending.length;
  result.pending = pending.map((t) => ({ title: t.title, points: t.points, progress: t.progress, origin: t.origin, kind: t.kind }));

  // 全部待办任务一览（便于核对到底漏没漏）
  if (pending.length) {
    log.info(`发现 ${pending.length} 个待完成任务：`);
    for (const t of pending) {
      log.info(`   · [${t.origin}] ${t.title}${t.points ? ` +${t.points}` : ''}${t.progress ? ` (${t.progress})` : ''}`);
    }
  } else {
    log.info('没有待完成的任务。');
    return result;
  }

  for (const task of pending) {
    // 设定奖励目标需要挑选礼品卡并确认，属于人工操作
    if (task.kind === 'reward-goal') {
      result.skipped.push(task);
      log.warn(`跳过「${task.title}」：需要你在积分商城中挑选并设定一个奖励目标（人工完成，+${task.points ?? '?'} 分）。`);
      log.info('  入口：https://rewards.bing.com/redeem/?section=shop');
      continue;
    }

    /*
     * 「搜索 N 天」连击任务：由**搜索步骤**驱动，不是独立的页面访问动作。
     *
     * 实测：如「开始使用 Rewards」里的「搜索 7 天 +500」，要求「每天在必应搜索
     * 至少一次、连续七天」。打开 bing.com 首页不会推进它，只有真正执行搜索才会
     * 被记录，而且服务端按天结算（当天一次即够，无法一次跑完）。
     * 所以这里不做冗余访问，只汇报状态并说明推进方式。
     */
    if (task.kind === 'search-streak') {
      const prog = task.progress || '?';
      result.waiting.push({
        title: task.title,
        points: task.points,
        progress: prog,
        reason: '连击任务：需每天在必应搜索至少一次，连续多天才能完成',
        href: task.href,
      });
      log.info(`连击任务「${task.title}」+${task.points ?? '?'} [${prog}]：由本次搜索步骤推进，`
        + '但需每天搜索一次、连续多天，无法在单次运行里跑完。');
      result.items.push({
        title: task.title, points: task.points, ok: false, kind: task.kind, note: '连击任务，由搜索步骤推进',
      });
      continue;
    }

    result.attempted += 1;

    if (task.kind === 'search') {
      /*
       * 每日活动任务：**点击仪表盘上的卡片**是最接近真人的路径
       * （卡片是 target=_blank，会开新标签页）。直接 goto 目标 URL 时服务端
       * 可能不认归属，导致任务不记积分——实测确实如此。
       * 若卡片点击失败，再退回直接访问 URL。
       */
      log.step(`执行每日任务：「${task.title}」${task.points ? ` +${task.points}` : ''}`);
      let done = false;
      try {
        const r = await clickOnDashboard(task);
        if (r.ok) {
          log.info(`  ${r.note}`);
          done = true;
        } else {
          log.info(`  ${r.note}，改用直接访问`);
        }
      } catch (err) {
        log.info(`  卡片点击失败（${err.message}），改用直接访问`);
      }

      if (!done) {
        try {
          await page.goto(task.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await sleep(rand(2500, 4500));
          await page.mouse.wheel(0, rand(300, 800)).catch(() => {});
          await sleep(rand(1200, 2200));
          done = true;
        } catch (err) {
          log.warn(`  任务执行失败：${err.message}`);
          result.items.push({ title: task.title, ok: false, error: err.message, kind: task.kind });
          continue;
        }
      }

      result.completed += 1;
      result.items.push({ title: task.title, ok: true, points: task.points, kind: task.kind });
    } else {
      log.step(`执行任务：「${task.title}」${task.points ? ` +${task.points}` : ''}（${task.href.slice(0, 60)}）`);
      const r = await visitTask(page, task);
      if (r.ok) result.completed += 1;
      else log.warn(`  任务执行失败：${r.note}`);
      result.items.push({ ...r, kind: task.kind, ok: r.ok });
    }

    await sleep(rand(1200, 2800));
  }

  /*
   * 收尾复核：任务完成后重新读取一次，给出「还剩哪些」的真实结论。
   * 每日活动的 +10 与新手任务入账有延迟，因此这里只做一次快速复核。
   */
  try {
    await sleep(2500);
    const after = await inspect(page);
    const stillPending = (after.tasks || []).filter((t) => !t.done);
    result.pendingAfter = stillPending.map((t) => ({
      title: t.title, points: t.points, href: t.href, kind: t.kind, origin: t.origin, progress: t.progress,
    }));
    result.remaining = stillPending.length;
    result.completedVerified = (after.tasks || []).filter((t) => t.done).length;

    // 更新需要人工处理的任务（含执行后仍未完成的）
    const manual = stillPending.filter((t) => t.kind === 'reward-goal' || !t.href);
    result.skipped = manual;
  } catch { /* 复核失败不影响主流程 */ }

  return result;
}

/** 兼容旧调用：仅完成每日活动的搜索任务 */
export async function doDailySet(page, cfg) {
  const result = await doAllDashboardTasks(page, cfg);
  return {
    attempted: result.attempted,
    completed: result.completed,
    items: result.items.filter((i) => i.kind === 'search'),
  };
}

/** 尝试完成每日测验（实验性：进入测验链接并依次选择选项） */
export async function doQuizzes(page) {
  const result = { attempted: 0, completed: 0 };
  try {
    const tasks = await fetchEarnTasks(page);
    const quizzes = tasks.filter((t) => !t.done && /quiz|测验|问答|问答|小测/i.test(t.text));
    for (const q of quizzes.slice(0, 5)) {
      result.attempted += 1;
      log.step(`尝试完成测验：${q.title || q.href.slice(0, 50)}`);
      await page.goto(q.href, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await sleep(rand(2500, 4500));
      // 依次点击问答选项
      for (let i = 0; i < 4; i++) {
        const ok = await page.evaluate(() => {
          const opts = [...document.querySelectorAll('a[href*="javascript"], button, div[role="button"]')]
            .filter((b) => {
              const t = (b.innerText || '').trim();
              const r = b.getBoundingClientRect();
              return t.length > 1 && t.length < 80 && r.width > 10 && r.height > 10;
            });
          if (!opts.length) return false;
          opts[Math.floor(Math.random() * opts.length)].click();
          return true;
        }).catch(() => false);
        if (!ok) break;
        await sleep(rand(2000, 4000));
      }
      result.completed += 1;
    }
  } catch (err) {
    log.warn('测验任务失败：', err.message);
  }
  return result;
}

/** 读取奖励仪表盘的可用积分（领取校验用） */
async function dashboardPoints(page) {
  try {
    await page.goto(DASHBOARD, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3500);
    const v = await page.evaluate(() => {
      const txt = (el) => (el ? (el.innerText || '').replace(/\s+/g, ' ').trim() : '');
      const el = document.querySelector('a[href*="/redeem"] p.text-pageHeader');
      if (el) return txt(el);
      const cand = [...document.querySelectorAll('p')].find((p) => /^[\d,]+$/.test(txt(p)) && String(p.className).includes('pageHeader'));
      return cand ? txt(cand) : null;
    });
    const n = Number(String(v ?? '').replace(/[^\d]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * 领取「可领取」积分
 * 校验：页面成功提示 或 可用积分增加 或 可领取卡片消失（任一成立即判定成功）
 */
export async function claimPoints(page) {
  const result = { claimed: false, amount: null, message: '', pointsBefore: null, pointsAfter: null };
  try {
    await page.goto(DASHBOARD, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);

    const claimCard = await page.evaluate(() => {
      const txt = (el) => (el ? (el.innerText || '').replace(/\s+/g, ' ').trim() : '');
      const card = [...document.querySelectorAll('button')].find((b) => /可领取/.test(txt(b)) && /领取/.test(txt(b)));
      if (!card) return null;
      const t = txt(card);
      const amount = (t.match(/可领取\s*([\d,]+)/) || [])[1] || null;
      return { text: t, amount };
    });

    if (!claimCard) {
      result.message = '当前没有可领取的积分。';
      log.info(result.message);
      return result;
    }

    // 卡片可能是「可领取 0」，此时无需领取
    const amountNum = Number(String(claimCard.amount ?? '').replace(/[^\d]/g, ''));
    if (claimCard.amount != null && amountNum === 0) {
      result.message = '当前可领取积分为 0，无需领取。';
      log.info(result.message);
      return result;
    }

    result.amount = claimCard.amount;

    // 领取前积分
    result.pointsBefore = await page.evaluate(() => {
      const txt = (el) => (el ? (el.innerText || '').replace(/\s+/g, ' ').trim() : '');
      const el = document.querySelector('a[href*="/redeem"] p.text-pageHeader');
      return el ? txt(el) : null;
    }).then((v) => Number(String(v ?? '').replace(/[^\d]/g, '')) || null);

    log.info(`发现可领取积分：${claimCard.amount ?? '未知'}，尝试领取…`);

    // 打开领取面板
    await page.evaluate(() => {
      const txt = (el) => (el ? (el.innerText || '').replace(/\s+/g, ' ').trim() : '');
      const card = [...document.querySelectorAll('button')].find((b) => /可领取/.test(txt(b)) && /领取/.test(txt(b)));
      card?.click();
    });
    await page.waitForTimeout(2500);

    // 点击面板中的「领取积分」
    const clicked = await page.evaluate(() => {
      const txt = (el) => (el ? (el.innerText || '').replace(/\s+/g, ' ').trim() : '');
      const cands = [...document.querySelectorAll('button, a')]
        .filter((b) => /领取积分|立即领取|领取$/.test(txt(b)) && !/可领取/.test(txt(b)));
      if (!cands.length) return null;
      cands[0].click();
      return txt(cands[0]);
    });

    if (!clicked) {
      result.message = '未找到「领取积分」按钮。';
      log.warn(result.message);
      return result;
    }
    log.step(`点击：「${clicked}」`);
    await page.waitForTimeout(4500);

    // 校验一：页面是否提示领取成功
    const successHint = await page.evaluate(() => /已成功领取|领取成功/.test(document.body.innerText || '')).catch(() => false);

    // 校验二：可用积分是否增加
    result.pointsAfter = await dashboardPoints(page);
    const gained = (result.pointsBefore != null && result.pointsAfter != null)
      ? result.pointsAfter - result.pointsBefore : null;

    // 校验三：可领取卡片是否消失
    const stillThere = await page.evaluate(() => {
      const txt = (el) => (el ? (el.innerText || '').replace(/\s+/g, ' ').trim() : '');
      return [...document.querySelectorAll('button')].some((b) => /可领取/.test(txt(b)) && /领取/.test(txt(b)));
    }).catch(() => true);

    result.claimed = successHint || (gained != null && gained > 0) || !stillThere;
    if (result.claimed) {
      result.message = gained > 0
        ? `已领取积分 +${gained}（当前 ${result.pointsAfter}）`
        : `已领取 ${claimCard.amount ?? ''} 积分`;
      log.success(result.message);
    } else {
      result.message = '已点击领取，但未检测到积分变化，可能稍后到账。';
      log.warn(result.message);
    }
    return result;
  } catch (err) {
    result.message = `领取积分出错：${err.message}`;
    log.warn(result.message);
    return result;
  }
}

/**
 * 「移动应用签到」检测
 *
 * 实测结论（2026-09）：
 *   该任务必须在手机上的必应 App 内签到才会被记录，网页端（含移动端 UA 模拟）
 *   只有一张「移动应用 签到: x/1」的状态卡片，页面内不存在任何可触发签到的端点，
 *   唯一的链接是 App 下载地址 https://bingapp.microsoft.com/bing。
 *   因此这里只做「准确检测 + 明确提示」，不伪造完成动作。
 */
export async function checkMobileApp(page, cfg) {
  const result = { applicable: true, done: null, total: null, remaining: null, canAutoDo: false, message: '' };
  try {
    await page.goto(DASHBOARD, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);

    const card = await page.evaluate(() => {
      const txt = (el) => (el ? (el.innerText || '').replace(/\s+/g, ' ').trim() : '');
      const btn = [...document.querySelectorAll('#streaks button, button')]
        .find((b) => /移动应用|必应应用/.test(txt(b)) && /签到|已完成/.test(txt(b)));
      if (!btn) return null;
      const t = txt(btn);
      const m = t.match(/(\d+)\s*\/\s*(\d+)/);
      return { text: t, done: m ? Number(m[1]) : null, total: m ? Number(m[2]) : null };
    });

    if (!card) {
      result.applicable = false;
      result.message = '当前账号没有「移动应用签到」任务（或页面结构已变化）。';
      log.info('移动应用签到：未找到该任务，跳过。');
      return result;
    }

    result.done = card.done;
    result.total = card.total;
    result.remaining = card.done != null && card.total != null ? Math.max(0, card.total - card.done) : null;

    if (result.remaining === 0) {
      result.message = '今日移动应用签到已完成。';
      log.success(`移动应用签到：已完成（${card.done}/${card.total}）。`);
    } else {
      result.message =
        '今日移动应用签到未完成。该任务只能在手机上的「必应」App 内签到，网页端无法自动完成。' +
        '如需拿这 5 分，请用手机打开必应 App 完成一次签到；其余任务本工具已自动处理。';
      log.warn(`移动应用签到：未完成（${card.done}/${card.total}）—— 必须在手机必应 App 内签到，网页端无法自动完成。`);
      log.info('  下载/打开入口：https://bingapp.microsoft.com/bing');
    }
    return result;
  } catch (err) {
    result.message = '检查移动应用签到失败：' + err.message;
    log.warn(result.message);
    return result;
  }
}

/** 访问积分赚取页，触发服务端任务刷新（略带浏览行为） */
export async function visitEarn(page) {
  try {
    await page.goto(EARN, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(rand(2500, 5000));
    await page.mouse.wheel(0, rand(400, 1000)).catch(() => {});
    await page.waitForTimeout(rand(1000, 2500));
    log.success('已刷新积分赚取页。');
    return true;
  } catch (err) {
    log.warn('访问积分赚取页失败：', err.message);
    return false;
  }
}

export { analyzeQuota };
