/**
 * 搜索关键词生成：模拟真人搜索习惯
 * 使用「主题 + 修饰词」组合，并带时效性词面
 */
import fs from 'node:fs';
import { accountQueriesFile } from './paths.js';

const TOPICS = [
  '人工智能', '新能源汽车', '量子计算', '航天发射', '芯片制造', '机器学习', '大语言模型',
  'Python 编程', '前端开发', '数据库优化', '云计算', '网络安全', '开源项目', '算法面试',
  '健康饮食', '减脂食谱', '居家健身', '睡眠质量', '颈椎保养', '马拉松训练',
  '天气预报', '旅行攻略', '露营装备', '自驾路线', '民宿推荐', '签证办理',
  '电影推荐', '纪录片', '古典音乐', '摄影技巧', '咖啡豆', '家常菜做法',
  '股票基金', '个人理财', '房贷利率', '税务申报', '副业推荐',
  '考研复习', '英语口语', '编程入门', '在线课程', '读书笔记',
  '新能源汽车保养', '手机选购', '笔记本推荐', '智能家居', '耳机对比',
];

const PATTERNS = [
  '{t}',
  '{t} 是什么',
  '{t} 怎么入门',
  '{t} 最新进展',
  '{t} 2026',
  '{t} 对比 推荐',
  '{t} 常见问题',
  '{t} 教程',
  '{t} 排行榜',
  '{t} 值得买吗',
  '{t} 原理 详解',
  '{t} 有什么好处',
];

const NEWS_FALLBACK = [
  '今日热点新闻', '国内新闻头条', '科技新闻', '财经要闻', '体育赛事结果',
  '国际时事', '天气预报一周', '股市行情', '电影票房排行', '新车上市',
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** 读取账号自定义词库文件（data/accounts/<id>/queries.txt），回退到全局 data/queries.txt */
function loadCustomFile(accountId) {
  const candidates = [];
  if (accountId) candidates.push(accountQueriesFile(accountId));
  candidates.push(new URL('../data/queries.txt', import.meta.url));

  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const lines = fs.readFileSync(file, 'utf8')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#'));
        if (lines.length) return lines;
      }
    } catch { /* 继续尝试下一个 */ }
  }
  return null;
}

/**
 * 生成 n 个不重复的搜索词
 * @param {number} n
 * @param {object} opts { querySource, customQueries, accountId }
 */
export function generateQueries(n, opts = {}) {
  const { querySource = 'mixed', customQueries = [], accountId = null } = opts;
  const out = [];
  const seen = new Set();

  if (querySource === 'custom') {
    const pool = customQueries.length ? customQueries : (loadCustomFile(accountId) || []);
    for (let i = 0; i < n; i++) {
      const base = pool.length ? pool[i % pool.length] : `搜索 ${i + 1}`;
      let q = base;
      let guard = 0;
      while (seen.has(q) && guard++ < 20) q = `${base} ${pick(['教程', '推荐', '2026', '最新', '方法'])}`;
      seen.add(q);
      out.push(q);
    }
    return out;
  }

  if (querySource === 'news') {
    for (let i = 0; i < n; i++) out.push(pick(NEWS_FALLBACK));
    return [...new Set(out)].slice(0, n);
  }

  let guard = 0;
  while (out.length < n && guard++ < n * 30) {
    const topic = pick(TOPICS);
    let q = pick(PATTERNS).replace('{t}', topic);
    if (seen.has(q)) continue;
    seen.add(q);
    out.push(q);
  }
  // 兜底补足
  let i = 0;
  while (out.length < n) out.push(`热门话题 ${++i}`);
  return out;
}

/** 中文数字转阿拉伯，用于解析 "搜索: 3/5" 这类文本（本地化容错） */
export function parseProgress(text) {
  const m = String(text || '').match(/(\d+)\s*\/\s*(\d+)/);
  if (!m) return null;
  return { current: Number(m[1]), total: Number(m[2]) };
}
