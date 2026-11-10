# 安装到别的电脑

这是一个**零依赖**的 Agent Skill 目录：纯 Python 标准库 + 一个 `SKILL.md`。没有账号、没有 key、没有编译产物。

## 需要什么

| 依赖 | 要求 | 说明 |
|---|---|---|
| Python | ≥ 3.9 | 只用标准库（`zoneinfo`/`urllib`/`socket`），无需 pip install |
| curl | 建议有 | 网络请求优先走 curl（支持 `http://` 和 `socks5h://` 代理）；没有则回退 Python urllib |
| 网络 | Polymarket 可访问 | 国内需代理/VPN；脚本会自动探测常见本地端口，也可用 `PM_PROXY` 指定 |

## 安装（3 步）

1. 把整个 `polymarket-nl-query/` 目录拷到目标机器的 skills 目录：

   ```bash
   # DSH
   mkdir -p ~/.agents/skills
   cp -R polymarket-nl-query ~/.agents/skills/

   # Claude Code（如果目标机器用的是它）
   # mkdir -p ~/.claude/skills && cp -R polymarket-nl-query ~/.claude/skills/
   ```

2. 自检（离线，必须全绿）：

   ```bash
   python3 ~/.agents/skills/polymarket-nl-query/tests/test_nlq.py     # 38 项
   python3 ~/.agents/skills/polymarket-nl-query/bin/nlq.py schema      # 参数表
   ```

3. 新开一个 DSH 会话，技能列表里应出现 `polymarket-nl-query`（目录被扫描即生效）。

## 验证网络（可选）

```bash
python3 ~/.agents/skills/polymarket-nl-query/bin/nlq.py doctor
```

`doctor` 会逐项打印 DNS / TCP 443 / 本地代理端口 / 直连 / 代理连通性，并给修复建议。

代理端口不是 20220 时：

```bash
export PM_PROXY=http://127.0.0.1:7890        # 或 socks5h://127.0.0.1:7891
export PM_PROXY=auto                          # 强制自动探测
export PM_PROXY=none                          # 强制直连（TUN 模式/VPN 全局路由时用）
```

macOS / Linux / Windows 通用：脚本里没有硬编码路径，只有默认代理地址 `http://127.0.0.1:20220`（可用 `PM_PROXY` 覆盖）。Windows 上用 `python` 代替 `python3`。

## 拷什么

```
polymarket-nl-query/
├── SKILL.md              # 规则（模型读）
├── bin/nlq.py            # 编译器（脚本）
├── references/params.md  # 40 个参数全表
├── references/examples.md# 30 条中文例句 → 参数
├── tests/test_nlq.py     # 38 项离线单测
└── INSTALL.md            # 本文件
```

`bin/nlq.py`、`SKILL.md`、`references/*`、`tests/*` 就是全部；`__pycache__` 不用拷。

## 注意

- **不要**把 VPN 账号/节点写进技能目录；
- 技能内的标签 id 字典只含 5 个已验证 id（politics/elections/united-states/us-presidential-election/world-elections），其余品类用 `nlq.py tag-id --slug <slug>` 现场解析（需要网络）；
- 参数表对应 2026-11 的 Gamma API；上游改参数时更新 `references/params.md` 和 `bin/nlq.py` 的 `PARAM_SPEC` 即可（两处是唯一事实来源）。
