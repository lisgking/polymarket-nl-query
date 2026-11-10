# `/events/keyset` 参数全表（Gamma API）

- **端点**：`GET https://gamma-api.polymarket.com/events/keyset`
- **文档**：https://docs.polymarket.com/api-reference/events/list-events-keyset-pagination
- **认证**：无（公开只读）
- **来源**：2026-11 抓取的 OpenAPI（`/api-spec/gamma-openapi.yaml`，operationId `listEventsKeyset`）
- **返回**：`{ "$schema": ..., "events": [Event...], "next_cursor": "..." | 省略 }`

> 与 `/events`（offset 分页）的区别：keyset 端点**多**了 `title_search / live / start_time_* / game_id / event_date / event_week / featured_order / created_by / parent_event_id / include_children / partner_slug / include_best_lines / locale / series_id` 等参数，但**没有** `active / archived`，且**禁止** `offset`。

## 分页参数（只有 4 个）

| 参数 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `limit` | int | 1–100，默认 20 | 每页条数，**上限 100，不能靠调大它拿全量** |
| `order` | string | 合法 JSON 字段名，逗号分隔 | 排序字段；非法字段返回 **422** |
| `ascending` | bool | 默认 true | 仅在 `order` 存在时生效 |
| `after_cursor` | string | 不透明 token | 上一页响应里的 `next_cursor`，**原样回传**，不要 decode/构造 |
| ~~`offset`~~ | int | **禁止** | 传了直接 **422**：`offset is not allowed on keyset endpoints` |

翻页协议：`next_cursor` 只在「返回条数 == 有效 limit」时出现；最后一页**没有** `next_cursor`。所以停止条件 = 响应里没有 `next_cursor`，或返回 0 条。

## 标识 / 精确查

| 参数 | 类型 | 说明 |
|---|---|---|
| `id` | int[] | 按事件 id 精确查（可重复传多个） |
| `slug` | string[] | 按事件 slug 精确查 |
| `parent_event_id` | int | 父事件 id |
| `include_children` | bool | 带上子事件，通常配 `parent_event_id` |
| `series_id` | int[] | 系列 id（如「每周 NBA」这种 recurring 系列） |
| `game_id` | int[] | 体育比赛 id |
| `after_cursor` | string | 见上 |

## 状态

| 参数 | 类型 | 说明 |
|---|---|---|
| `closed` | bool \| `"any"` | `true`=已结算，`false`=未结算，`any`=两者都要。**非法值 422**。与 market 端点不同，事件端点的 `any` 不需要附加标识过滤 |
| `live` | bool | 直播/进行中（体育、游戏类） |
| `featured` | bool | 首页精选 |
| `cyom` | bool | Create Your Own Market（用户自建盘） |
| `event_week` | int | 体育/赛季周序号 |
| `featured_order` | bool | 精选排序 |
| `recurrence` | string | 重复周期（series 语义），非法值 422 |
| `tag_match` | string | 标签匹配模式 |
| `locale` | string | 返回内容的语言（如 `zh`），影响文案不影响筛选 |

## 数值筛选（都是**事件级聚合**，不是市场级）

| 参数 | 类型 | 说明 |
|---|---|---|
| `volume_min` / `volume_max` | number | 事件**累计**成交量（USD），单位美元 |
| `liquidity_min` / `liquidity_max` | number | 事件流动性 |

⚠️ 这是最容易踩的坑：接口**没有** `volume24hr_min`、`holders_min`、`spread_max`、`price_min/max`。
这些字段只在返回对象的嵌套 `markets[]` 里有（`volume24hr / spread / bestBid / bestAsk / outcomePrices`），必须**客户端二次过滤**，或者先筛事件、再调 `markets` / `data-api` 接口。

## 时间

| 参数 | 类型 | 含义 |
|---|---|---|
| `start_date_min` / `start_date_max` | date-time | 事件 `startDate` 区间 |
| `end_date_min` / `end_date_max` | date-time | 事件 `endDate` 区间（「什么时候结束」用这两个） |
| `start_time_min` / `start_time_max` | date-time | 事件 `startTime`（体育开赛时间语义） |
| `event_date` | date-time | 事件日期（日粒度，体育/日程类） |

时间格式：ISO 8601，带时区（`2026-11-17T12:00:00Z` 或 `+08:00`）。不带时区会按服务端解释，**不要依赖**。
语义（按字段名推断 + 实测）：`*_min` = 下界（≥），`*_max` = 上界（≤）。

## 标签

| 参数 | 类型 | 说明 |
|---|---|---|
| `tag_slug` | string | **单个**标签 slug，如 `politics` |
| `tag_id` | int[] | 多个标签 id |
| `exclude_tag_id` | int[] | 排除标签，**必须与 `tag_id` 不相交**，否则 422 |
| `related_tags` | bool | 是否连带相关/子标签 |

⚠️ 排除只能给 **id**，给不了 slug；多个标签也只能用 **id**。id 用 `bin/nlq.py tag-id --slug <slug>` 在线反查（拉 1 条带该标签的事件，从 `tags[]` 里读 id）。

已验证 id（来自真实事件 payload）：

| slug | id | 说明 |
|---|---|---|
| `politics` | 2 | 政治 |
| `elections` | 144 | 选举 |
| `united-states` | 165 | 美国 |
| `us-presidential-election` | 1101 | 美国总统大选 |
| `world-elections` | 101206 | 全球选举 |

其余品类（sports / crypto / economy / ai / geopolitics …）**先用 `nlq.py tag-id` 验证再用**，不要凭记忆写 id。

## 排序字段

文档只写「JSON 字段名」，非法字段 422。以下为已验证/常用安全集：

`id`、`volume`、`liquidity`、`startDate`、`endDate`、`createdAt`、`updatedAt`、`closedTime`、`volume24hr`、`competitive`、`commentCount`

多字段：`order=volume,liquidity`（逗号分隔，`ascending` 作用于全部字段）。

## 详情开关（只影响返回体积，不影响筛选）

| 参数 | 说明 |
|---|---|
| `include_chat` | 附带 Chats / Series.Chats |
| `include_template` | 附带 Templates |
| `include_best_lines` | 附带 BestLines |
| `partner_slug` | 设置后附带 `external_partners` |
| `include_children` | 附带子事件 |

⚠️ `series / tags / markets / eventCreators` **总是**返回，且嵌套 markets 带 `clob_rewards`、`fee_schedule`。实测 `limit=2` 的响应就有 **~880KB**。做批量抓取时：`limit` 别贪大（20–50 足够），必要时只取需要的字段，别把整包存库。

## 422 常见原因（排错清单）

| 现象 | 原因 |
|---|---|
| `offset is not allowed on keyset endpoints` | 传了 `offset` |
| 422 + cursor 相关 | `after_cursor` 被改写过、跨了不同 `order`/`limit` 的查询 |
| 422 + order 相关 | `order` 字段名不合法 |
| 422 + tag 相关 | `tag_id` 与 `exclude_tag_id` 有交集，或 tag id 不存在 |
| 422 + closed 相关 | `closed` 传了 `true/false/any` 之外的值 |
| 503 `keyset pagination is not configured` | 服务端未启用（重试/降级到 `/events`） |
| 500 | DB/cursor 编码失败，重试一次通常可恢复 |

## 响应里值得直接用的字段

| 字段 | 用途 |
|---|---|
| `events[].volume / liquidity` | 事件级体量 |
| `events[].volume24hr` | 24 小时量（**筛选靠它只能客户端**） |
| `events[].endDate / startDate / closed` | 时间与状态 |
| `events[].tags[]` | slug/id/label，做品类归一 |
| `events[].markets[]` | `clobTokenIds`（订阅/下单）、`bestBid/bestAsk`、`spread`、`outcomePrices`、`liquidityNum`、`volume24hr` |
| `next_cursor` | 只有它存在才继续翻页 |
