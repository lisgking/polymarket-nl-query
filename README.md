# polymarket-nl-query

中文/英文自然语言 → Polymarket Gamma `/events/keyset` 查询条件（参数 + URL + 可执行取数）。

这是一个 **Agent Skill**（DSH / Claude Code 等通用）：语义解析交给模型，参数校验、单位换算、时区换算、URL 渲染、游标翻页交给一个**零依赖** Node.js 脚本确定性执行。

```
「地缘政治 未来30天内 成交量100万以上的市场」
        ↓  模型读 SKILL.md 抽槽位
{"tag_ids":[100265],"closed":false,"volume":{"min":"100万"},"end_before":"rel:+30d"}
        ↓  bin/nlq.mjs 编译 + 校验
closed=false&volume_min=1000000&end_date_max=2026-12-10T14:18:13Z&limit=50&tag_id=100265
        ↓  自动游标翻页
events[] + next_cursor
```

## 安装

```bash
# 1. 放到 Agent 的 skills 目录
mkdir -p ~/.agents/skills
cp -R polymarket-nl-query ~/.agents/skills/

# 2. 离线自检（40 项单测）
node --test ~/.agents/skills/polymarket-nl-query/tests/nlq.test.mjs
```

要求：**Node.js ≥ 18**（零第三方依赖，无需 npm install）、`curl`（网络请求优先走它，支持 SOCKS）。

## 用法

在 agent 会话里直接说人话：

> 帮我找未来三天结束、成交量 50 万以上的加密盘，按结束时间排

或者命令行：

```bash
S=~/.agents/skills/polymarket-nl-query

# 意图 → 参数 + URL（离线、确定性、可复现）
node $S/bin/nlq.mjs build --intent '{"tags":["politics"],"closed":false,"volume":{"min":"100万"},"order":"volume","ascending":false,"limit":20}'

# 校验一段原生参数（会拦 offset、tag 重叠、非法枚举）
node $S/bin/nlq.mjs check --params '{"closed":"any","limit":200}'

# 标签 slug → id（需网络；拉 1 条带该标签的事件反查）
node $S/bin/nlq.mjs tag-id --slug geopolitics

# 实网取数：自动 next_cursor → after_cursor 翻页
node $S/bin/nlq.mjs fetch --intent '{"closed":false,"limit":5}' --max-pages 2

# 网络体检：DNS / 端口 / 直连 / 代理逐项诊断
node $S/bin/nlq.mjs doctor
```

## 能力边界（重要）

`/events/keyset` **只能**按这些维度在服务端筛：标签、`closed/live/featured`、事件级 `volume/liquidity`、`startDate/endDate/startTime`、标题关键词、系列/比赛/父子事件、id/slug。

以下**没有**查询参数，必须拿回结果后客户端二次过滤（skill 会显式提示，不会假装筛好了）：

- 24h 成交量（只能按 `volume24hr` 排序）
- 价格 / 概率 / spread
- 持有人数、前两大地址成交占比（要 `data-api`）
- 描述正文（`title_search` 只搜 title）

其他约束：`offset` 会直接 422；`limit` 上限 100；`next_cursor` 原样回传；响应很大（实测 2 条事件 ≈ 880KB）。

## 仓库结构

| 路径 | 内容 |
|---|---|
| `SKILL.md` | 技能规则：工作流、中文表达映射、时间/金额规则、422 对照、回复格式 |
| `bin/nlq.mjs` | 编译器：`build` / `check` / `fetch` / `tag-id` / `tags` / `schema` / `doctor`（Node ESM） |
| `references/params.md` | 40 个参数全表、422 清单、响应字段、与 `/events` 的差异 |
| `references/examples.md` | 30 条中文例句 → intent → 参数（可复现） |
| `tests/nlq.test.mjs` | 40 项离线单测 |
| `INSTALL.md` | 跨机器安装说明 |

## 网络

Polymarket 在国内需要代理。脚本按 `--proxy` > `PM_PROXY` > 自动探测（20220/20221/7890/7897/1080/10808/6152/8888）的顺序选择：

```bash
export PM_PROXY=http://127.0.0.1:7890   # 指定
export PM_PROXY=auto                     # 强制探测
export PM_PROXY=none                     # 强制直连（TUN 模式）
```

## License

MIT
