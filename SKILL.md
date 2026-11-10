---
name: polymarket-nl-query
description: 把中文/英文自然语言检索需求翻译成 Polymarket Gamma `/events/keyset` 查询条件（参数 + URL + 可执行取数）。当用户说「帮我找…的事件/盘口」「筛一批 Polymarket 市场」「按成交量/结束时间/品类查 event」，或需要 keyset 游标翻页取事件时使用。语义解析由 DSH 模型完成，参数校验/单位换算/时间换算/URL 渲染/翻页由本 skill 的零依赖脚本确定性执行，不调用任何外部模型。
---

# Polymarket 自然语言 → `/events/keyset` 查询条件

**目标接口**：`GET https://gamma-api.polymarket.com/events/keyset`（公开只读，无需 key）

> ## 一条铁律
> **语义解析你来做，参数渲染/校验/翻页交给 `bin/nlq.mjs`。**
> 禁止手写 URL 交付：任何查询必须先过 `nlq.mjs build`，让脚本负责单位/时区/枚举/422 校验。

---

## 一、硬流程（按顺序，不许跳）

1. **拆条件**：把用户那句话拆成「服务端能筛的」和「服务端筛不了的」（见 §五）。筛不了的写进 `unsupported`，不要硬塞成参数。
2. **填 intent JSON**：只许用 §三 的槽位，禁止把整句自然语言塞进去（`build` 会直接报错）。
3. **跑校验**：
   ```bash
   node ~/.agents/skills/polymarket-nl-query/bin/nlq.mjs build --intent '<JSON>'
   ```
   输出 `ok / params / url / summary / warnings / unsupported`。
4. **`ok=false` 就按 `errors` 改**：九成是槽位名写错、金额单位看不懂、标签要 id 却没给。
5. **要真数据**（可选，需要 VPN/代理）：
   ```bash
   PM_PROXY=http://127.0.0.1:20220 node .../nlq.mjs fetch --intent '<JSON>' --max-pages 2
   ```
   自动用 `next_cursor → after_cursor` 翻页，输出精简后的 events。
6. **回复用户**：一句人话总结 + 参数表 + URL + ⚠️警告（尤其客户端还要再过滤什么）。不要只甩一个 URL。

脚本路径：本 skill 目录下的 `bin/nlq.mjs`（默认安装位置 `~/.agents/skills/polymarket-nl-query/bin/nlq.mjs`）。零第三方依赖，Node ≥18，无需 npm install。

---

## 二、intent JSON 契约

```json
{
  "keyword": "OpenAI",
  "tags": ["politics"],
  "closed": false,
  "volume": {"min": "100万", "max": null},
  "liquidity": {"min": "5万"},
  "start_after": "rel:-7d",
  "end_before": "rel:+7d",
  "order": {"field": "volume", "direction": "desc"},
  "limit": 50,
  "unsupported": ["24h 成交量要客户端过滤"],
  "notes": ["可选的人类可读备注"]
}
```

允许的槽位：

| 槽位 | 类型 | 编译成 |
|---|---|---|
| `keyword` | string | `title_search`（只搜标题） |
| `tags` | string[] | 1 个 → `tag_slug` 或已知 id；多个 → `tag_id`（需已知 id） |
| `tag_ids` | int[] | `tag_id` |
| `exclude_tags` | string[] | `exclude_tag_id`（**必须能解析成 id**） |
| `exclude_tag_ids` | int[] | `exclude_tag_id` |
| `closed` | `false` / `true` / `"any"` | `closed` |
| `live` / `featured` / `cyom` | bool | 同名参数 |
| `volume` / `liquidity` | `{min,max}` | `volume_min/max`、`liquidity_min/max` |
| `start_after` / `start_before` | 时间 | `start_date_min/max` |
| `end_after` / `end_before` | 时间 | `end_date_min/max` |
| `event_date` | 时间 | `event_date` |
| `order` | string 或 `{field,direction}` | `order`（+`ascending`） |
| `ascending` | bool | `ascending` |
| `limit` | 1–100 | `limit`（超 100 自动截断并给 warning） |
| `after_cursor` | string | `after_cursor`（翻页用） |
| `series_id` `game_id` `parent_event_id` `include_children` `partner_slug` `include_chat` `include_template` `include_best_lines` `locale` `recurrence` `tag_match` `created_by` `event_week` `featured_order` `slug` `id` | 原生类型 | 同名参数直通 |
| `unsupported` | string[] | 不编译，原样回显：这些必须客户端二次过滤 |
| `notes` | string[] | 并进 `warnings` |

字段全表与约束见 `references/params.md`；30 条中文例句 → 参数见 `references/examples.md`。

---

## 三、中文表达 → 参数（高频映射）

| 用户说 | 参数 |
|---|---|
| 未结算 / 还开着 / 能下注 / 没结束 | `closed: false` |
| 已结算 / 已关闭 / 结束了 | `closed: true` |
| 结算不结算都要 / 全部 | `closed: "any"` |
| 正在直播 / 进行中 | `live: true` |
| 精选 / 首页推荐 | `featured: true` |
| 标题里有 X / 关于 X 的 | `keyword: "X"`（只搜 title；人名、机构名优先用它） |
| 体育 / 政治 / 加密 / 经济 / AI … | `tags: ["<slug>"]`（品类见 §六） |
| 不要体育 / 排除加密 | `exclude_tag_ids: [<id>]`（**必须 id**，先 `tag-id` 解析） |
| 成交量 100 万以上 | `volume.min: "100万"` |
| 成交量 1 万到 50 万 | `volume: {min:"1万", max:"50万"}` |
| 流动性好 / 流动性 > 5 万 | `liquidity.min: "5万"` |
| 最近 7 天新开的 | `start_after: "rel:-7d"` |
| 未来一周结束的 | `end_before: "rel:+7d"` + `closed: false` |
| 24 小时内就要结束的 | `end_before: "rel:+24h"` + `closed: false` + `order: endDate` 升序 |
| 本周结束的 | `end_before: "week_end"`（周四就「本周」→ 仍是本周日 23:59） |
| 明天结束的 | `end_after:"tomorrow_start"`, `end_before:"tomorrow_end"` |
| 本月开始的 | `start_after: "month_start"` |
| 成交量最高 / 最热 | `order: {field:"volume", direction:"desc"}` |
| 最新创建 | `order: {field:"createdAt", direction:"desc"}` |
| 最快结束 / 快截止 | `order: {field:"endDate", direction:"asc"}` |
| 流动性最差 | `order: {field:"liquidity", direction:"asc"}` |
| 前 50 个 / 取 20 条 | `limit: 50`（≤100） |
| 下一页 / 继续 | `after_cursor: "<上次的 next_cursor>"` |
| 某场比赛 | `game_id: [id]`（需用户给 id） |
| 某个 series 的下一期 | `series_id: [id]` |
| 子事件 | `parent_event_id: id` + `include_children: true` |
| 精确某条 | `slug: ["..."]` 或 `id: [123]` |

---

## 四、时间规则（默认时区 `Asia/Shanghai`）

- **一律用 `nlq.mjs` 的时间令牌，不要自己心算日期**：`now`、`today_start`、`today_end`、`tomorrow_start`、`tomorrow_end`、`week_start`、`week_end`、`month_start`、`month_end`、`year_start`、`year_end`；相对量用 `rel:-7d` / `rel:+3h` / `rel:-2mo` / `rel:+1y`（`mo`=月，`min`=分钟；不要写裸 `m`）。
- 用户说「今天/今晚」按**用户本地日界**（默认 Asia/Shanghai），脚本自动换算成 UTC 秒级 `...Z` 输出。
- 精确日期直接用 ISO：`2026-11-17T00:00:00Z` 或 `2026-11-17T08:00:00+08:00`。
- 需要可复现/对账时加 `--now 2026-11-10T12:00:00Z` 冻结基准时间。
- 语义：`end_*` 是事件结束时间；`start_*` 是开始时间；`start_time_*` 是开赛时间；`event_date` 是日程日粒度。用户说「什么时候开」用 `start_*`，「什么时候结束/截止」用 `end_*`。

---

## 五、服务端**筛不了**的东西（必须告诉用户 + 客户端二次过滤）

这些字段只在返回的嵌套 `markets[]` 里，接口没有对应的 `_min/_max` 查询参数：

| 用户想要 | 现实 |
|---|---|
| 24h 成交量筛选 | 只能 `order=volume24hr` 排序；筛选要客户端按 `markets[].volume24hr` 过滤 |
| 价格 / 概率 / 0.9 以上 | 无参；客户端按 `bestBid/bestAsk/outcomePrices` 过滤 |
| 价差 spread | 无参；客户端 `markets[].spread` |
| 持有人数 / 独立交易者 | 无参；需 `data-api/holders?market=` 二次查询 |
| 前两大地址成交占比 / 机器人识别 | 无参；需 `data-api/trades?market=` 聚合 |
| PnL / 聪明钱 | 不在 gamma；在 `data-api` 榜单/自己重放 |
| 搜索描述正文 | `title_search` 只搜 title，不搜 description |
| 事件级 vs 市场级金额 | `volume/liquidity` 是**事件**聚合，不是某个 outcome 的 |

把这些写进 intent 的 `unsupported`，`build` 会原样回显到输出；回复时明确说「这句已经查了，那句要二次过滤」。

---

## 六、标签（tag）规则

1. **单个**标签 → `tags: ["politics"]`，脚本能用 slug 就用 slug。
2. **多个**标签、**排除**标签 → 必须 id：
   ```bash
   node .../nlq.mjs tag-id --slug sports --slug soccer
   ```
   原理：拉 1 条带该 slug 的事件，从 `events[].tags[]` 里反查 id，比枚举全量标签快。
3. 已验证 id：`politics=2`、`elections=144`、`united-states=165`、`us-presidential-election=1101`、`world-elections=101206`。
4. 中文品类候选（**未离线验证**，用前必须 `tag-id` 确认）：体育→`sports`、足球→`soccer`、篮球→`nba`、政治→`politics`、选举→`elections`、加密→`crypto`、比特币→`bitcoin`、经济→`economy`、金融→`business`、科技→`tech`、AI→`ai`、地缘→`geopolitics`、中东→`middle-east`、俄乌→`ukraine`、文化→`pop-culture`、科学→`science`、气候→`climate`、健康→`health`。
5. 解析不出来（无网络 / slug 不存在）→ 别猜 id，退化成 `keyword`（title_search），并在回复里说明「品类没锁死，用关键词近似」。
6. 中文标签可能不存在，tag slug 基本都是英文；用户说中文品类时不要直接 `tag_slug: "体育"`。

---

## 七、翻页（keyset）

- 起始请求**不带** `after_cursor`；之后每次把响应里的 `next_cursor` **原样**放进 `after_cursor`。
- 停止条件：响应**没有** `next_cursor`（或 events 为空）。
- **禁止 `offset`**（直接 422）；**禁止**自己拼 cursor。
- `limit` 上限 100；要全量就多翻几页，不要指望一次拉完。
- 响应很大（嵌套 markets/tags/series，实测 2 条 ≈ 880KB）：批量抓取时 `limit` 取 20–50，只落需要的字段。
- 用脚本翻页最稳：
  ```bash
  node .../nlq.mjs fetch --url '<build 出来的 url>' --max-pages 5 --compact
  ```

---

## 八、422 / 报错对照

| 返回 | 原因 | 修法 |
|---|---|---|
| `offset is not allowed on keyset endpoints` | 传了 offset | 删掉，用 `after_cursor` |
| 422 cursor | cursor 被改写 / 换了 order、limit 再用 | 用同一套参数连续翻页 |
| 422 order | 字段名非法 | 只用安全集：`volume/liquidity/endDate/startDate/createdAt/updatedAt/closedTime/volume24hr/id` |
| 422 tag | tag_id 与 exclude_tag_id 相交 / id 不存在 | 去重，`tag-id` 复核 |
| 422 closed | 不是 true/false/any | 用字面量 `"any"` |
| 503 `keyset pagination is not configured` | 服务端未启用 | 重试，或退 `/events` |
| 500 | cursor 编码/DB 抖动 | 重试一次 |

网络（Polymarket 在国内需要代理）：

1. 先跑体检：`node .../nlq.mjs doctor` —— 逐项检查 DNS / TCP 443 / 本地代理端口 / 直连 / 代理连通性，并给修复建议；
2. 代理选择顺序：`--proxy` 参数 > `PM_PROXY` 环境变量 > 自动探测（20220、20221(SOCKS)、7890、7891、7897、1080、10808、6152、8888，逐个 TCP 试探）；
3. 传输优先用 `curl`（支持 `http://` 和 `socks5h://`），失败再回退 Node 内置 fetch（仅直连）；不要自己写死代理地址；
4. `PM_PROXY=none` 强制直连；`PM_PROXY=auto` 强制自动探测；
5. `fetch` 失败时先看 `doctor` 的 FAIL 项，不要无脑重试——端口没监听 = VPN 没开，端口通但 56/超时 = 节点不通或端口填错。

---

## 九、回复用户的格式

```markdown
**查询条件**（已通过 nlq.mjs 校验）
| 参数 | 值 | 含义 |
|---|---|---|
| closed | false | 只看未结算 |
| volume_min | 1000000 | 事件累计成交量 ≥ $100 万 |
| order / ascending | volume / false | 按成交量降序 |
| limit | 50 | 每页 50 条 |

**URL**
`https://gamma-api.polymarket.com/events/keyset?...`

**要说明的**
- ⚠️ 24h 成交量接口筛不了，拿到结果后按 markets[].volume24hr 客户端过滤。
- 要拿第 2 页：把响应里的 next_cursor 原样传给 after_cursor。
```

参数多时给表格，参数少时直接一行 `closed=false&volume_min=1000000` 也行。**必须**带「客户端还要过滤什么」和「翻页怎么做」。

---

## 十、禁止事项

- ❌ 手写 URL 直接交付（未经 `build` 校验）。
- ❌ intent 里塞自然语言（如 `{"query": "找体育盘"}`）→ `build` 会报未知槽位。
- ❌ 编造 tag id / 排序字段名 / 不存在的参数（如 `volume24hr_min`）→ 上游 422 或静默无效。
- ❌ 把 `unsupported` 里的条件硬塞进参数。
- ❌ 用 `offset` 翻页。
- ❌ 把「品类没锁死」说成「已经筛好」。

---

## 十一、命令速查

```bash
S=~/.agents/skills/polymarket-nl-query

# 参数表 / 槽位 / 标签字典 / 中文品类候选
node $S/bin/nlq.mjs schema

# 意图 → 参数 + URL（离线、确定性）
node $S/bin/nlq.mjs build --intent '{"tags":["politics"],"closed":false,"volume":{"min":"100万"},"order":"volume","ascending":false,"limit":20}'
node $S/bin/nlq.mjs build --intent-file /tmp/intent.json --now 2026-11-10T12:00:00Z

# 校验一段原生参数
node $S/bin/nlq.mjs check --params '{"closed":"any","limit":200}'

# 标签 slug → id（需网络）
PM_PROXY=http://127.0.0.1:20220 node $S/bin/nlq.mjs tag-id --slug sports --slug soccer

# 真取数：自动游标翻页（需网络）
PM_PROXY=http://127.0.0.1:20220 node $S/bin/nlq.mjs fetch --intent '{"closed":false,"limit":5}' --max-pages 2

# 网络体检（VPN/代理是否可用）
node $S/bin/nlq.mjs doctor

# 自检（40 项离线单测）
node --test $S/tests/nlq.test.mjs
```

## 文件

| 文件 | 内容 |
|---|---|
| `bin/nlq.mjs` | 编译器：build / check / fetch / tag-id / tags / schema（零依赖） |
| `references/params.md` | 40 个参数全表、422 清单、响应字段、与 `/events` 的差异 |
| `references/examples.md` | 30 条中文例句 → intent → 参数（可复现） |
| `tests/nlq.test.mjs` | 40 项离线单测（金额/时间/构建/校验/schema） |
