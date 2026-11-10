#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""nlq.py — 把「结构化意图」编译成 Polymarket Gamma `/events/keyset` 查询参数。

设计原则
--------
1. 语义解析交给 DSH 模型（读 SKILL.md 的映射规则），本脚本**不做 NLU**；
2. 本脚本只做确定性工作：单位换算、时间换算、参数校验、URL 渲染、游标翻页；
3. 纯标准库、零第三方依赖、`build`/`check`/`schema` 完全离线；
   `fetch`/`tag-id`/`tags` 需要网络（Polymarket 在国内一般需要代理，默认读 PM_PROXY）。

用法
----
    python3 nlq.py schema
    python3 nlq.py build --intent '{"keyword":"OpenAI","closed":false,"volume":{"min":"100万"},"limit":20}'
    python3 nlq.py build --intent-file intent.json --now 2026-11-10T00:00:00Z
    python3 nlq.py check --params '{"closed":"any","tag_id":[2],"exclude_tag_id":[2]}'
    python3 nlq.py tag-id --slug sports --slug politics
    python3 nlq.py fetch --intent '{"tags":["politics"],"closed":false,"limit":5}' --max-pages 2
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover - py<3.9
    ZoneInfo = None  # type: ignore

BASE_URL = "https://gamma-api.polymarket.com"
PATH = "/events/keyset"
DEFAULT_PROXY = "http://127.0.0.1:20220"
DEFAULT_TZ = "Asia/Shanghai"

# ---------------------------------------------------------------------------
# 1. 参数登记表（唯一事实来源：docs.polymarket.com /events/keyset 的 OpenAPI）
# ---------------------------------------------------------------------------
PARAM_SPEC = {
    "limit": {"kind": "int", "min": 1, "max": 100, "default": 20,
              "doc": "每页条数，最大 100，默认 20"},
    "order": {"kind": "str", "doc": "排序字段，逗号分隔的 JSON 字段名，如 volume / endDate / createdAt"},
    "ascending": {"kind": "bool", "doc": "排序方向，仅在 order 存在时生效，默认 true"},
    "after_cursor": {"kind": "str", "doc": "上一页返回的 next_cursor，原样回传，禁止自己构造"},
    "offset": {"kind": "forbidden", "doc": "keyset 端点拒绝 offset，传了直接 422"},
    "id": {"kind": "int_list"},
    "slug": {"kind": "str_list"},
    "closed": {"kind": "bool_or_any", "doc": "true=已结算, false=未结算, any=两者都要; 非法值 422"},
    "live": {"kind": "bool"},
    "featured": {"kind": "bool"},
    "cyom": {"kind": "bool"},
    "title_search": {"kind": "str", "doc": "标题全文搜索（只搜 title，不搜 description）"},
    "liquidity_min": {"kind": "num"},
    "liquidity_max": {"kind": "num"},
    "volume_min": {"kind": "num", "doc": "事件累计成交量（不是 24h 成交量）"},
    "volume_max": {"kind": "num"},
    "start_date_min": {"kind": "datetime", "doc": "事件 startDate 下界"},
    "start_date_max": {"kind": "datetime"},
    "end_date_min": {"kind": "datetime", "doc": "事件 endDate 下界（= 最早结束时间）"},
    "end_date_max": {"kind": "datetime"},
    "start_time_min": {"kind": "datetime"},
    "start_time_max": {"kind": "datetime"},
    "tag_id": {"kind": "int_list"},
    "tag_slug": {"kind": "str", "doc": "单个标签 slug；多标签请用 tag_id"},
    "exclude_tag_id": {"kind": "int_list", "doc": "排除的标签 id，必须与 tag_id 不相交"},
    "related_tags": {"kind": "bool", "doc": "是否连带相关/子标签"},
    "tag_match": {"kind": "str"},
    "series_id": {"kind": "int_list"},
    "game_id": {"kind": "int_list"},
    "event_date": {"kind": "datetime"},
    "event_week": {"kind": "int"},
    "featured_order": {"kind": "bool"},
    "recurrence": {"kind": "str"},
    "created_by": {"kind": "str_list"},
    "parent_event_id": {"kind": "int"},
    "include_children": {"kind": "bool"},
    "partner_slug": {"kind": "str"},
    "include_chat": {"kind": "bool"},
    "include_template": {"kind": "bool"},
    "include_best_lines": {"kind": "bool"},
    "locale": {"kind": "str"},
}

# 已知可排序字段（文档只说"JSON 字段名"，非法字段 422；这里是实测/常用安全集）
ORDER_FIELDS_SAFE = {
    "id", "volume", "liquidity", "startDate", "endDate", "createdAt",
    "updatedAt", "closedTime", "volume24hr", "competitive", "commentCount",
}

# 意图槽位（DSH 模型填这个 JSON，脚本编译为参数）
SLOT_TO_PARAM = {
    "keyword": "title_search",
    "start_after": "start_date_min",
    "start_before": "start_date_max",
    "end_after": "end_date_min",
    "end_before": "end_date_max",
    "event_date": "event_date",
    "live": "live",
    "featured": "featured",
    "cyom": "cyom",
    "related_tags": "related_tags",
}
SLOT_KEYS = set(SLOT_TO_PARAM) | {
    "tags", "tag_ids", "exclude_tags", "exclude_tag_ids",
    "closed", "volume", "liquidity", "order", "ascending", "limit",
    "after_cursor", "series_id", "game_id", "parent_event_id",
    "include_children", "partner_slug", "include_chat", "include_template",
    "include_best_lines", "locale", "recurrence", "tag_match", "created_by",
    "event_week", "featured_order", "slug", "id",
    "unsupported", "notes",
}
# 已在 build 里专门处理的槽位，不允许再从 raw 直通重复写
MANAGED = {"keyword", "tags", "tag_ids", "exclude_tags", "exclude_tag_ids",
           "closed", "volume", "liquidity", "order", "ascending", "limit",
           "start_after", "start_before", "end_after", "end_before",
           "event_date", "live", "featured", "cyom", "related_tags"}

# 已验证的标签 id（来自真实事件 payload；其余靠 `nlq.py tag-id` 在线解析）
KNOWN_TAG_IDS = {
    "politics": 2,
    "elections": 144,
    "united-states": 165,
    "us-presidential-election": 1101,
    "world-elections": 101206,
}

# 常见中文品类 → 候选 slug（**只是候选**，使用前建议 `nlq.py tag-id --slug X` 验证）
CATEGORY_HINTS = {
    "体育": "sports", "体育赛事": "sports", "足球": "soccer", "篮球": "nba",
    "政治": "politics", "选举": "elections", "美国大选": "us-presidential-election",
    "加密": "crypto", "加密货币": "crypto", "比特币": "bitcoin", "以太坊": "ethereum",
    "经济": "economy", "金融": "business", "科技": "tech", "人工智能": "ai",
    "地缘政治": "geopolitics", "中东": "middle-east", "俄乌": "ukraine",
    "文化": "pop-culture", "娱乐": "entertainment", "科学": "science",
    "气候": "climate", "健康": "health",
}

# ---------------------------------------------------------------------------
# 2. 单位 / 时间工具
# ---------------------------------------------------------------------------
_AMOUNT_RE = re.compile(
    r"^\s*[$¥￥]?\s*([0-9]+(?:\.[0-9]+)?)\s*"
    r"(亿|萬|万|百万|千万|千|thousand|million|billion|k|K|w|W|m|M|b|B)?\s*"
    r"(?:美元|美金|usd|usdc|\$)?\s*$",
    re.IGNORECASE,
)
_AMOUNT_UNITS = {
    "千": 1e3, "k": 1e3, "thousand": 1e3,
    "万": 1e4, "萬": 1e4, "w": 1e4,
    "十万": 1e5, "百万": 1e6, "m": 1e6, "million": 1e6,
    "千万": 1e7, "亿": 1e8, "b": 1e9, "billion": 1e9,
}


def parse_amount(value):
    """'100万' / '$1.5M' / '10w' / 250000 → float。失败抛 ValueError。"""
    if isinstance(value, bool):
        raise ValueError("金额不能是布尔值")
    if isinstance(value, (int, float)):
        if value < 0:
            raise ValueError("金额不能为负")
        return float(value)
    s = str(value).strip()
    m = _AMOUNT_RE.match(s)
    if not m:
        raise ValueError(f"看不懂的金额表达：{value!r}（支持 1.5M / 100万 / 10w / 250000）")
    num = float(m.group(1))
    unit = (m.group(2) or "").lower()
    mult = _AMOUNT_UNITS.get(unit) if unit else None
    if unit and mult is None:
        raise ValueError(f"不认识的金额单位：{value!r}")
    out = num * (mult if mult else 1.0)
    if out < 0:
        raise ValueError("金额不能为负")
    return out


def _get_tz(name):
    if ZoneInfo is None:
        return timezone.utc
    try:
        return ZoneInfo(name)
    except Exception:
        raise ValueError(f"未知时区：{name}")


def _iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_now(s, tz):
    if not s:
        return datetime.now(tz)
    txt = str(s).strip()
    if txt.lower() in ("now", "今天", ""):
        return datetime.now(tz)
    txt = txt.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(txt)
    except ValueError:
        raise ValueError(f"--now 需要 ISO 时间（如 2026-11-10T12:00:00Z），收到 {s!r}")
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=tz)
    return dt


_REL_RE = re.compile(r"^rel:\s*([+-]?\d+)\s*(h|d|w|mo|y|min)$", re.IGNORECASE)


def resolve_time(expr, now, tz):
    """把相对/绝对时间表达解析成 UTC ISO 字符串（秒级 Z 结尾）。"""
    if not isinstance(expr, str):
        raise ValueError(f"时间需要字符串，收到 {type(expr).__name__}")
    s = expr.strip()
    low = s.lower()
    local_now = now.astimezone(tz)
    day0 = local_now.replace(hour=0, minute=0, second=0, microsecond=0)

    if low in ("now", "现在"):
        return _iso(now)
    if low in ("today_start", "今天开始", "今天0点"):
        return _iso(day0)
    if low in ("today_end", "今天结束", "今天23:59"):
        return _iso(day0 + timedelta(days=1, seconds=-1))
    if low in ("tomorrow_start", "明天开始"):
        return _iso(day0 + timedelta(days=1))
    if low in ("tomorrow_end", "明天结束"):
        return _iso(day0 + timedelta(days=2, seconds=-1))
    if low in ("week_start", "本周开始"):
        monday = day0 - timedelta(days=day0.weekday())
        return _iso(monday)
    if low in ("week_end", "本周结束"):
        monday = day0 - timedelta(days=day0.weekday())
        return _iso(monday + timedelta(days=7, seconds=-1))
    if low in ("month_start", "本月初"):
        return _iso(day0.replace(day=1))
    if low in ("month_end", "本月底"):
        if day0.month == 12:
            nxt = day0.replace(year=day0.year + 1, month=1, day=1)
        else:
            nxt = day0.replace(month=day0.month + 1, day=1)
        return _iso(nxt - timedelta(seconds=1))
    if low in ("year_start", "今年初"):
        return _iso(day0.replace(month=1, day=1))
    if low in ("year_end", "今年底"):
        return _iso(day0.replace(year=day0.year + 1, month=1, day=1) - timedelta(seconds=1))

    m = _REL_RE.match(s)
    if m:
        n = int(m.group(1))
        unit = m.group(2).lower()
        delta = {
            "min": timedelta(minutes=n),
            "h": timedelta(hours=n),
            "d": timedelta(days=n),
            "w": timedelta(weeks=n),
            "mo": timedelta(days=30 * n),
            "y": timedelta(days=365 * n),
        }[unit]
        return _iso(now + delta)

    txt = s.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(txt)
    except ValueError:
        raise ValueError(
            f"看不懂的时间表达：{expr!r}；用 ISO（2026-11-01T00:00:00Z）"
            f" 或令牌 now/today_start/today_end/week_start/week_end/month_end/year_end"
            f" 或 rel:-7d / rel:+3h / rel:-2mo / rel:+1y"
        )
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=tz)
    return _iso(dt)


# ---------------------------------------------------------------------------
# 3. 参数校验 / 归一化
# ---------------------------------------------------------------------------
def _coerce_bool(v, name):
    if isinstance(v, bool):
        return v
    if isinstance(v, str) and v.lower() in ("true", "false"):
        return v.lower() == "true"
    raise ValueError(f"{name} 需要布尔值（true/false），收到 {v!r}")


def _coerce_int(v, name):
    if isinstance(v, bool):
        raise ValueError(f"{name} 需要整数，收到布尔值")
    if isinstance(v, int):
        return v
    if isinstance(v, float) and v.is_integer():
        return int(v)
    if isinstance(v, str) and re.fullmatch(r"[+-]?\d+", v.strip()):
        return int(v.strip())
    raise ValueError(f"{name} 需要整数，收到 {v!r}")


def _coerce_num(v, name):
    if isinstance(v, bool):
        raise ValueError(f"{name} 需要数字，收到布尔值")
    if isinstance(v, (int, float)):
        return v
    if isinstance(v, str):
        try:
            return parse_amount(v)
        except ValueError:
            raise ValueError(f"{name} 需要数字，收到 {v!r}")
    raise ValueError(f"{name} 需要数字，收到 {v!r}")


def _coerce_list(v, name, item_kind):
    if isinstance(v, (str, int, float)) and not isinstance(v, bool):
        v = [v]
    if not isinstance(v, list):
        raise ValueError(f"{name} 需要数组，收到 {v!r}")
    out = []
    for item in v:
        out.append(_coerce_int(item, name) if item_kind == "int" else str(item))
    return out


def check_params(raw, now=None, tz=None):
    """校验并归一化一个原生参数 dict。返回 (params, warnings)。"""
    if not isinstance(raw, dict):
        raise ValueError("params 必须是 JSON 对象")
    now = now or datetime.now(timezone.utc)
    tz = tz or _get_tz(os.environ.get("NLQ_TZ", DEFAULT_TZ))
    params, warnings = {}, []
    arrays = {}

    for key, val in raw.items():
        if key.startswith("_"):
            continue
        if key not in PARAM_SPEC:
            raise ValueError(f"未知参数 {key!r}；/events/keyset 不支持这个字段（见 nlq.py schema）")
        spec = PARAM_SPEC[key]
        kind = spec["kind"]
        if kind == "forbidden":
            raise ValueError(
                f"{key} 在 keyset 端点被显式拒绝（会返回 422）；翻页请用 next_cursor → after_cursor"
            )
        if val is None:
            continue
        if kind == "int":
            n = _coerce_int(val, key)
            if "min" in spec and n < spec["min"]:
                warnings.append(f"{key}={n} 低于允许最小值 {spec['min']}，已改为 {spec['min']}")
                n = spec["min"]
            if "max" in spec and n > spec["max"]:
                warnings.append(
                    f"{key}={n} 超过上限 {spec['max']}，已截断为 {spec['max']}；"
                    f"要更多数据请翻页（after_cursor）而不是放大 limit"
                )
                n = spec["max"]
            if key == "limit":
                params[key] = n
            else:
                params[key] = n
        elif kind == "num":
            n = _coerce_num(val, key)
            if n < 0:
                raise ValueError(f"{key} 不能为负")
            params[key] = int(n) if float(n).is_integer() else float(n)
        elif kind == "bool":
            params[key] = _coerce_bool(val, key)
        elif kind == "bool_or_any":
            if isinstance(val, str) and val.strip().lower() == "any":
                params[key] = "any"
            else:
                params[key] = _coerce_bool(val, key)
        elif kind == "str":
            if not isinstance(val, str):
                val = str(val)
            if not val.strip():
                raise ValueError(f"{key} 不能为空字符串")
            params[key] = val.strip()
        elif kind == "datetime":
            params[key] = resolve_time(val, now, tz)
        elif kind == "int_list":
            arrays[key] = _coerce_list(val, key, "int")
        elif kind == "str_list":
            arrays[key] = _coerce_list(val, key, "str")
        else:  # pragma: no cover
            raise ValueError(f"未实现的参数类型 {kind}")

    params.update(arrays)

    # order 字段安全集
    if "order" in params:
        fields = [f.strip() for f in str(params["order"]).split(",") if f.strip()]
        if not fields:
            raise ValueError("order 不能是空字符串")
        for f in fields:
            if f not in ORDER_FIELDS_SAFE:
                warnings.append(
                    f"order 字段 {f!r} 不在已知安全集 {sorted(ORDER_FIELDS_SAFE)} 内；"
                    f"非法字段上游会返回 422，--check 不拦但请确认"
                )
        params["order"] = ",".join(fields)

    if "ascending" in params and "order" not in params:
        warnings.append("ascending 仅在传了 order 时生效（文档说明），当前没有 order，上游会忽略它")
    if "ascending" not in params and "order" in params:
        warnings.append("未指定 ascending，上游默认 true（升序）；要降序请显式传 false")

    tag_ids = set(params.get("tag_id") or [])
    exc = set(params.get("exclude_tag_id") or [])
    if tag_ids & exc:
        raise ValueError(f"tag_id 与 exclude_tag_id 不能重叠（重叠 {sorted(tag_ids & exc)}），上游会 422")
    if "tag_slug" in params and "tag_id" in params:
        warnings.append("同时传了 tag_slug 和 tag_id，行为可能不确定；建议只用一个")
    if params.get("include_children") and "parent_event_id" not in params:
        warnings.append("include_children 通常要配合 parent_event_id 使用")

    for k in ("start_date_min", "start_date_max", "end_date_min", "end_date_max",
              "start_time_min", "start_time_max", "event_date"):
        pass  # 已在上面归一化

    # 时间区间自洽性
    for lo, hi in (("start_date_min", "start_date_max"), ("end_date_min", "end_date_max"),
                   ("start_time_min", "start_time_max")):
        if lo in params and hi in params and params[lo] > params[hi]:
            warnings.append(f"{lo} 晚于 {hi}，区间为空，结果大概率为 0 条")
    if "volume_min" in params and "volume_max" in params and params["volume_min"] > params["volume_max"]:
        warnings.append("volume_min 大于 volume_max，结果大概率为 0 条")
    if "liquidity_min" in params and "liquidity_max" in params and params["liquidity_min"] > params["liquidity_max"]:
        warnings.append("liquidity_min 大于 liquidity_max，结果大概率为 0 条")

    return params, warnings


# ---------------------------------------------------------------------------
# 4. 意图 → 参数
# ---------------------------------------------------------------------------
def _intent_tag_ids(slugs, kind, warnings, errors):
    ids = []
    for slug in slugs:
        slug = str(slug).strip()
        if slug.isdigit():
            ids.append(int(slug))
            continue
        if slug in KNOWN_TAG_IDS:
            ids.append(KNOWN_TAG_IDS[slug])
            continue
        hint = next((k for k, v in CATEGORY_HINTS.items() if v == slug), None)
        msg = (f"{kind} 里的标签 {slug!r} 没有已知 id"
               + (f"（中文品类候选：{hint}）" if hint else "")
               + f"；先运行 `nlq.py tag-id --slug {slug}` 解析，或改用 tag_ids 槽位直接给 id")
        errors.append(msg)
    return ids


def build(intent, now=None, tz_name=None):
    """意图 JSON → {params, url, summary, warnings, errors, unsupported}。"""
    if not isinstance(intent, dict):
        raise ValueError("intent 必须是 JSON 对象")
    tz = _get_tz(tz_name or os.environ.get("NLQ_TZ", DEFAULT_TZ))
    now = now or datetime.now(tz)

    errors, warnings = [], []
    params = {}
    unsupported = list(intent.get("unsupported") or [])
    notes = list(intent.get("notes") or [])

    unknown = [k for k in intent if k not in SLOT_KEYS and not k.startswith("_")]
    if unknown:
        raise ValueError(
            f"未知意图槽位 {unknown}；不要在 intent 里放整句自然语言，"
            f"允许的槽位见 `nlq.py schema`"
        )

    # --- 关键词
    if intent.get("keyword"):
        params["title_search"] = str(intent["keyword"]).strip()

    # --- 标签
    tag_ids = list(intent.get("tag_ids") or [])
    tags = [str(t).strip() for t in (intent.get("tags") or [])]
    if tags and tag_ids:
        errors.append("tags 与 tag_ids 只能二选一")
    if tags:
        if len(tags) == 1:
            slug = tags[0]
            if slug.isdigit():
                params["tag_id"] = [int(slug)]
            elif slug in KNOWN_TAG_IDS:
                params["tag_id"] = [KNOWN_TAG_IDS[slug]]
            else:
                params["tag_slug"] = slug
                if slug in CATEGORY_HINTS.values():
                    warnings.append(f"tag_slug={slug} 未离线校验，建议先 `nlq.py tag-id --slug {slug}` 确认存在")
        else:
            ids = _intent_tag_ids(tags, "tags", warnings, errors)
            if ids:
                params["tag_id"] = ids
    elif tag_ids:
        params["tag_id"] = _coerce_list(tag_ids, "tag_ids", "int")

    ex_tags = [str(t).strip() for t in (intent.get("exclude_tags") or [])]
    ex_ids = list(intent.get("exclude_tag_ids") or [])
    if ex_tags and ex_ids:
        errors.append("exclude_tags 与 exclude_tag_ids 只能二选一")
    if ex_tags:
        ids = _intent_tag_ids(ex_tags, "exclude_tags", warnings, errors)
        if ids:
            params["exclude_tag_id"] = ids
    elif ex_ids:
        params["exclude_tag_id"] = _coerce_list(ex_ids, "exclude_tag_ids", "int")

    # --- 状态
    if "closed" in intent and intent["closed"] is not None:
        c = intent["closed"]
        if isinstance(c, str) and c.strip().lower() == "any":
            params["closed"] = "any"
        else:
            params["closed"] = _coerce_bool(c, "closed")
    if intent.get("live") is not None:
        params["live"] = _coerce_bool(intent["live"], "live")
    for flag in ("featured", "cyom", "related_tags"):
        if intent.get(flag) is not None:
            params[flag] = _coerce_bool(intent[flag], flag)

    # --- 金额
    for slot, prefix in (("volume", "volume"), ("liquidity", "liquidity")):
        obj = intent.get(slot)
        if obj is None:
            continue
        if not isinstance(obj, dict):
            raise ValueError(f"{slot} 需要对象，如 {{\"min\": 100000}}")
        unknown_keys = set(obj) - {"min", "max"}
        if unknown_keys:
            raise ValueError(f"{slot} 只支持 min/max，收到 {sorted(unknown_keys)}")
        for bound in ("min", "max"):
            if obj.get(bound) is not None:
                params[f"{prefix}_{bound}"] = parse_amount(obj[bound])

    # --- 时间
    for slot, param in (("start_after", "start_date_min"), ("start_before", "start_date_max"),
                        ("end_after", "end_date_min"), ("end_before", "end_date_max"),
                        ("event_date", "event_date")):
        if intent.get(slot) is not None:
            params[param] = resolve_time(intent[slot], now, tz)

    # --- 排序
    if intent.get("order") is not None:
        order = intent["order"]
        ascending = intent.get("ascending")
        if isinstance(order, dict):
            field = order.get("field") or order.get("by")
            direction = order.get("direction") or order.get("dir")
            if not field:
                raise ValueError("order 对象需要 field")
            params["order"] = str(field)
            if direction is not None:
                d = str(direction).lower()
                if d in ("asc", "ascending", "升序"):
                    ascending = True
                elif d in ("desc", "descending", "降序"):
                    ascending = False
                else:
                    raise ValueError(f"看不懂的排序方向 {direction!r}（asc/desc）")
        else:
            params["order"] = str(order)
        if ascending is not None:
            params["ascending"] = _coerce_bool(ascending, "ascending")
    elif intent.get("ascending") is not None:
        params["ascending"] = _coerce_bool(intent["ascending"], "ascending")
        warnings.append("只给了 ascending 没给 order，上游会忽略排序方向")

    # --- 分页
    if intent.get("limit") is not None:
        params["limit"] = _coerce_int(intent["limit"], "limit")
    if intent.get("after_cursor"):
        params["after_cursor"] = str(intent["after_cursor"]).strip()

    # --- 其余已知参数直通
    for key in ("series_id", "game_id", "parent_event_id", "include_children",
                "partner_slug", "include_chat", "include_template", "include_best_lines",
                "locale", "recurrence", "tag_match", "created_by", "event_week",
                "featured_order", "slug", "id"):
        if intent.get(key) is not None:
            params[key] = intent[key]

    if errors:
        return {"ok": False, "errors": errors, "warnings": warnings,
                "params": {}, "url": None, "summary": None, "unsupported": unsupported}

    try:
        params, check_warn = check_params(params, now=now, tz=tz)
    except ValueError as e:
        errors.append(str(e))
        return {"ok": False, "errors": errors, "warnings": warnings,
                "params": {}, "url": None, "summary": None, "unsupported": unsupported}
    warnings.extend(check_warn)
    warnings.extend(notes)

    query = urlencode(params)
    url = f"{BASE_URL}{PATH}" + (f"?{query}" if query else "")
    summary = summarize(params)
    return {"ok": not errors, "errors": errors, "warnings": warnings,
            "params": params, "query": query, "url": url,
            "summary": summary, "unsupported": unsupported}


def urlencode(params):
    flat = []
    for k, v in params.items():
        if isinstance(v, list):
            for item in v:
                flat.append((k, _scalar(item)))
        else:
            flat.append((k, _scalar(v)))
    return urllib.parse.urlencode(flat, doseq=False, safe="", quote_via=urllib.parse.quote)


def _scalar(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def _money(n):
    n = float(n)
    if n >= 1e8:
        return f"${n/1e8:g}亿"
    if n >= 1e4:
        return f"${n/1e4:g}万"
    return f"${n:g}"


def summarize(params):
    parts = []
    if "tag_slug" in params:
        parts.append(f"标签 {params['tag_slug']}")
    if "tag_id" in params:
        parts.append(f"标签 id {params['tag_id']}")
    if "exclude_tag_id" in params:
        parts.append(f"排除标签 id {params['exclude_tag_id']}")
    if params.get("closed") is False:
        parts.append("仅未结算")
    elif params.get("closed") is True:
        parts.append("仅已结算")
    elif params.get("closed") == "any":
        parts.append("结算/未结算都要")
    if params.get("live"):
        parts.append("直播中")
    if params.get("featured"):
        parts.append("精选")
    if params.get("title_search"):
        parts.append(f"标题含「{params['title_search']}」")
    if "volume_min" in params or "volume_max" in params:
        lo = _money(params["volume_min"]) if "volume_min" in params else ""
        hi = _money(params["volume_max"]) if "volume_max" in params else ""
        parts.append(f"成交量 {'≥'+lo if lo else ''}{'且≤'+hi if hi else ''}".replace("≥≤", ""))
    if "liquidity_min" in params or "liquidity_max" in params:
        lo = _money(params["liquidity_min"]) if "liquidity_min" in params else ""
        hi = _money(params["liquidity_max"]) if "liquidity_max" in params else ""
        parts.append(f"流动性 {'≥'+lo if lo else ''}{'且≤'+hi if hi else ''}".replace("≥≤", ""))
    for label, key in (("开始于", "start_date_min"), ("开始不晚于", "start_date_max"),
                       ("结束不早于", "end_date_min"), ("结束不晚于", "end_date_max")):
        if key in params:
            parts.append(f"{label} {params[key]}")
    if "order" in params:
        direction = "降序" if params.get("ascending") is False else "升序"
        parts.append(f"按 {params['order']} {direction}")
    if "limit" in params:
        parts.append(f"每页 {params['limit']} 条")
    parts.append("keyset 游标翻页（禁止 offset）")
    return " · ".join(parts)


# ---------------------------------------------------------------------------
# 5. 网络（自动探测代理 + curl/urllib 双通道 + SOCKS）
# ---------------------------------------------------------------------------
import shutil
import socket
import subprocess

# 常见本地代理端口：ClashX(20220/7890)、Clash Verge(7897)、v2rayN(10808)、
# Surge(6152)、Shadowsocks(1080)、Quantumult(8888) 等；SOCKS 用 socks5h:// 走 curl
PROXY_CANDIDATES = [
    ("http", 20220), ("socks5h", 20221),
    ("http", 7890), ("socks5h", 7891),
    ("http", 7897), ("http", 1080), ("socks5h", 1080),
    ("http", 10808), ("http", 6152), ("http", 8888),
]


def _tcp_open(host, port, timeout=0.4):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def detect_proxy(host="127.0.0.1"):
    """返回 (proxy_url|None, 探测说明)。None 表示直连。"""
    for scheme, port in PROXY_CANDIDATES:
        if _tcp_open(host, port):
            return f"{scheme}://{host}:{port}", f"探测到本地代理 {scheme}:{port}"
    return None, "未探测到本地代理端口，尝试直连"


def resolve_proxy(explicit=None):
    """显式值 > PM_PROXY 环境变量 > 自动探测。'none'/'off' 强制直连，'auto' 强制探测。"""
    if explicit is not None:
        val = str(explicit).strip()
        if val.lower() in ("", "none", "off", "direct"):
            return None, "按参数强制直连"
        if val.lower() == "auto":
            return detect_proxy()
        return val, "使用显式代理"
    env = os.environ.get("PM_PROXY", "").strip()
    if env:
        if env.lower() in ("none", "off", "direct"):
            return None, "PM_PROXY 指定直连"
        if env.lower() == "auto":
            return detect_proxy()
        return env, "使用 PM_PROXY"
    return detect_proxy()


def _curl_json(url, proxy, timeout):
    cmd = ["curl", "-sS", "--max-time", str(int(timeout)),
           "-H", "User-Agent: dsh-nlq/1.0", "-H", "Accept: application/json"]
    if proxy:
        cmd += ["--proxy", proxy]
    cmd.append(url)
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"curl 退出码 {p.returncode}：{p.stderr.strip()[:300]}")
    try:
        return json.loads(p.stdout)
    except json.JSONDecodeError:
        raise RuntimeError(f"返回不是 JSON：{p.stdout[:200]!r}")


def _urllib_json(url, proxy, timeout):
    opener = (urllib.request.build_opener(
        urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
        if proxy else urllib.request.build_opener())
    req = urllib.request.Request(url, headers={"User-Agent": "dsh-nlq/1.0"})
    with opener.open(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def http_get_json(path_or_url, proxy=None, timeout=30, retries=2):
    url = path_or_url if path_or_url.startswith("http") else BASE_URL + path_or_url
    proxy_url, how = resolve_proxy(proxy)
    have_curl = shutil.which("curl") is not None
    errors = []
    for attempt in range(retries + 1):
        for transport, fn in (("curl", _curl_json), ("urllib", _urllib_json)):
            if transport == "urllib" and (proxy_url or "").startswith("socks"):
                continue  # urllib 不支持 socks，交给 curl
            if transport == "curl" and not have_curl:
                continue
            try:
                return fn(url, proxy_url, timeout)
            except urllib.error.HTTPError as e:
                body = e.read().decode("utf-8", "replace")[:500]
                raise RuntimeError(f"HTTP {e.code}：{body}") from None
            except Exception as e:  # noqa: BLE001
                errors.append(f"{transport}: {type(e).__name__}: {str(e)[:160]}")
                continue
        if attempt < retries:
            continue
    hint = (
        f"代理：{proxy_url or '直连'}（{how}）\n"
        f"修复建议：\n"
        f"  1) 确认 VPN/ClashX 已开启并勾选「设置为系统代理」；\n"
        f"  2) 确认 HTTP 端口（ClashX 常见 7890 或自定义 20220）与我的探测一致；\n"
        f"  3) 运行 `python3 nlq.py doctor` 看逐项诊断；\n"
        f"  4) 代理端口若不同，用 PM_PROXY 指定，例如 PM_PROXY=http://127.0.0.1:7890。"
    )
    raise RuntimeError("请求失败：\n  " + "\n  ".join(errors[-3:]) + "\n" + hint)


def cmd_doctor(args):
    """逐项体检：DNS / TCP / 代理端口 / 直连 / 代理连通性。"""
    tz = _get_tz(args.tz)
    results = []

    def add(name, ok, detail=""):
        results.append({"检查": name, "结果": "OK" if ok else "FAIL", "详情": detail})

    add("Python", sys.version_info >= (3, 9), sys.version.split()[0])
    try:
        ip = socket.gethostbyname("gamma-api.polymarket.com")
        add("DNS gamma-api", True, ip)
    except OSError as e:
        add("DNS gamma-api", False, str(e)[:120]); ip = None
    add("TCP 443 gamma-api", _tcp_open("gamma-api.polymarket.com", 443, 1.5))
    add("curl 可用", shutil.which("curl") is not None, shutil.which("curl") or "")
    env = os.environ.get("PM_PROXY", "")
    add("PM_PROXY", True, env or "（未设置，将自动探测）")

    proxy_url, how = resolve_proxy(args.proxy if args.proxy is not None else None)
    add("代理选择", proxy_url is not None, f"{proxy_url or '直连'} · {how}")

    # 端口扫描
    seen = []
    for scheme, port in PROXY_CANDIDATES:
        if _tcp_open("127.0.0.1", port):
            seen.append(f"{scheme}:{port}")
    add("本地代理端口", bool(seen), ", ".join(seen) if seen else "一个都没监听（VPN/代理可能没开）")

    # 连通性: 代理 + 直连
    probes = []
    if proxy_url:
        probes.append(("代理", proxy_url))
    probes.append(("直连", None))
    for label, px in probes:
        t0 = time.time()
        try:
            _curl_json("https://gamma-api.polymarket.com/tags?limit=1", px, args.timeout) \
                if shutil.which("curl") else _urllib_json(
                    "https://gamma-api.polymarket.com/tags?limit=1", px, args.timeout)
            add(f"{label}访问 gamma", True, f"{int((time.time()-t0)*1000)}ms")
        except Exception as e:  # noqa: BLE001
            add(f"{label}访问 gamma", False, str(e)[:120])

    width = max(len(r["检查"]) for r in results) + 2
    print(f"{'检查'.ljust(width)} {'结果':6s} 详情")
    print("-" * (width + 60))
    for r in results:
        print(f"{r['检查'].ljust(width)} {r['结果']:6s} {r['详情']}")
    ok_all = all(r["结果"] == "OK" for r in results if "访问 gamma" in r["检查"])
    print()
    if ok_all:
        print("✅ 可以取数：python3 nlq.py fetch --intent '{...}'")
    else:
        print("❌ 现在取不到 Polymarket 数据。按上面 FAIL 项处理：")
        print("   · DNS/TCP 失败 → 本地网络异常")
        print("   · 端口一个没监听 → 启动 VPN（ClashX 勾选「设置为系统代理」）")
        print("   · 有端口但访问失败 → 节点不通/需换节点，或 PM_PROXY 端口填错")
    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0 if ok_all else 3


def cmd_fetch(args):
    if args.url:
        url = args.url
    else:
        intent = load_json_arg(args.intent, args.intent_file)
        res = build(intent, _parse_now(args.now, _get_tz(args.tz)), args.tz)
        print(json.dumps({k: res[k] for k in ("ok", "errors", "warnings", "params", "url", "summary")},
                         ensure_ascii=False, indent=2), file=sys.stderr)
        if not res["ok"]:
            return 2
        url = res["url"]

    page = 0
    total = 0
    out = {"pages": [], "events": []}
    while page < args.max_pages:
        page += 1
        data = http_get_json(url, proxy=args.proxy, timeout=args.timeout, retries=args.retries)
        events = data.get("events") or []
        cursor = data.get("next_cursor")
        slim = [_slim_event(e) for e in events]
        out["pages"].append({"page": page, "count": len(events),
                             "next_cursor": cursor, "url": url})
        out["events"].extend(slim)
        total += len(events)
        if args.verbose:
            print(f"[page {page}] {len(events)} 条 · next_cursor={str(cursor)[:24]}", file=sys.stderr)
        if not cursor or not events:
            break
        params = urllib.parse.parse_qs(urllib.parse.urlparse(url).query, keep_blank_values=True)
        flat = [(k, vv) for k, vs in params.items() if k != "after_cursor" for vv in vs]
        flat.append(("after_cursor", cursor))
        url = f"{BASE_URL}{PATH}?" + urllib.parse.urlencode(flat, quote_via=urllib.parse.quote)

    out["total"] = total
    if args.compact:
        print(json.dumps([e["id"] + " " + e["title"] for e in out["events"]], ensure_ascii=False, indent=2))
    else:
        print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


def _slim_event(e):
    mk = e.get("markets") or []
    return {
        "id": str(e.get("id")),
        "slug": e.get("slug"),
        "title": e.get("title"),
        "closed": e.get("closed"),
        "startDate": e.get("startDate"),
        "endDate": e.get("endDate"),
        "volume": e.get("volume"),
        "liquidity": e.get("liquidity"),
        "volume24hr": e.get("volume24hr"),
        "tags": [t.get("slug") for t in (e.get("tags") or [])],
        "market_count": len(mk),
        "markets": [{
            "slug": m.get("slug"),
            "question": m.get("question"),
            "closed": m.get("closed"),
            "liquidityNum": m.get("liquidityNum"),
            "volume24hr": m.get("volume24hr"),
            "spread": m.get("spread"),
            "bestBid": m.get("bestBid"),
            "bestAsk": m.get("bestAsk"),
            "clobTokenIds": m.get("clobTokenIds"),
        } for m in mk[:20]],
    }


# ---------------------------------------------------------------------------
# 6. CLI
# ---------------------------------------------------------------------------
def load_json_arg(inline, path):
    if inline and path:
        raise SystemExit("--intent 与 --intent-file 只能给一个")
    if path:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    if inline:
        return json.loads(inline)
    raise SystemExit("需要 --intent '<json>' 或 --intent-file <path>")


def cmd_build(args):
    intent = load_json_arg(args.intent, args.intent_file)
    now = _parse_now(args.now, _get_tz(args.tz))
    res = build(intent, now, args.tz)
    print(json.dumps(res, ensure_ascii=False, indent=2))
    return 0 if res["ok"] else 2


def cmd_check(args):
    raw = load_json_arg(args.params, args.params_file)
    now = _parse_now(args.now, _get_tz(args.tz))
    try:
        params, warnings = check_params(raw, now=now, tz=_get_tz(args.tz))
    except ValueError as e:
        print(json.dumps({"ok": False, "errors": [str(e)]}, ensure_ascii=False, indent=2))
        return 2
    query = urlencode(params)
    print(json.dumps({
        "ok": True, "errors": [], "warnings": warnings, "params": params, "query": query,
        "url": f"{BASE_URL}{PATH}?{query}" if query else f"{BASE_URL}{PATH}",
        "summary": summarize(params),
    }, ensure_ascii=False, indent=2))
    return 0


def cmd_schema(args):
    if args.json:
        print(json.dumps({"base_url": BASE_URL, "path": PATH, "params": PARAM_SPEC,
                          "intent_slots": sorted(SLOT_KEYS),
                          "known_tag_ids": KNOWN_TAG_IDS,
                          "category_hints": CATEGORY_HINTS},
                         ensure_ascii=False, indent=2))
        return 0
    print(f"GET {BASE_URL}{PATH}\n")
    print(f"{'参数':22s} {'类型':12s} 说明")
    print("-" * 88)
    for name, spec in PARAM_SPEC.items():
        print(f"{name:22s} {spec['kind']:12s} {spec.get('doc','')}")
    print("\n意图槽位（模型填这些，build 负责翻译）：")
    print("  " + ", ".join(sorted(SLOT_KEYS)))
    print(f"\n已知标签 id：{KNOWN_TAG_IDS}")
    print("中文品类候选（未离线校验，用 `nlq.py tag-id --slug X` 验证）：")
    for cn, slug in CATEGORY_HINTS.items():
        print(f"  {cn:8s} → {slug}")
    return 0


def cmd_tag_id(args):
    """用 tag_slug 拉 1 条事件，从事件的 tags 里反查 id —— 免于枚举全量标签。"""
    found = {}
    for slug in args.slug:
        if slug in KNOWN_TAG_IDS:
            found[slug] = KNOWN_TAG_IDS[slug]
            continue
        data = http_get_json(
            f"{PATH}?tag_slug={urllib.parse.quote(slug)}&limit=1",
            proxy=args.proxy, timeout=args.timeout, retries=args.retries,
        )
        events = data.get("events") or []
        tid = None
        for e in events:
            for t in e.get("tags") or []:
                if t.get("slug") == slug:
                    tid = int(t["id"])
        if tid is None:
            found[slug] = None
        else:
            found[slug] = tid
    if args.json:
        print(json.dumps(found, ensure_ascii=False, indent=2))
    else:
        for slug, tid in found.items():
            print(f"{slug:32s} id={tid}")
    return 0 if all(v is not None for v in found.values()) else 3


def cmd_tags(args):
    tags, offset = [], 0
    while len(tags) < args.max:
        data = http_get_json(f"/tags?limit=100&offset={offset}", proxy=args.proxy,
                             timeout=args.timeout, retries=args.retries)
        if not data:
            break
        tags.extend(data)
        offset += len(data)
        if len(data) < 100:
            break
    if args.grep:
        kw = args.grep.lower()
        tags = [t for t in tags if kw in str(t.get("label", "")).lower()
                or kw in str(t.get("slug", "")).lower()]
    tags = tags[: args.limit]
    if args.json:
        print(json.dumps([{"id": t.get("id"), "label": t.get("label"), "slug": t.get("slug")}
                          for t in tags], ensure_ascii=False, indent=2))
    else:
        for t in tags:
            print(f"{str(t.get('id')):>8s}  {str(t.get('slug')):38s} {t.get('label')}")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="Polymarket /events/keyset 参数编译器（DSH 技能配套）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def add_common(p):
        p.add_argument("--now", help="冻结当前时间，便于可复现（ISO，如 2026-11-10T12:00:00Z）")
        p.add_argument("--tz", default=os.environ.get("NLQ_TZ", DEFAULT_TZ),
                       help=f"相对时间基准时区，默认 {DEFAULT_TZ}")
        p.add_argument("--json", action="store_true", help="输出 JSON")

    p = sub.add_parser("schema", help="打印参数表/槽位/标签字典")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_schema)

    p = sub.add_parser("build", help="意图 JSON → 参数 + URL")
    p.add_argument("--intent")
    p.add_argument("--intent-file")
    add_common(p)
    p.set_defaults(func=cmd_build)

    p = sub.add_parser("check", help="校验原生参数 dict")
    p.add_argument("--params")
    p.add_argument("--params-file")
    add_common(p)
    p.set_defaults(func=cmd_check)

    p = sub.add_parser("fetch", help="按游标翻页取数（需要网络/代理）")
    p.add_argument("--url")
    p.add_argument("--intent")
    p.add_argument("--intent-file")
    p.add_argument("--proxy", default=os.environ.get("PM_PROXY"))
    p.add_argument("--max-pages", type=int, default=3)
    p.add_argument("--timeout", type=float, default=30)
    p.add_argument("--retries", type=int, default=2)
    p.add_argument("--compact", action="store_true")
    p.add_argument("--verbose", action="store_true")
    p.add_argument("--now")
    p.add_argument("--tz", default=os.environ.get("NLQ_TZ", DEFAULT_TZ))
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_fetch)

    p = sub.add_parser("doctor", help="网络/代理体检：DNS、端口、直连、代理连通性")
    p.add_argument("--proxy")
    p.add_argument("--timeout", type=float, default=12)
    p.add_argument("--tz", default=os.environ.get("NLQ_TZ", DEFAULT_TZ))
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_doctor)

    p = sub.add_parser("tag-id", help="tag_slug → tag_id（反查事件标签）")
    p.add_argument("--slug", action="append", required=True)
    p.add_argument("--proxy", default=os.environ.get("PM_PROXY"))
    p.add_argument("--timeout", type=float, default=30)
    p.add_argument("--retries", type=int, default=2)
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_tag_id)

    p = sub.add_parser("tags", help="枚举/检索标签（需要网络/代理）")
    p.add_argument("--grep")
    p.add_argument("--max", type=int, default=2000, help="最多扫描多少个标签")
    p.add_argument("--limit", type=int, default=50)
    p.add_argument("--proxy", default=os.environ.get("PM_PROXY"))
    p.add_argument("--timeout", type=float, default=30)
    p.add_argument("--retries", type=int, default=2)
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_tags)

    args = ap.parse_args(argv)
    try:
        return args.func(args)
    except ValueError as e:
        print(json.dumps({"ok": False, "errors": [str(e)]}, ensure_ascii=False, indent=2), file=sys.stderr)
        return 2
    except RuntimeError as e:
        print(json.dumps({"ok": False, "errors": [str(e)], "hint": "network"},
                         ensure_ascii=False, indent=2), file=sys.stderr)
        return 3
    except FileNotFoundError as e:
        print(f"文件不存在：{e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
