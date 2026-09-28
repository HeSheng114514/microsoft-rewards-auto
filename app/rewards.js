/**
 * Microsoft Rewards 页面解析：账户信息、积分、额度、每日任务
 *
 * 页面结构（2026-09 实测，rewards.bing.com/dashboard）：
 *   a[href*="/redeem"] p.text-pageHeader   -> 可用积分
 *   #dailyset                              -> 每日活动（卡片内含 bing.com/search 链接）
 *   #streaks                               -> 连续打卡进度（[role=progressbar] aria-label/valuenow/valuemax）
 *   #offers                                -> 福利/月度奖励
 *   cn.bing.com 页头 #id_rh_w / #rh_rwm    -> 实时积分（旧版为 #id_rc）
 */
import { log } from './logger.js';

const DASHBOARD = 'https://rewards.bing.com/dashboard';
const EARN = 'https://rewards.bing.com/earn';

function toNumSafe(v) {
  const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * 读取 Rewards 仪表盘上的「可用积分」——这是**账号权威值**。
 *
 * 为什么不以必应页头为准：实测发现同一个浏览器配置里，必应页头的登录会话
 * 可能与 Rewards 的账号不一致（页头会停在另一个账号上）。Rewards 侧才是按
 * 账号隔离、可用于判断额度的数据源。
 *
 * @returns {Promise<number|null>}
 */
export async function dashboardPoints(page) {
  try {
    await page.goto(DASHBOARD, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3500);
    const txt = await page.evaluate(() => {
      const clean = (el) => (el ? (el.innerText || '').replace(/\s+/g, ' ').trim() : '');
      const el = document.querySelector('a[href*="/redeem"] p.text-pageHeader');
      if (el) return clean(el);
      const cand = [...document.querySelectorAll('p')]
        .find((p) => /^[\d,]+$/.test(clean(p)) && String(p.className).includes('pageHeader'));
      return cand ? clean(cand) : null;
    });
    if (txt == null) return null;
    const n = Number(String(txt).replace(/[^\d]/g, ''));
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** 读取 Rewards 页面上显示的账号名 */
export async function dashboardAccountName(page) {
  try {
    return await page.evaluate(() => {
      const el = document.querySelector('p.pii, p[class*="pii"]');
      const t = (el?.textContent || '').replace(/\s+/g, ' ').trim();
      return t || null;
    });
  } catch {
    return null;
  }
}

/**
 * 校验必应页头会话是否与 Rewards 账号一致。
 * 不一致意味着「必应会话还停在别的账号上」，此时按页头积分判断会完全跑偏。
 */
export async function checkSessionMatch(page, dashboardValue) {
  const headerValue = await bingPoints(page);
  const mismatch = homeValueMismatch(headerValue, dashboardValue);
  return { headerValue, dashboardValue, match: !mismatch };
}

/**
 * 两个读数是否互相矛盾（据此判断「必应会话停在别的账号」）。
 *
 * 阈值不能太小：同账号的两个界面入账有几分钟延迟，积分不同步是常态
 * （实测曾出现页头 152 / 仪表盘 155）。因此采用「绝对 + 相对」双阈值。
 */
export function homeValueMismatch(headerValue, dashboardValue) {
  if (headerValue == null || dashboardValue == null) return false;
  const diff = Math.abs(headerValue - dashboardValue);
  const base = Math.max(headerValue, dashboardValue);
  // 差 15 分以内且相对差 < 20% 视为同账号
  if (diff <= 15) return false;
  if (base > 0 && diff / base < 0.2) return false;
  return true;
}

/**
 * 读取 Bing 页头积分。
 * 注意：该值反映的是**必应会话**账号，可能与 Rewards 账号不同，
 * 因此只用于「同一次运行内的相对变化」，绝对值必须以仪表盘为准。
 */
export async function bingPoints(page) {
  try {
    const raw = await page.evaluate(() => {
      const parse = (s) => {
        const m = String(s || '').replace(/[\s,]/g, '').match(/\d{2,7}/);
        return m ? Number(m[0]) : null;
      };
      const sels = ['#id_rh_w', '#rh_rwm', '.points-container', '#id_rc', '[class*="points-container"]'];
      const found = [];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (!el) continue;
        const v = parse(el.textContent);
        if (v != null) found.push(v);
      }
      if (found.length) return Math.max(...found);
      // 兜底：在页头区域内找纯数字文本
      const header = document.querySelector('#id_h, #rh_rwm, header');
      if (header) {
        const cand = [...header.querySelectorAll('a, span, div')]
          .map((e) => ({ t: (e.textContent || '').trim(), n: e.children.length }))
          .filter((x) => x.n === 0 && /^\d{3,7}$/.test(x.t.replace(/[,\s]/g, '')));
        if (cand.length) return Number(cand[0].t.replace(/[,\s]/g, ''));
      }
      return null;
    });
    return raw;
  } catch {
    return null;
  }
}

/**
 * 抓取 Rewards 仪表盘全量信息
 * @returns {Promise<object>}
 */
export async function inspect(page) {
  await page.goto(DASHBOARD, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // 新版是 React 流式渲染，需要等卡片挂载完成
  await page.waitForFunction(
    () => !!document.querySelector('#streaks') || !!document.querySelector('#dailyset'),
    { timeout: 30000 },
  ).catch(() => {});
  await page.waitForTimeout(2500);

  const data = await page.evaluate(() => {
    const txt = (el) => (el ? (el.innerText || '').replace(/\s+/g, ' ').trim() : '');

    /*
     * 带分隔符的文本提取。
     *
     * 为什么需要它：React Aria 的 DisclosurePanel 会放一个隐藏的测量层，
     * 导致这些节点的 innerText 直接返回空字符串，而 textContent 是完整的。
     * 直接拼接又会把相邻元素粘在一起（「活动精彩的体育」），所以逐节点插入空格。
     */
    const textWithSpaces = (root) => {
      if (!root) return '';
      const buf = [];
      const walk = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          const t = (node.nodeValue || '').trim();
          if (t) buf.push(t);
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        // 跳过脚本/样式等
        const tag = node.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return;
        for (const child of node.childNodes) walk(child);
        buf.push(' ');
      };
      walk(root);
      return buf.join('').replace(/\s+/g, ' ').trim();
    };

    /** 取元素的可见文本，innerText 为空时回退到 textContent（带分隔） */
    const textOf = (el) => {
      const t = txt(el);
      if (t) return t;
      return textWithSpaces(el);
    };

    // ---- 可用积分 ----
    let points = null;
    const redeemLink = document.querySelector('a[href*="/redeem"] p.text-pageHeader');
    if (redeemLink) points = txt(redeemLink);
    if (!points) {
      const cand = [...document.querySelectorAll('p')].find((p) => /^[\d,]+$/.test(txt(p)) && p.className.includes('pageHeader'));
      if (cand) points = txt(cand);
    }

    // ---- 可领取积分 ----
    let claimable = null;
    const claimCard = [...document.querySelectorAll('button')].find((b) => /可领取/.test(txt(b)) && /领取/.test(txt(b)));
    if (claimCard) claimable = txt(claimCard);

    // ---- 连续打卡 / 额度 ----
    const streakCards = [...document.querySelectorAll('#streaks button')].map((b) => {
      const bar = b.querySelector('[role="progressbar"]');
      const spans = [...b.querySelectorAll('span')].map(txt).filter(Boolean);
      const progressText = spans.find((s) => /\d+\s*\/\s*\d+/.test(s)) || null;
      return {
        title: txt(b.querySelector('p')),
        progressText,
        now: bar?.getAttribute('aria-valuenow') ?? null,
        max: bar?.getAttribute('aria-valuemax') ?? null,
        points: num(spans.find((s) => /^\d+$/.test(s))),
        fullText: txt(b),
      };
    });

    function num(v) {
      const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''));
      return Number.isFinite(n) ? n : null;
    }

    // ---- 任务采集（通用）：每日活动 + 新手引导「开始使用 Rewards」等 ----
    const PENDING_RE = /待领取|未完成|去完成|开始|进行中|未领取/;

    /** 根据标题/来源推断任务类型 */
    const categoryOf = (title, origin) => {
      if (/设定奖励目标|奖励目标/.test(title)) return 'reward-goal';
      if (origin === 'dailyset') return 'search';
      if (/测验|问答|小测|quiz/i.test(title)) return 'quiz';
      if (/浏览|查看|访问|赚取页面|了解/.test(title)) return 'visit';
      return 'visit';
    };

    /**
     * 从一段容器里提取任务卡。
     *
     * 注意：新版卡片里 `<a>` 自身的 innerText 可能是**空的**（文字与徽标在同级的
     * 外层 div 中），因此文本要取「最近的、有实质文字」的祖先节点。
     */
    /** 从候选段落里挑出「任务标题」：优先含标题样式的，其次第一个非数字段落 */
    const titleOf = (el) => {
      const cands = [...el.querySelectorAll('p, h3, h4, span')]
        .map((p) => ({ t: textOf(p), cls: String(p.className || '') }))
        .filter((x) => x.t && x.t.length >= 3 && !/^[\d,+\s\/]+$/.test(x.t));
      if (!cands.length) return '';
      const strong = cands.find((x) => /Strong|strong|itemHeader|sectionHeader/.test(x.cls));
      return (strong || cands[0]).t.slice(0, 60);
    };

    const cardsFrom = (root, origin) => {
      const out = [];
      for (const el of root.querySelectorAll('a[href], button')) {
        // 承载卡片文字的最小祖先：从元素自身向上，直到文本足够长
        let card = el;
        let t = textOf(el);
        for (let i = 0; i < 4 && t.length < 12 && card.parentElement; i++) {
          card = card.parentElement;
          t = textOf(card);
        }
        if (!t || t.length < 4) continue;

        const hasPoints = /\+\s*\d+/.test(t);
        const hasDone = /已完成|已领取/.test(t);
        const hasPending = PENDING_RE.test(t);
        const pm = t.match(/(\d+)\s*\/\s*(\d+)/);
        const progressComplete = pm ? Number(pm[1]) >= Number(pm[2]) : false;

        /*
         * 排除「区块标题行」：
         * 标题行没有 href、没有点数，且整段只有名称+进度（如「开始使用 Rewards … 2/7 个任务」）
         */
        if (!el.href && !hasPoints && !hasDone && !hasPending) continue;

        const title = titleOf(card) || titleOf(el);
        // 标题太短或就是区块名本身 -> 视为标题行，跳过
        if (!title || /^开始使用 Rewards$/.test(title) || /^到期日期/.test(title) || title.length < 3) continue;

        out.push({
          origin,
          title,
          text: t.slice(0, 200),
          href: el.href || null,
          tag: el.tagName,
          points: num((t.match(/\+\s*(\d+)/) || [])[1]),
          progress: pm ? `${pm[1]}/${pm[2]}` : null,
          progressDone: pm ? Number(pm[1]) : null,
          progressTotal: pm ? Number(pm[2]) : null,
          done: hasDone || progressComplete,
          kind: categoryOf(title, origin),
        });
      }
      return out;
    };

    const taskMap = new Map();
    const pushTasks = (list) => {
      for (const t of list) {
        const key = `${t.origin}|${t.title}|${t.href || ''}`;
        if (!taskMap.has(key)) taskMap.set(key, t);
      }
    };

    // 1) 每日活动
    const dailyset = document.querySelector('#dailyset');
    if (dailyset) pushTasks(cardsFrom(dailyset, 'dailyset'));

    // 2) 新手引导「开始使用 Rewards」——该区块没有 id，靠标题定位
    const onboardingHeading = [...document.querySelectorAll('h1,h2,h3,h4,p,span')]
      .find((el) => /^开始使用 Rewards$/.test(txt(el)));
    if (onboardingHeading) {
      let box = onboardingHeading;
      for (let i = 0; i < 8 && box.parentElement; i++) {
        box = box.parentElement;
        if (/个任务/.test(textOf(box))) break;
      }
      pushTasks(cardsFrom(box, 'onboarding'));
    }

    // 3) 积分赚取页可能嵌在仪表盘里的其他活动区块（有 id 的更稳）
    for (const sel of ['#moreactivities', '#quests']) {
      const el = document.querySelector(sel);
      if (el) pushTasks(cardsFrom(el, 'earn'));
    }

    const tasks = [...taskMap.values()];
    // 保持兼容：dailyTasks 仍指每日活动的搜索任务
    const dailyTasks = tasks.filter((t) => t.origin === 'dailyset');

    // ---- 福利区（可点击的 Offer 卡） ----
    const offers = [...document.querySelectorAll('#offers a')].map((a) => ({
      title: txt(a).slice(0, 80),
      href: a.href || null,
    })).slice(0, 12);

    // ---- 等级 ----
    const levelBadge = txt(document.querySelector('p[class*="rewardsSilverBadgeBg"], p[class*="BadgeBg"]'));
    const continueBtn = [...document.querySelectorAll('button, a')].find((b) => /继续|领取积分/.test(txt(b)));
    const claimCta = [...document.querySelectorAll('a, button')]
      .map((e) => ({ text: txt(e), href: e.href || null, tag: e.tagName }))
      .filter((e) => /领取积分|领取$|立即领取|claim/i.test(e.text))
      .slice(0, 5);

    return {
      url: location.href,
      signedIn: !!(points || levelBadge) && !/登录以赚取奖励/.test(document.body.innerText),
      points,
      claimable,
      level: levelBadge || null,
      streakCards,
      tasks,
      dailyTasks,
      offers,
      claimCta,
      rawPoints: num(points),
    };
  });

  data.fetchedAt = new Date().toISOString();
  return data;
}

/**
 * 只采集任务（不重复抓其他信息时可用）
 * @returns {Promise<Array>} [{origin,title,href,points,progress,done,kind}]
 */
export async function collectTasks(page) {
  const info = await inspect(page);
  return info.tasks || [];
}

/**
 * 分析：得出今天还需搜索多少次
 * 依据：
 *   1) 打卡卡片的 "搜索: x/y"（y>1 时即为搜索额度）
 *   2) 无明确额度时返回 null，交由「积分不再增长即停」逻辑处理
 */
export function analyzeQuota(info) {
  const result = { searchNeed: null, searchTotal: null, searchDone: null, items: [] };
  for (const c of info.streakCards || []) {
    const m = String(c.progressText || '').match(/(\d+)\s*\/\s*(\d+)/);
    if (!m) continue;
    const done = Number(m[1]);
    const total = Number(m[2]);
    const label = /搜索/.test(c.progressText || '') ? 'search'
      : /活动/.test(c.progressText || '') ? 'activity'
        : /签到/.test(c.progressText || '') ? 'checkin'
          : /分钟/.test(c.progressText || '') ? 'minutes' : 'other';
    const item = { kind: label, label: c.title, done, total, remaining: Math.max(0, total - done), text: c.progressText };
    result.items.push(item);
    if (label === 'search' && result.searchNeed === null) {
      result.searchTotal = total;
      result.searchDone = done;
      result.searchNeed = Math.max(0, total - done);
    }
  }
  return result;
}

/** 打开积分赚取页，触发任务列表刷新，并返回未完成的搜索类任务 */
export async function fetchEarnTasks(page) {
  await page.goto(EARN, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  const tasks = await page.evaluate(() => {
    const txt = (el) => (el ? (el.innerText || '').replace(/\s+/g, ' ').trim() : '');
    const out = [];
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.href || '';
      if (!/bing\.com\/search/i.test(href)) continue;
      const t = txt(a);
      if (!t) continue;
      out.push({ title: txt(a.querySelector('p, span')), href, done: /已完成|已领取/.test(t), text: t.slice(0, 160) });
    }
    // 同一个链接可能重复出现，去重
    const seen = new Set();
    return out.filter((t) => (seen.has(t.href) ? false : (seen.add(t.href), true)));
  });
  return tasks;
}

export { DASHBOARD, EARN };
