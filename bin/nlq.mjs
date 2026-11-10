#!/usr/bin/env node
/**
 * nlq.mjs — 把「结构化意图」编译成 Polymarket Gamma `/events/keyset` 查询参数。
 *
 * 设计原则
 * --------
 * 1. 语义解析交给 DSH 模型（读 SKILL.md 的映射规则），本脚本**不做 NLU**；
 * 2. 本脚本只做确定性工作：单位换算、时间换算、参数校验、URL 渲染、游标翻页；
 * 3. 零依赖，Node.js ≥ 18；`build`/`check`/`schema` 完全离线，
 *    `fetch`/`tag-id`/`tags`/`doctor` 需要网络（Polymarket 在国内一般需要代理）。
 *
 * 用法
 * ----
 *   node nlq.mjs schema
 *   node nlq.mjs build --intent '{"keyword":"OpenAI","closed":false,"volume":{"min":"100万"},"limit":20}'
 *   node nlq.mjs check --params '{"closed":"any","tag_id":[2],"exclude_tag_id":[2]}'
 *   node nlq.mjs tag-id --slug geopolitics
 *   node nlq.mjs fetch --intent '{"tags":["politics"],"closed":false,"limit":5}' --max-pages 2
 *   node nlq.mjs doctor
 */

import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const BASE_URL = 'https://gamma-api.polymarket.com';
export const PATH = '/events/keyset';
export const DEFAULT_PROXY = 'http://127.0.0.1:20220';
export const DEFAULT_TZ = 'Asia/Shanghai';

// ---------------------------------------------------------------------------
// 1. 参数登记表（唯一事实来源：docs.polymarket.com /events/keyset 的 OpenAPI）
// ---------------------------------------------------------------------------
export const PARAM_SPEC = {
  limit: { kind: 'int', min: 1, max: 100, default: 20, doc: '每页条数，最大 100，默认 20' },
  order: { kind: 'str', doc: '排序字段，逗号分隔的 JSON 字段名，如 volume / endDate / createdAt' },
  ascending: { kind: 'bool', doc: '排序方向，仅在 order 存在时生效，默认 true' },
  after_cursor: { kind: 'str', doc: '上一页返回的 next_cursor，原样回传，禁止自己构造' },
  offset: { kind: 'forbidden', doc: 'keyset 端点拒绝 offset，传了直接 422' },
  id: { kind: 'int_list' },
  slug: { kind: 'str_list' },
  closed: { kind: 'bool_or_any', doc: 'true=已结算, false=未结算, any=两者都要; 非法值 422' },
  live: { kind: 'bool' },
  featured: { kind: 'bool' },
  cyom: { kind: 'bool' },
  title_search: { kind: 'str', doc: '标题全文搜索（只搜 title，不搜 description）' },
  liquidity_min: { kind: 'num' },
  liquidity_max: { kind: 'num' },
  volume_min: { kind: 'num', doc: '事件累计成交量（不是 24h 成交量）' },
  volume_max: { kind: 'num' },
  start_date_min: { kind: 'datetime', doc: '事件 startDate 下界' },
  start_date_max: { kind: 'datetime' },
  end_date_min: { kind: 'datetime', doc: '事件 endDate 下界（= 最早结束时间）' },
  end_date_max: { kind: 'datetime' },
  start_time_min: { kind: 'datetime' },
  start_time_max: { kind: 'datetime' },
  tag_id: { kind: 'int_list' },
  tag_slug: { kind: 'str', doc: '单个标签 slug；多标签请用 tag_id' },
  exclude_tag_id: { kind: 'int_list', doc: '排除的标签 id，必须与 tag_id 不相交' },
  related_tags: { kind: 'bool', doc: '是否连带相关/子标签' },
  tag_match: { kind: 'str' },
  series_id: { kind: 'int_list' },
  game_id: { kind: 'int_list' },
  event_date: { kind: 'datetime' },
  event_week: { kind: 'int' },
  featured_order: { kind: 'bool' },
  recurrence: { kind: 'str' },
  created_by: { kind: 'str_list' },
  parent_event_id: { kind: 'int' },
  include_children: { kind: 'bool' },
  partner_slug: { kind: 'str' },
  include_chat: { kind: 'bool' },
  include_template: { kind: 'bool' },
  include_best_lines: { kind: 'bool' },
  locale: { kind: 'str' },
};

/** 已知可排序字段（文档只说"JSON 字段名"，非法字段 422） */
export const ORDER_FIELDS_SAFE = new Set([
  'id', 'volume', 'liquidity', 'startDate', 'endDate', 'createdAt',
  'updatedAt', 'closedTime', 'volume24hr', 'competitive', 'commentCount',
]);

/** 意图槽位（DSH 模型填这个 JSON，脚本编译为参数） */
const SLOT_TO_PARAM = {
  keyword: 'title_search',
  start_after: 'start_date_min',
  start_before: 'start_date_max',
  end_after: 'end_date_min',
  end_before: 'end_date_max',
  event_date: 'event_date',
  live: 'live',
  featured: 'featured',
  cyom: 'cyom',
  related_tags: 'related_tags',
};
export const SLOT_KEYS = new Set([
  ...Object.keys(SLOT_TO_PARAM),
  'tags', 'tag_ids', 'exclude_tags', 'exclude_tag_ids',
  'closed', 'volume', 'liquidity', 'order', 'ascending', 'limit',
  'after_cursor', 'series_id', 'game_id', 'parent_event_id',
  'include_children', 'partner_slug', 'include_chat', 'include_template',
  'include_best_lines', 'locale', 'recurrence', 'tag_match', 'created_by',
  'event_week', 'featured_order', 'slug', 'id',
  'unsupported', 'notes',
]);
export const MANAGED = new Set([
  'keyword', 'tags', 'tag_ids', 'exclude_tags', 'exclude_tag_ids',
  'closed', 'volume', 'liquidity', 'order', 'ascending', 'limit',
  'start_after', 'start_before', 'end_after', 'end_before',
  'event_date', 'live', 'featured', 'cyom', 'related_tags',
]);

/** 已验证的标签 id（来自真实事件 payload；其余靠 `nlq tag-id` 在线解析） */
export const KNOWN_TAG_IDS = {
  politics: 2,
  elections: 144,
  'united-states': 165,
  'us-presidential-election': 1101,
  'world-elections': 101206,
  geopolitics: 100265,
};

/** 常见中文品类 → 候选 slug（**只是候选**，使用前建议 `nlq tag-id --slug X` 验证） */
export const CATEGORY_HINTS = {
  体育: 'sports', 体育赛事: 'sports', 足球: 'soccer', 篮球: 'nba',
  政治: 'politics', 选举: 'elections', 美国大选: 'us-presidential-election',
  加密: 'crypto', 加密货币: 'crypto', 比特币: 'bitcoin', 以太坊: 'ethereum',
  经济: 'economy', 金融: 'business', 科技: 'tech', 人工智能: 'ai',
  地缘政治: 'geopolitics', 中东: 'middle-east', 俄乌: 'ukraine',
  文化: 'pop-culture', 娱乐: 'entertainment', 科学: 'science',
  气候: 'climate', 健康: 'health',
};

// ---------------------------------------------------------------------------
// 2. 单位 / 时间工具
// ---------------------------------------------------------------------------
const AMOUNT_RE =
  /^\s*[$¥￥]?\s*([0-9]+(?:\.[0-9]+)?)\s*(亿|萬|万|百万|千万|千|thousand|million|billion|k|K|w|W|m|M|b|B)?\s*(?:美元|美金|usd|usdc|\$)?\s*$/i;
const AMOUNT_UNITS = {
  千: 1e3, k: 1e3, thousand: 1e3,
  万: 1e4, 萬: 1e4, w: 1e4,
  十万: 1e5, 百万: 1e6, m: 1e6, million: 1e6,
  千万: 1e7, 亿: 1e8, b: 1e9, billion: 1e9,
};

/** '100万' / '$1.5M' / '10w' / 250000 → number。失败抛 Error。 */
export function parseAmount(value) {
  if (typeof value === 'boolean') throw new Error('金额不能是布尔值');
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`看不懂的金额表达：${value}`);
    if (value < 0) throw new Error('金额不能为负');
    return value;
  }
  const s = String(value).trim();
  const m = AMOUNT_RE.exec(s);
  if (!m) {
    throw new Error(`看不懂的金额表达：${JSON.stringify(value)}（支持 1.5M / 100万 / 10w / 250000）`);
  }
  const num = Number(m[1]);
  const unit = (m[2] || '').toLowerCase();
  const mult = unit ? AMOUNT_UNITS[unit] : undefined;
  if (unit && mult === undefined) throw new Error(`不认识的金额单位：${JSON.stringify(value)}`);
  const out = num * (mult ?? 1);
  if (out < 0) throw new Error('金额不能为负');
  return out;
}

const DTF_CACHE = new Map();
function dtf(tz) {
  if (!DTF_CACHE.has(tz)) {
    DTF_CACHE.set(tz, new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }));
  }
  return DTF_CACHE.get(tz);
}

/** 该时区在某一时刻的「本地墙钟」分量 */
export function tzParts(date, tz) {
  const parts = {};
  for (const p of dtf(tz).formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  // en-CA 的 hour 在 24 点时可能给 24，归一到 0
  if (parts.hour === 24) parts.hour = 0;
  return parts;
}

/** 时区偏移（毫秒，东正西负） */
function tzOffsetMs(date, tz) {
  const p = tzParts(date, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
}

/** 墙钟（本地时区）→ UTC Date，处理 DST */
export function wallToUtc(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let off = tzOffsetMs(new Date(guess), tz);
  off = tzOffsetMs(new Date(guess - off), tz);
  return new Date(guess - off);
}

/** 秒级 ISO（UTC，Z 结尾） */
export function isoSeconds(date) {
  return new Date(date).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function parseNow(s, tz) {
  if (!s || ['now', '今天', ''].includes(String(s).trim().toLowerCase())) return new Date();
  return parseIsoOrWall(String(s), tz);
}

function parseIsoOrWall(text, tz) {
  const s = String(text).trim();
  if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(s)) {
    const dt = new Date(s);
    if (Number.isNaN(dt.getTime())) throw new Error(`看不懂的时间表达：${JSON.stringify(text)}`);
    return dt;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (!m) throw new Error(`看不懂的时间表达：${JSON.stringify(text)}`);
  return wallToUtc(+m[1], +m[2], +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), tz);
}

const REL_RE = /^rel:\s*([+-]?\d+)\s*(h|d|w|mo|y|min)$/i;
const DAY_MS = 86400000;

/** 把相对/绝对时间表达解析成 UTC 秒级 ISO 字符串 */
export function resolveTime(expr, now, tz) {
  if (typeof expr !== 'string') throw new Error(`时间需要字符串，收到 ${typeof expr}`);
  const s = expr.trim();
  const low = s.toLowerCase();
  const p = tzParts(now, tz);
  const day0 = wallToUtc(p.year, p.month, p.day, 0, 0, 0, tz);
  const plusDays = (n) => new Date(day0.getTime() + n * DAY_MS);
  const at = (dt) => isoSeconds(dt);

  if (['now', '现在'].includes(low)) return isoSeconds(now);
  if (['today_start', '今天开始', '今天0点'].includes(low)) return at(day0);
  if (['today_end', '今天结束', '今天23:59'].includes(low)) return at(new Date(plusDays(1).getTime() - 1000));
  if (['tomorrow_start', '明天开始'].includes(low)) return at(plusDays(1));
  if (['tomorrow_end', '明天结束'].includes(low)) return at(new Date(plusDays(2).getTime() - 1000));
  if (['week_start', '本周开始'].includes(low)) {
    const wd = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay(); // 0=Sun
    return at(plusDays(-((wd + 6) % 7)));
  }
  if (['week_end', '本周结束'].includes(low)) {
    const wd = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
    return at(new Date(plusDays(7 - ((wd + 6) % 7)).getTime() - 1000));
  }
  if (['month_start', '本月初'].includes(low)) return at(wallToUtc(p.year, p.month, 1, 0, 0, 0, tz));
  if (['month_end', '本月底'].includes(low)) {
    const nxt = p.month === 12 ? wallToUtc(p.year + 1, 1, 1, 0, 0, 0, tz) : wallToUtc(p.year, p.month + 1, 1, 0, 0, 0, tz);
    return at(new Date(nxt.getTime() - 1000));
  }
  if (['year_start', '今年初'].includes(low)) return at(wallToUtc(p.year, 1, 1, 0, 0, 0, tz));
  if (['year_end', '今年底'].includes(low)) return at(new Date(wallToUtc(p.year + 1, 1, 1, 0, 0, 0, tz).getTime() - 1000));

  const m = REL_RE.exec(s);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const ms = { min: 60000, h: 3600000, d: DAY_MS, w: 7 * DAY_MS, mo: 30 * DAY_MS, y: 365 * DAY_MS }[unit];
    return isoSeconds(new Date(now.getTime() + n * ms));
  }

  if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(s) || /^\d{4}-\d{2}-\d{2}/.test(s)) {
    const dt = parseIsoOrWall(s, tz);
    if (!Number.isNaN(dt.getTime())) return isoSeconds(dt);
  }
  throw new Error(
    `看不懂的时间表达：${JSON.stringify(expr)}；用 ISO（2026-11-01T00:00:00Z）` +
    ` 或令牌 now/today_start/today_end/week_start/week_end/month_end/year_end` +
    ` 或 rel:-7d / rel:+3h / rel:-2mo / rel:+1y`,
  );
}

// ---------------------------------------------------------------------------
// 3. 参数校验 / 归一化
// ---------------------------------------------------------------------------
function coerceBool(v, name) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string' && ['true', 'false'].includes(v.toLowerCase())) return v.toLowerCase() === 'true';
  throw new Error(`${name} 需要布尔值（true/false），收到 ${JSON.stringify(v)}`);
}

function coerceInt(v, name) {
  if (typeof v === 'boolean') throw new Error(`${name} 需要整数，收到布尔值`);
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'number' && Number.isFinite(v)) throw new Error(`${name} 需要整数，收到 ${v}`);
  if (typeof v === 'string' && /^[+-]?\d+$/.test(v.trim())) return Number(v.trim());
  throw new Error(`${name} 需要整数，收到 ${JSON.stringify(v)}`);
}

function coerceNum(v, name) {
  if (typeof v === 'boolean') throw new Error(`${name} 需要数字，收到布尔值`);
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    try { return parseAmount(v); } catch { throw new Error(`${name} 需要数字，收到 ${JSON.stringify(v)}`); }
  }
  throw new Error(`${name} 需要数字，收到 ${JSON.stringify(v)}`);
}

function coerceList(v, name, itemKind) {
  if (typeof v === 'string' || typeof v === 'number') v = [v];
  if (!Array.isArray(v)) throw new Error(`${name} 需要数组，收到 ${JSON.stringify(v)}`);
  return v.map((item) => (itemKind === 'int' ? coerceInt(item, name) : String(item)));
}

/** 校验并归一化一个原生参数 dict。返回 [params, warnings]。 */
export function checkParams(raw, now = new Date(), tz = process.env.NLQ_TZ || DEFAULT_TZ) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('params 必须是 JSON 对象');
  const params = {};
  const warnings = [];

  for (const [key, val] of Object.entries(raw)) {
    if (key.startsWith('_')) continue;
    if (!Object.prototype.hasOwnProperty.call(PARAM_SPEC, key)) {
      throw new Error(`未知参数 ${JSON.stringify(key)}；/events/keyset 不支持这个字段（见 nlq schema）`);
    }
    const spec = PARAM_SPEC[key];
    const kind = spec.kind;
    if (kind === 'forbidden') {
      throw new Error(`${key} 在 keyset 端点被显式拒绝（会返回 422）；翻页请用 next_cursor → after_cursor`);
    }
    if (val === null || val === undefined) continue;

    if (kind === 'int') {
      let n = coerceInt(val, key);
      if (spec.min !== undefined && n < spec.min) {
        warnings.push(`${key}=${n} 低于允许最小值 ${spec.min}，已改为 ${spec.min}`);
        n = spec.min;
      }
      if (spec.max !== undefined && n > spec.max) {
        warnings.push(
          `${key}=${n} 超过上限 ${spec.max}，已截断为 ${spec.max}；` +
          `要更多数据请翻页（after_cursor）而不是放大 limit`,
        );
        n = spec.max;
      }
      params[key] = n;
    } else if (kind === 'num') {
      const n = coerceNum(val, key);
      if (n < 0) throw new Error(`${key} 不能为负`);
      params[key] = Number.isInteger(n) ? n : n;
    } else if (kind === 'bool') {
      params[key] = coerceBool(val, key);
    } else if (kind === 'bool_or_any') {
      if (typeof val === 'string' && val.trim().toLowerCase() === 'any') params[key] = 'any';
      else params[key] = coerceBool(val, key);
    } else if (kind === 'str') {
      const s = String(val).trim();
      if (!s) throw new Error(`${key} 不能为空字符串`);
      params[key] = s;
    } else if (kind === 'datetime') {
      params[key] = resolveTime(val, now, tz);
    } else if (kind === 'int_list') {
      params[key] = coerceList(val, key, 'int');
    } else if (kind === 'str_list') {
      params[key] = coerceList(val, key, 'str');
    } else {
      throw new Error(`未实现的参数类型 ${kind}`);
    }
  }

  if (params.order !== undefined) {
    const fields = String(params.order).split(',').map((f) => f.trim()).filter(Boolean);
    if (!fields.length) throw new Error('order 不能是空字符串');
    for (const f of fields) {
      if (!ORDER_FIELDS_SAFE.has(f)) {
        warnings.push(
          `order 字段 ${JSON.stringify(f)} 不在已知安全集 ${JSON.stringify([...ORDER_FIELDS_SAFE].sort())} 内；` +
          `非法字段上游会返回 422，--check 不拦但请确认`,
        );
      }
    }
    params.order = fields.join(',');
  }
  if (params.ascending !== undefined && params.order === undefined) {
    warnings.push('ascending 仅在传了 order 时生效（文档说明），当前没有 order，上游会忽略它');
  }
  if (params.ascending === undefined && params.order !== undefined) {
    warnings.push('未指定 ascending，上游默认 true（升序）；要降序请显式传 false');
  }

  const tagIds = new Set(params.tag_id || []);
  const exc = new Set(params.exclude_tag_id || []);
  const overlap = [...tagIds].filter((x) => exc.has(x));
  if (overlap.length) {
    throw new Error(`tag_id 与 exclude_tag_id 不能重叠（重叠 [${overlap}]），上游会 422`);
  }
  if (params.tag_slug !== undefined && params.tag_id !== undefined) {
    warnings.push('同时传了 tag_slug 和 tag_id，行为可能不确定；建议只用一个');
  }
  if (params.include_children && params.parent_event_id === undefined) {
    warnings.push('include_children 通常要配合 parent_event_id 使用');
  }

  for (const [lo, hi] of [['start_date_min', 'start_date_max'], ['end_date_min', 'end_date_max'], ['start_time_min', 'start_time_max']]) {
    if (params[lo] && params[hi] && params[lo] > params[hi]) {
      warnings.push(`${lo} 晚于 ${hi}，区间为空，结果大概率为 0 条`);
    }
  }
  if (params.volume_min !== undefined && params.volume_max !== undefined && params.volume_min > params.volume_max) {
    warnings.push('volume_min 大于 volume_max，结果大概率为 0 条');
  }
  if (params.liquidity_min !== undefined && params.liquidity_max !== undefined && params.liquidity_min > params.liquidity_max) {
    warnings.push('liquidity_min 大于 liquidity_max，结果大概率为 0 条');
  }

  return [params, warnings];
}

// ---------------------------------------------------------------------------
// 4. 意图 → 参数
// ---------------------------------------------------------------------------
function intentTagIds(slugs, kind, errors) {
  const ids = [];
  for (const raw of slugs) {
    const slug = String(raw).trim();
    if (/^\d+$/.test(slug)) { ids.push(Number(slug)); continue; }
    if (KNOWN_TAG_IDS[slug] !== undefined) { ids.push(KNOWN_TAG_IDS[slug]); continue; }
    const hint = Object.keys(CATEGORY_HINTS).find((k) => CATEGORY_HINTS[k] === slug);
    errors.push(
      `${kind} 里的标签 ${JSON.stringify(slug)} 没有已知 id` +
      (hint ? `（中文品类候选：${hint}）` : '') +
      `；先运行 \`nlq tag-id --slug ${slug}\` 解析，或改用 tag_ids 槽位直接给 id`,
    );
  }
  return ids;
}

/** 意图 JSON → {ok, errors, warnings, params, query, url, summary, unsupported} */
export function build(intent, now = new Date(), tzName = process.env.NLQ_TZ || DEFAULT_TZ) {
  if (intent === null || typeof intent !== 'object' || Array.isArray(intent)) throw new Error('intent 必须是 JSON 对象');
  const errors = [];
  const warnings = [];
  const params = {};
  const unsupported = [...(intent.unsupported || [])];
  const notes = [...(intent.notes || [])];

  const unknown = Object.keys(intent).filter((k) => !SLOT_KEYS.has(k) && !k.startsWith('_'));
  if (unknown.length) {
    throw new Error(
      `未知意图槽位 [${unknown}]；不要在 intent 里放整句自然语言，允许的槽位见 \`nlq schema\``,
    );
  }

  if (intent.keyword) params.title_search = String(intent.keyword).trim();

  const tagIds = [...(intent.tag_ids || [])];
  const tags = (intent.tags || []).map((t) => String(t).trim());
  if (tags.length && tagIds.length) errors.push('tags 与 tag_ids 只能二选一');
  if (tags.length) {
    if (tags.length === 1) {
      const slug = tags[0];
      if (/^\d+$/.test(slug)) params.tag_id = [Number(slug)];
      else if (KNOWN_TAG_IDS[slug] !== undefined) params.tag_id = [KNOWN_TAG_IDS[slug]];
      else {
        params.tag_slug = slug;
        if (Object.values(CATEGORY_HINTS).includes(slug)) {
          warnings.push(`tag_slug=${slug} 未离线校验，建议先 \`nlq tag-id --slug ${slug}\` 确认存在`);
        }
      }
    } else {
      const ids = intentTagIds(tags, 'tags', errors);
      if (ids.length) params.tag_id = ids;
    }
  } else if (tagIds.length) {
    params.tag_id = coerceList(tagIds, 'tag_ids', 'int');
  }

  const exTags = (intent.exclude_tags || []).map((t) => String(t).trim());
  const exIds = [...(intent.exclude_tag_ids || [])];
  if (exTags.length && exIds.length) errors.push('exclude_tags 与 exclude_tag_ids 只能二选一');
  if (exTags.length) {
    const ids = intentTagIds(exTags, 'exclude_tags', errors);
    if (ids.length) params.exclude_tag_id = ids;
  } else if (exIds.length) {
    params.exclude_tag_id = coerceList(exIds, 'exclude_tag_ids', 'int');
  }

  if (intent.closed !== undefined && intent.closed !== null) {
    params.closed = (typeof intent.closed === 'string' && intent.closed.trim().toLowerCase() === 'any')
      ? 'any' : coerceBool(intent.closed, 'closed');
  }
  for (const flag of ['live', 'featured', 'cyom', 'related_tags']) {
    if (intent[flag] !== undefined && intent[flag] !== null) params[flag] = coerceBool(intent[flag], flag);
  }

  for (const [slot, prefix] of [['volume', 'volume'], ['liquidity', 'liquidity']]) {
    const obj = intent[slot];
    if (obj === undefined || obj === null) continue;
    if (typeof obj !== 'object' || Array.isArray(obj)) throw new Error(`${slot} 需要对象，如 {"min": 100000}`);
    const extra = Object.keys(obj).filter((k) => !['min', 'max'].includes(k));
    if (extra.length) throw new Error(`${slot} 只支持 min/max，收到 [${extra}]`);
    for (const bound of ['min', 'max']) {
      if (obj[bound] !== undefined && obj[bound] !== null) params[`${prefix}_${bound}`] = parseAmount(obj[bound]);
    }
  }

  for (const [slot, param] of [
    ['start_after', 'start_date_min'], ['start_before', 'start_date_max'],
    ['end_after', 'end_date_min'], ['end_before', 'end_date_max'],
    ['event_date', 'event_date'],
  ]) {
    if (intent[slot] !== undefined && intent[slot] !== null) params[param] = resolveTime(intent[slot], now, tzName);
  }

  if (intent.order !== undefined && intent.order !== null) {
    let ascending = intent.ascending;
    if (typeof intent.order === 'object' && !Array.isArray(intent.order)) {
      const field = intent.order.field ?? intent.order.by;
      const direction = intent.order.direction ?? intent.order.dir;
      if (!field) throw new Error('order 对象需要 field');
      params.order = String(field);
      if (direction !== undefined && direction !== null) {
        const d = String(direction).toLowerCase();
        if (['asc', 'ascending', '升序'].includes(d)) ascending = true;
        else if (['desc', 'descending', '降序'].includes(d)) ascending = false;
        else throw new Error(`看不懂的排序方向 ${JSON.stringify(direction)}（asc/desc）`);
      }
    } else {
      params.order = String(intent.order);
    }
    if (ascending !== undefined && ascending !== null) params.ascending = coerceBool(ascending, 'ascending');
  } else if (intent.ascending !== undefined && intent.ascending !== null) {
    params.ascending = coerceBool(intent.ascending, 'ascending');
    warnings.push('只给了 ascending 没给 order，上游会忽略排序方向');
  }

  if (intent.limit !== undefined && intent.limit !== null) params.limit = coerceInt(intent.limit, 'limit');
  if (intent.after_cursor) params.after_cursor = String(intent.after_cursor).trim();

  for (const key of [
    'series_id', 'game_id', 'parent_event_id', 'include_children', 'partner_slug',
    'include_chat', 'include_template', 'include_best_lines', 'locale', 'recurrence',
    'tag_match', 'created_by', 'event_week', 'featured_order', 'slug', 'id',
  ]) {
    if (intent[key] !== undefined && intent[key] !== null) params[key] = intent[key];
  }

  if (errors.length) {
    return { ok: false, errors, warnings, params: {}, query: null, url: null, summary: null, unsupported };
  }

  let checked;
  let checkWarn;
  try {
    [checked, checkWarn] = checkParams(params, now, tzName);
  } catch (e) {
    errors.push(e.message);
    return { ok: false, errors, warnings, params: {}, query: null, url: null, summary: null, unsupported };
  }
  warnings.push(...checkWarn, ...notes);

  const query = urlencode(checked);
  const url = query ? `${BASE_URL}${PATH}?${query}` : `${BASE_URL}${PATH}`;
  return { ok: true, errors, warnings, params: checked, query, url, summary: summarize(checked), unsupported };
}

export function urlencode(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((item) => sp.append(k, scalar(item)));
    else sp.append(k, scalar(v));
  }
  return sp.toString();
}

function scalar(v) {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number' && Number.isInteger(v)) return String(v);
  return String(v);
}

function money(n) {
  n = Number(n);
  const fmt = (x) => String(Number(x.toPrecision(6)));
  if (n >= 1e8) return `$${fmt(n / 1e8)}亿`;
  if (n >= 1e4) return `$${fmt(n / 1e4)}万`;
  return `$${fmt(n)}`;
}

export function summarize(params) {
  const parts = [];
  if (params.tag_slug !== undefined) parts.push(`标签 ${params.tag_slug}`);
  if (params.tag_id !== undefined) parts.push(`标签 id ${JSON.stringify(params.tag_id)}`);
  if (params.exclude_tag_id !== undefined) parts.push(`排除标签 id ${JSON.stringify(params.exclude_tag_id)}`);
  if (params.closed === false) parts.push('仅未结算');
  else if (params.closed === true) parts.push('仅已结算');
  else if (params.closed === 'any') parts.push('结算/未结算都要');
  if (params.live) parts.push('直播中');
  if (params.featured) parts.push('精选');
  if (params.title_search) parts.push(`标题含「${params.title_search}」`);
  if (params.volume_min !== undefined || params.volume_max !== undefined) {
    const lo = params.volume_min !== undefined ? `≥${money(params.volume_min)}` : '';
    const hi = params.volume_max !== undefined ? `且≤${money(params.volume_max)}` : '';
    parts.push(`成交量 ${lo}${hi}`);
  }
  if (params.liquidity_min !== undefined || params.liquidity_max !== undefined) {
    const lo = params.liquidity_min !== undefined ? `≥${money(params.liquidity_min)}` : '';
    const hi = params.liquidity_max !== undefined ? `且≤${money(params.liquidity_max)}` : '';
    parts.push(`流动性 ${lo}${hi}`);
  }
  for (const [label, key] of [
    ['开始于', 'start_date_min'], ['开始不晚于', 'start_date_max'],
    ['结束不早于', 'end_date_min'], ['结束不晚于', 'end_date_max'],
  ]) {
    if (params[key] !== undefined) parts.push(`${label} ${params[key]}`);
  }
  if (params.order !== undefined) {
    parts.push(`按 ${params.order} ${params.ascending === false ? '降序' : '升序'}`);
  }
  if (params.limit !== undefined) parts.push(`每页 ${params.limit} 条`);
  parts.push('keyset 游标翻页（禁止 offset）');
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// 5. 网络（自动探测代理 + curl 通道 + SOCKS）
// ---------------------------------------------------------------------------
export const PROXY_CANDIDATES = [
  ['http', 20220], ['socks5h', 20221],
  ['http', 7890], ['socks5h', 7891],
  ['http', 7897], ['http', 1080], ['socks5h', 1080],
  ['http', 10808], ['http', 6152], ['http', 8888],
];

export function tcpOpen(host, port, timeout = 400) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeout);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

export async function detectProxy(host = '127.0.0.1') {
  for (const [scheme, port] of PROXY_CANDIDATES) {
    if (await tcpOpen(host, port)) return [`${scheme}://${host}:${port}`, `探测到本地代理 ${scheme}:${port}`];
  }
  return [null, '未探测到本地代理端口，尝试直连'];
}

export async function resolveProxy(explicit) {
  if (explicit !== undefined && explicit !== null) {
    const val = String(explicit).trim();
    if (['', 'none', 'off', 'direct'].includes(val.toLowerCase())) return [null, '按参数强制直连'];
    if (val.toLowerCase() === 'auto') return detectProxy();
    return [val, '使用显式代理'];
  }
  const env = (process.env.PM_PROXY || '').trim();
  if (env) {
    if (['none', 'off', 'direct'].includes(env.toLowerCase())) return [null, 'PM_PROXY 指定直连'];
    if (env.toLowerCase() === 'auto') return detectProxy();
    return [env, '使用 PM_PROXY'];
  }
  return detectProxy();
}

function curlJson(url, proxy, timeout) {
  const args = ['--silent', '--show-error', '--max-time', String(Math.trunc(timeout)),
    '-H', 'User-Agent: dsh-nlq/1.0', '-H', 'Accept: application/json'];
  if (proxy) args.push('--proxy', proxy);
  args.push(url);
  let out;
  try {
    out = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    const stderr = (e.stderr || '').toString().trim().slice(0, 300);
    throw new Error(`curl 退出码 ${e.status ?? '?'}：${stderr}`);
  }
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`返回不是 JSON：${JSON.stringify(out.slice(0, 200))}`);
  }
}

async function fetchJson(url, proxy, timeout) {
  if (typeof fetch !== 'function' || proxy) throw new Error('fetch 不支持代理，交给 curl');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout * 1000);
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': 'dsh-nlq/1.0' }, signal: ctrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function httpGetJson(pathOrUrl, proxy, timeout = 30, retries = 2) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : BASE_URL + pathOrUrl;
  const [proxyUrl, how] = await resolveProxy(proxy);
  const errors = [];
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    for (const transport of ['curl', 'fetch']) {
      if (transport === 'fetch' && (proxyUrl || '').startsWith('socks')) continue;
      try {
        return transport === 'curl'
          ? curlJson(url, proxyUrl, timeout)
          : await fetchJson(url, proxyUrl, timeout);
      } catch (e) {
        errors.push(`${transport}: ${e.message.slice(0, 160)}`);
      }
    }
  }
  throw new Error(
    `请求失败：\n  ${errors.slice(-3).join('\n  ')}\n` +
    `代理：${proxyUrl || '直连'}（${how}）\n` +
    '修复建议：\n' +
    '  1) 确认 VPN/ClashX 已开启并勾选「设置为系统代理」；\n' +
    '  2) 确认 HTTP 端口（ClashX 常见 7890 或自定义 20220）与我的探测一致；\n' +
    '  3) 运行 `node nlq.mjs doctor` 看逐项诊断；\n' +
    '  4) 代理端口若不同，用 PM_PROXY 指定，例如 PM_PROXY=http://127.0.0.1:7890。',
  );
}

export async function cmdDoctor(args) {
  const results = [];
  const add = (name, ok, detail = '') => results.push({ 检查: name, 结果: ok ? 'OK' : 'FAIL', 详情: detail });

  add('Node', parseInt(process.versions.node.split('.')[0], 10) >= 18, process.versions.node);
  let ip = null;
  try {
    const dns = await import('node:dns/promises');
    ip = (await dns.lookup('gamma-api.polymarket.com')).address;
    add('DNS gamma-api', true, ip);
  } catch (e) {
    add('DNS gamma-api', false, String(e.message).slice(0, 120));
  }
  add('TCP 443 gamma-api', await tcpOpen('gamma-api.polymarket.com', 443, 1500));
  add('PM_PROXY', true, (process.env.PM_PROXY || '（未设置，将自动探测）'));

  const [proxyUrl, how] = await resolveProxy(args.proxy);
  add('代理选择', proxyUrl !== null, `${proxyUrl || '直连'} · ${how}`);

  const seen = [];
  for (const [scheme, port] of PROXY_CANDIDATES) {
    if (await tcpOpen('127.0.0.1', port)) seen.push(`${scheme}:${port}`);
  }
  add('本地代理端口', seen.length > 0, seen.length ? seen.join(', ') : '一个都没监听（VPN/代理可能没开）');

  const probes = [];
  if (proxyUrl) probes.push(['代理', proxyUrl]);
  probes.push(['直连', null]);
  const probeOk = {};
  for (const [label, px] of probes) {
    const t0 = Date.now();
    try {
      await httpGetJson('/tags?limit=1', px ?? 'none', 12, 0);
      probeOk[label] = true;
      add(`${label}访问 gamma`, true, `${Date.now() - t0}ms`);
    } catch (e) {
      probeOk[label] = false;
      const note = proxyUrl && label === '直连' ? '（已选代理，直连被墙属正常）' : '';
      add(`${label}访问 gamma`, false, String(e.message).slice(0, 100) + note);
    }
  }

  const width = Math.max(...results.map((r) => dispWidth(r.检查))) + 2;
  console.log(`${pad('检查', width)} ${'结果'.padEnd(6)} 详情`);
  console.log('-'.repeat(width + 60));
  for (const r of results) console.log(`${pad(r.检查, width)} ${r.结果.padEnd(6)} ${r.详情}`);
  // 判定只看「实际要用的那条路」：选了代理就看代理，没有代理才看直连
  const okAll = probeOk[proxyUrl ? '代理' : '直连'] === true;
  console.log();
  if (okAll) {
    console.log("✅ 可以取数：node nlq.mjs fetch --intent '{...}'");
  } else {
    console.log('❌ 现在取不到 Polymarket 数据。按上面 FAIL 项处理：');
    console.log('   · DNS/TCP 失败 → 本地网络异常');
    console.log('   · 端口一个没监听 → 启动 VPN（ClashX 勾选「设置为系统代理」）');
    console.log('   · 有端口但访问失败 → 节点不通/需换节点，或 PM_PROXY 端口填错');
  }
  if (args.json) console.log(JSON.stringify(results, null, 2));
  return okAll ? 0 : 3;
}

function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += /[\u4e00-\u9fff]/.test(ch) ? 2 : 1;
  return w;
}
function pad(s, width) {
  return String(s) + ' '.repeat(Math.max(0, width - dispWidth(s)));
}

// ---------------------------------------------------------------------------
// 6. CLI
// ---------------------------------------------------------------------------
function loadJsonArg(inline, file) {
  if (inline && file) throw new UsageError('--intent 与 --intent-file 只能给一个');
  if (file) return JSON.parse(readFileSync(file, 'utf8'));
  if (inline) return JSON.parse(inline);
  throw new UsageError("需要 --intent '<json>' 或 --intent-file <path>");
}

class UsageError extends Error {}

const BOOL_FLAGS = new Set(['json', 'verbose', 'compact']);

export function parseArgv(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const key = a.slice(2);
      if (BOOL_FLAGS.has(key)) out[key] = true;
      else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) out[key] = true;
        else { i += 1; out[key] = next; }
      }
    }
  }
  return out;
}

function collectSlugs(argv) {
  const slugs = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--slug' || argv[i] === '-s') slugs.push(argv[i + 1]), (i += 1);
    else if (argv[i].startsWith('--slug=')) slugs.push(argv[i].slice(7));
  }
  return slugs;
}

async function cmdBuild(args) {
  const intent = loadJsonArg(args.intent, args['intent-file']);
  const tz = args.tz || process.env.NLQ_TZ || DEFAULT_TZ;
  const now = parseNow(args.now, tz);
  const res = build(intent, now, tz);
  console.log(JSON.stringify(res, null, 2));
  return res.ok ? 0 : 2;
}

async function cmdCheck(args) {
  const raw = loadJsonArg(args.params, args['params-file']);
  const tz = args.tz || process.env.NLQ_TZ || DEFAULT_TZ;
  const now = parseNow(args.now, tz);
  try {
    const [params, warnings] = checkParams(raw, now, tz);
    const query = urlencode(params);
    console.log(JSON.stringify({
      ok: true, errors: [], warnings, params, query,
      url: query ? `${BASE_URL}${PATH}?${query}` : `${BASE_URL}${PATH}`,
      summary: summarize(params),
    }, null, 2));
    return 0;
  } catch (e) {
    console.log(JSON.stringify({ ok: false, errors: [e.message] }, null, 2));
    return 2;
  }
}

function cmdSchema(args) {
  if (args.json) {
    console.log(JSON.stringify({
      base_url: BASE_URL, path: PATH, params: PARAM_SPEC,
      intent_slots: [...SLOT_KEYS].sort(), known_tag_ids: KNOWN_TAG_IDS, category_hints: CATEGORY_HINTS,
    }, null, 2));
    return 0;
  }
  console.log(`GET ${BASE_URL}${PATH}\n`);
  const rows = Object.entries(PARAM_SPEC).map(([name, spec]) => [name, spec.kind, spec.doc || '']);
  const w = Math.max(...rows.map((r) => r[0].length), 4) + 2;
  console.log(`${'参数'.padEnd(w)} ${'类型'.padEnd(12)} 说明`);
  console.log('-'.repeat(88));
  for (const [name, kind, doc] of rows) console.log(`${name.padEnd(w)} ${kind.padEnd(12)} ${doc}`);
  console.log('\n意图槽位（模型填这些，build 负责翻译）：');
  console.log('  ' + [...SLOT_KEYS].sort().join(', '));
  console.log(`\n已知标签 id：${JSON.stringify(KNOWN_TAG_IDS)}`);
  console.log('中文品类候选（未离线校验，用 `nlq tag-id --slug X` 验证）：');
  for (const [cn, slug] of Object.entries(CATEGORY_HINTS)) console.log(`  ${cn.padEnd(8)} → ${slug}`);
  return 0;
}

async function cmdFetch(args) {
  const [proxyUrl] = await resolveProxy(args.proxy);
  const timeout = Number(args.timeout || 30);
  const retries = Number(args.retries ?? 2);
  const maxPages = Number(args['max-pages'] || 3);
  let url;
  if (args.url) url = args.url;
  else {
    const intent = loadJsonArg(args.intent, args['intent-file']);
    const tz = args.tz || process.env.NLQ_TZ || DEFAULT_TZ;
    const res = build(intent, parseNow(args.now, tz), tz);
    console.error(JSON.stringify({ ok: res.ok, errors: res.errors, warnings: res.warnings, params: res.params, url: res.url, summary: res.summary }, null, 2));
    if (!res.ok) return 2;
    url = res.url;
  }

  const out = { pages: [], events: [] };
  for (let page = 1; page <= maxPages; page += 1) {
    const data = await httpGetJson(url, args.proxy, timeout, retries);
    const events = data.events || [];
    const cursor = data.next_cursor;
    out.pages.push({ page, count: events.length, next_cursor: cursor ?? null, url });
    out.events.push(...events.map(slimEvent));
    if (args.verbose) console.error(`[page ${page}] ${events.length} 条 · next_cursor=${String(cursor).slice(0, 24)}`);
    if (!cursor || events.length === 0) break;
    const u = new URL(url);
    u.searchParams.set('after_cursor', cursor);
    url = u.toString();
  }
  out.total = out.events.length;
  console.log(JSON.stringify(out, null, 2));
  return 0;
}

function slimEvent(e) {
  const mk = e.markets || [];
  return {
    id: String(e.id),
    slug: e.slug,
    title: e.title,
    closed: e.closed,
    startDate: e.startDate,
    endDate: e.endDate,
    volume: e.volume,
    liquidity: e.liquidity,
    volume24hr: e.volume24hr,
    tags: (e.tags || []).map((t) => t.slug),
    market_count: mk.length,
    markets: mk.slice(0, 20).map((m) => ({
      slug: m.slug, question: m.question, closed: m.closed,
      liquidityNum: m.liquidityNum, volume24hr: m.volume24hr,
      spread: m.spread, bestBid: m.bestBid, bestAsk: m.bestAsk,
      clobTokenIds: m.clobTokenIds,
    })),
  };
}

async function cmdTagId(args) {
  const slugs = collectSlugs(args._slugs || []);
  if (!slugs.length) throw new UsageError('需要 --slug <slug>');
  const found = {};
  for (const slug of slugs) {
    if (KNOWN_TAG_IDS[slug] !== undefined) { found[slug] = KNOWN_TAG_IDS[slug]; continue; }
    const data = await httpGetJson(`/events/keyset?tag_slug=${encodeURIComponent(slug)}&limit=1`, args.proxy, Number(args.timeout || 30), Number(args.retries ?? 2));
    let id = null;
    for (const e of data.events || []) {
      for (const t of e.tags || []) if (t.slug === slug) id = Number(t.id);
    }
    found[slug] = id;
  }
  if (args.json) console.log(JSON.stringify(found, null, 2));
  else for (const [slug, id] of Object.entries(found)) console.log(`${slug.padEnd(32)} id=${id}`);
  return Object.values(found).every((v) => v !== null) ? 0 : 3;
}

async function cmdTags(args) {
  let tags = [];
  let offset = 0;
  const max = Number(args.max || 2000);
  while (tags.length < max) {
    const data = await httpGetJson(`/tags?limit=100&offset=${offset}`, args.proxy, Number(args.timeout || 30), Number(args.retries ?? 2));
    if (!data.length) break;
    tags.push(...data);
    offset += data.length;
    if (data.length < 100) break;
  }
  if (args.grep) {
    const kw = String(args.grep).toLowerCase();
    tags = tags.filter((t) => String(t.label ?? '').toLowerCase().includes(kw) || String(t.slug ?? '').toLowerCase().includes(kw));
  }
  tags = tags.slice(0, Number(args.limit || 50));
  if (args.json) console.log(JSON.stringify(tags.map((t) => ({ id: t.id, label: t.label, slug: t.slug })), null, 2));
  else for (const t of tags) console.log(`${String(t.id).padStart(8)}  ${String(t.slug).padEnd(38)} ${t.label}`);
  return 0;
}

const HELP = `nlq — Polymarket /events/keyset 参数编译器

用法:
  nlq schema
  nlq build   --intent '<json>' | --intent-file <path> [--now ISO] [--tz Asia/Shanghai]
  nlq check   --params '<json>' | --params-file <path>
  nlq fetch   --url <url> | (--intent '<json>') [--max-pages N] [--proxy URL]
  nlq tag-id  --slug <slug> [--slug <slug> ...]
  nlq tags    [--grep <kw>] [--max N] [--limit N]
  nlq doctor  [--proxy URL]

环境变量:
  PM_PROXY   代理地址，如 http://127.0.0.1:20220 / socks5h://127.0.0.1:20221
             （auto=自动探测，none=强制直连）
  NLQ_TZ     相对时间基准时区，默认 Asia/Shanghai
`;

export async function main(argv = process.argv.slice(2)) {
  const cmd = argv[0];
  const rest = argv.slice(1);
  const args = parseArgv(rest);
  if (args.slug !== undefined && typeof args.slug === 'string') {
    args._slugs = [args.slug];
  }
  try {
    switch (cmd) {
      case 'build': return await cmdBuild(args);
      case 'check': return await cmdCheck(args);
      case 'schema': return cmdSchema(args);
      case 'fetch': return await cmdFetch(args);
      case 'tag-id': {
        const slugs = collectSlugs(rest);
        return await cmdTagId({ ...args, _slugs: slugs });
      }
      case 'tags': return await cmdTags(args);
      case 'doctor': return await cmdDoctor(args);
      case undefined:
      case '-h':
      case '--help':
      case 'help':
        console.log(HELP);
        return cmd ? 0 : 1;
      default:
        console.error(`未知命令 ${JSON.stringify(cmd)}\n\n${HELP}`);
        return 2;
    }
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(e.message);
      return 2;
    }
    if (e instanceof SyntaxError) {
      console.error(`JSON 解析失败：${e.message}`);
      return 2;
    }
    console.error(JSON.stringify({ ok: false, errors: [e.message] }, null, 2));
    return e.message?.startsWith('请求失败') ? 3 : 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
