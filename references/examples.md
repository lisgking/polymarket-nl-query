# 中文自然语言 → `/events/keyset` 参数：30 个黄金样例

> 时间基准：`--now 2026-11-10T12:00:00Z`，时区 `Asia/Shanghai`。
> 用 `python3 bin/nlq.py build --intent '<JSON>' --now 2026-11-10T12:00:00Z` 可复现参数与 URL。
> `unsupported` 里的内容**不要**硬塞进参数：接口没有这些筛选项，必须客户端二次过滤。

### 1. 「找未结算的体育盘，成交量 100 万美元以上，按成交量从高到低」

```json
{
  "tags": [
    "sports"
  ],
  "closed": false,
  "volume": {
    "min": "100万"
  },
  "order": "volume",
  "ascending": false,
  "limit": 20
}
```

参数：`{"tag_slug": "sports", "closed": false, "volume_min": 1000000, "order": "volume", "ascending": false, "limit": 20}`

⚠️ tag_slug=sports 未离线校验，建议先 `nlq.py tag-id --slug sports` 确认存在

### 2. 「最近 7 天新开的政治类事件」

```json
{
  "tags": [
    "politics"
  ],
  "start_after": "rel:-7d",
  "limit": 50
}
```

参数：`{"start_date_min": "2026-11-03T12:00:00Z", "limit": 50, "tag_id": [2]}`

### 3. 「未来一周内结束的加密事件」

```json
{
  "tags": [
    "crypto"
  ],
  "closed": false,
  "end_before": "rel:+7d",
  "order": "endDate",
  "ascending": true,
  "limit": 50
}
```

参数：`{"tag_slug": "crypto", "closed": false, "end_date_max": "2026-11-17T12:00:00Z", "order": "endDate", "ascending": true, "limit": 50}`

⚠️ tag_slug=crypto 未离线校验，建议先 `nlq.py tag-id --slug crypto` 确认存在

### 4. 「已经结算的 OpenAI 相关事件」

```json
{
  "keyword": "OpenAI",
  "closed": true,
  "limit": 20
}
```

参数：`{"title_search": "OpenAI", "closed": true, "limit": 20}`

### 5. 「所有活跃事件里排除选举标签（tag_id=144）」

```json
{
  "closed": false,
  "exclude_tag_ids": [
    144
  ]
}
```

参数：`{"closed": false, "exclude_tag_id": [144]}`

### 6. 「本周内结束、流动性 5 万以上的盘」

```json
{
  "closed": false,
  "end_before": "week_end",
  "liquidity": {
    "min": "5万"
  },
  "limit": 50
}
```

参数：`{"closed": false, "liquidity_min": 50000, "end_date_max": "2026-11-15T15:59:59Z", "limit": 50}`

### 7. 「标题里带 Trump、还没结算的前 50 个事件」

```json
{
  "keyword": "Trump",
  "closed": false,
  "limit": 50
}
```

参数：`{"title_search": "Trump", "closed": false, "limit": 50}`

### 8. 「首页精选事件」

```json
{
  "featured": true,
  "limit": 20
}
```

参数：`{"featured": true, "limit": 20}`

### 9. 「正在直播的体育比赛」

```json
{
  "tags": [
    "sports"
  ],
  "live": true
}
```

参数：`{"tag_slug": "sports", "live": true}`

⚠️ tag_slug=sports 未离线校验，建议先 `nlq.py tag-id --slug sports` 确认存在

### 10. 「2028 美国总统大选相关事件」

```json
{
  "tag_ids": [
    1101
  ],
  "limit": 20
}
```

参数：`{"limit": 20, "tag_id": [1101]}`

### 11. 「最近 24 小时成交最活跃的事件（按 volume24hr 降序）」

```json
{
  "order": "volume24hr",
  "ascending": false,
  "limit": 20
}
```

参数：`{"order": "volume24hr", "ascending": false, "limit": 20}`

### 12. 「价格已经到 0.9 以上的事件」

```json
{
  "limit": 20,
  "unsupported": [
    "0.9 以上价格不能服务端筛：取 markets[].bestBid/outcomePrices 客户端过滤"
  ]
}
```

参数：`{"limit": 20}`

### 13. 「持有人数超过 100 的市场」

```json
{
  "limit": 20,
  "unsupported": [
    "持有人数服务端没有该字段：需 data-api/holders 二次查询"
  ]
}
```

参数：`{"limit": 20}`

### 14. 「明天结束的未结算事件」

```json
{
  "closed": false,
  "end_before": "tomorrow_end",
  "end_after": "tomorrow_start"
}
```

参数：`{"closed": false, "end_date_min": "2026-11-10T16:00:00Z", "end_date_max": "2026-11-11T15:59:59Z"}`

### 15. 「本月开始的事件，按开始时间升序」

```json
{
  "start_after": "month_start",
  "order": "startDate",
  "ascending": true
}
```

参数：`{"start_date_min": "2026-10-31T16:00:00Z", "order": "startDate", "ascending": true}`

### 16. 「成交量在 1 万到 50 万之间的事件」

```json
{
  "volume": {
    "min": "1万",
    "max": "50万"
  },
  "limit": 50
}
```

参数：`{"volume_min": 10000, "volume_max": 500000, "limit": 50}`

### 17. 「只要未结算的，不要已结算的」

```json
{
  "closed": false
}
```

参数：`{"closed": false}`

### 18. 「某一场比赛的盘（game_id=12345）」

```json
{
  "game_id": [
    12345
  ]
}
```

参数：`{"game_id": [12345]}`

### 19. 「Parent 事件 999 下的子事件」

```json
{
  "parent_event_id": 999,
  "include_children": true
}
```

参数：`{"parent_event_id": 999, "include_children": true}`

### 20. 「标题含「特朗普」的事件」

```json
{
  "keyword": "特朗普"
}
```

参数：`{"title_search": "特朗普"}`

### 21. 「流动性最低的 20 个未结算事件」

```json
{
  "closed": false,
  "order": "liquidity",
  "ascending": true,
  "limit": 20
}
```

参数：`{"closed": false, "order": "liquidity", "ascending": true, "limit": 20}`

### 22. 「最新创建的事件」

```json
{
  "order": "createdAt",
  "ascending": false,
  "limit": 20
}
```

参数：`{"order": "createdAt", "ascending": false, "limit": 20}`

### 23. 「24 小时内就要结束的事件」

```json
{
  "closed": false,
  "end_before": "rel:+24h",
  "order": "endDate",
  "ascending": true
}
```

参数：`{"closed": false, "end_date_max": "2026-11-11T12:00:00Z", "order": "endDate", "ascending": true}`

### 24. 「精确查 slug 为 will-btc-reach-100k 的事件」

```json
{
  "slug": [
    "will-btc-reach-100k"
  ]
}
```

参数：`{"slug": ["will-btc-reach-100k"]}`

### 25. 「按 id 精确查两个事件」

```json
{
  "id": [
    30829,
    31552
  ]
}
```

参数：`{"id": [30829, 31552]}`

### 26. 「结算和未结算都要」

```json
{
  "closed": "any"
}
```

参数：`{"closed": "any"}`

### 27. 「中文界面的事件（locale=zh）」

```json
{
  "locale": "zh",
  "limit": 20
}
```

参数：`{"limit": 20, "locale": "zh"}`

### 28. 「24h 成交量低但流动性好的事件（客户端筛）」

```json
{
  "liquidity": {
    "min": "2万"
  },
  "unsupported": [
    "24h 成交量没有 *_min 参数；取 volume24hr 客户端过滤"
  ]
}
```

参数：`{"liquidity_min": 20000}`

### 29. 「体育盘里排除足球，成交量 1 万以上」

```json
{
  "tags": [
    "sports"
  ],
  "volume": {
    "min": "1万"
  },
  "limit": 50,
  "unsupported": [
    "排除足球需要 tag id：先 nlq.py tag-id --slug soccer"
  ]
}
```

参数：`{"tag_slug": "sports", "volume_min": 10000, "limit": 50}`

⚠️ tag_slug=sports 未离线校验，建议先 `nlq.py tag-id --slug sports` 确认存在

### 30. 「已结算、结束在 2026 年之内、按结束时间降序」

```json
{
  "closed": true,
  "end_after": "2026-01-01T00:00:00Z",
  "end_before": "2027-01-01T00:00:00Z",
  "order": "endDate",
  "ascending": false
}
```

参数：`{"closed": true, "end_date_min": "2026-01-01T00:00:00Z", "end_date_max": "2027-01-01T00:00:00Z", "order": "endDate", "ascending": false}`
