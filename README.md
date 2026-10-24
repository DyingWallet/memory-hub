# memory-hub

本机记忆服务 `memd` + 两个 DSH 插件 + QQ 桥接 / 桌宠适配器。让 DSH 主会话、QQ 桥接和桌宠读同一份文本记忆：关键词检索（FTS5），可选语义检索（本地 embedding + sqlite-vec），隐私按 scope 在 SQL 层隔离。

- 协议：`/v1` HTTP（JSON），OpenAPI 在 [`packages/protocol/openapi.yaml`](packages/protocol/openapi.yaml)
- **DSH 版本支持**：目前仅在 DSH 桌面版 **0.2.1-rc.3** 上验证（MCP server 与两个插件的加载契约、`webServer.register` 形态都按这个版本测过）；其它版本未验证，升级后先跑 `node scripts\doctor.mjs`。
- 数据：`D:\deepseek_workspace\memories\`（Markdown + `facts/*.jsonl`），索引在 `data/index.db`，可重建
- 检索：`node:sqlite` FTS5 + 中文 bigram；默认 5 条，弱结果降到 OR、最多 10 条；语义可用时做混合排序
- 运行时：**工作区便携版 Node** `..\tools\node\node.exe`（`pnpm fetch:node` 安装，版本写在 `tools\node\VERSION`）；没有时回落到 DSH 自带 node。独立一份的原因：memd / pet-llm / 桥接都是常驻进程，跑 DSH 自带的 `node.exe` 会锁住 DSH 安装目录，升级时安装器改名失败（`WinError 32`）。细节见 [`../tools/README.md`](../tools/README.md)。
- 监听：**当前只绑 `127.0.0.1:8787`**（多设备经 ZeroTier 访问暂缓，原因见 RUNBOOK §1）

## 快速开始

一条命令装完（幂等；**普通 PowerShell 窗口**，`~/.dsh` 对沙箱只读）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-all.ps1
# → 重启一次 DSH → 再跑 -Check 应该全绿
```

script 依次做：构建 → MCP 注册 + root 令牌（存在且有效就复用）→ `dsh-memory` → `dsh-memory-panel` →（可选）看护任务 →（可选）语义检索 → 写安装戳 → 自检。

| 开关 | 作用 |
|---|---|
| `-WithAutostart` | 顺带注册 `memd-watchdog`（每分钟）和 pet 的 `pet-revive` |
| `-Semantic` | 下模型 + 打开 `semantic.enabled` + 回填向量 |
| `-Check` | 只跑自检（= `node scripts\doctor.mjs`） |
| `-Uninstall` | 反向卸载（MCP + 两个插件 + 任务） |
| `-SkipBuild` | 复用现有构建 |

服务本身（不走 DSH 时）：

```powershell
pnpm start                 # 起 memd（127.0.0.1:8787）
node packages\admin\dist\cli.js health
```

首次启动若没有 `config.json`，`scripts/start.ps1` 会从 `config.example.json` 复制一份。

## 部署与自检

```powershell
node scripts\doctor.mjs            # 17 项：核心 11 + 提示 6
node scripts\doctor.mjs --json     # { ready, checks[] }
node scripts\doctor.mjs --shallow  # 跳过披露探针（只查文件，不发请求）
```

- **重启后验证**：插件 `apply()` 时写 `data/plugin-load/<name>.json`，doctor 与 `data/setup-stamp.json` 比时间——「装了但没重启」会显示 `FAIL … 需要重启 DSH`。
- **升级 DSH 之后**：`powershell -ExecutionPolicy Bypass -File scripts\post-upgrade.ps1`（检查 memd / doctor / pet-llm / 桥接四处，一处挂就红）。
- **启动自检**：`dsh-memory-panel` 加载 8 秒后自动跑一遍 doctor，写 `logs/doctor-boot.log`（每次启动一行）与 `data/doctor-last.json`；`MEMD_BOOT_CHECK=0` 可关。
- 细节与失败对照表见 [`docs/RUNBOOK.md`](docs/RUNBOOK.md) 与 [`../memories/50-knowledge/2026-10-24-memory-hub-deploy-from-zero.md`](../memories/50-knowledge/2026-10-24-memory-hub-deploy-from-zero.md)。

## 结构

```text
memory-hub/
  packages/
    protocol/     TypeBox schema → JSON Schema / OpenAPI，路由表（唯一契约源）
    core/         tokenize（bigram）、chunk、frontmatter、policy（纯函数）
    server/       Fastify 路由、SQLite FTS5 索引、鉴权、审计、可见性 SQL、语义索引
    sdk/          类型化 HTTP 客户端
    adapter-dsh/  MCP stdio server + bootstrap 注入文本
    adapter-qq/   给 QQ 桥接用的零依赖客户端（编译成 dist/memory-client.mjs）
    admin/        token 签发/吊销、reindex、health、social-v2 导入
  tests/          unit / integration / privacy / contract / mcp / plugin
  scripts/        setup-all.ps1 · doctor.mjs · start.ps1 · stop.ps1 · supervisor.mjs
                  install-autostart.ps1 · issue-qq-tokens.mjs · fetch-model.mjs · embed.mjs
                  set-semantic.mjs · verify-recall.mjs · backup.mjs · monitor.mjs
  plugins/
    dsh-memory/         DSH host 插件：全会话消息 → /v1/ingest（短期记忆）
    dsh-memory-panel/   设置页 + 同源代理（零配置：宿主注入 root 令牌）
  docs/           RUNBOOK.md / PLAN.md / TODO.md / SPIKE-DSH.md / HANDOFF.md …
```

## 语义检索（可选）

本地跑 `bge-small-zh-v1.5`（int8 ONNX，512 维），向量存 sqlite-vec 的 `vec0` 表；检索时 FTS 与向量**并行**召回再融合（`score = α·norm(bm25) + (1-α)·cos`，默认 α=0.5）。

```powershell
pnpm fetch:model        # 从 ModelScope 下模型到 models/（约 24 MB，gitignore）
pnpm semantic:on        # 原子改 config.semantic.enabled
pnpm embed              # 回填向量
```

- 默认**关闭**；设置页可勾选开关（热切换，不装任何东西）。
- 基准：短查询 embedding p50 0.5–0.6 ms，KNN 800×512 p50 0.2 ms，约 800 chunk 回填 5.3 s @1 线程 / 2.2 s @4 线程。
- 内存：`batchSize ≤ 8`、`maxLen ≤ 256` 时 RSS 150–250 MB；`batch 32 × maxLen 512` 会到 1.7 GB，别这么配。
- 参数在 `config.semantic`：`enabled / alpha / modelDir / modelFile / vocabFile / dim / maxLen / batchSize / threads / backfillThreads / maxCandidates`。

## 隐私模型（一句话版）

- 星形拓扑：你在中心；群和第三人彼此不可见；主会话和你的 QQ 私聊可见全部。
- token 绑定 `surface` + `scopes` + `scenes`；`scene` 由客户端传但必须落在 token 允许的场景里，模型不能自己扩权。
- 可见性在 SQL 里过滤（`packages/server/src/visibility.ts`），不是取回后再删；`core/policy.ts` 的 `canRead` 是同一规则的纯函数镜像，隐私测试两边都测。
- 只有两条轴：**audience**（在哪些场景）和**一个敏感位**（`privacy=sensitive`）。敏感记忆钉在 `sensitiveAudiences`，读取需要 token 带 `sensitive:read`；`secret` 不通过 API 写入、任何视图都读不到。
- QQ 桥接每个场景用独立 token（group / owner / 每个私聊各一个），未映射的场景没有回退。
- **主人主动提起**：桥接标记 `from_owner` 后，该场景可临时读到 owner 本人的 `ownerAudiences` 记忆；敏感、其他人的私聊、`secret` 仍不放开。
- **跨场景披露**（`POST /v1/disclose`）：群友在私聊问「刚才群里聊了什么」时，桥接先校验他是该群成员（持久化成员表，`group_increase`/`group_decrease` 事件维护 + 每日对账 + fail-closed），通过后才用 `disclose:group` 令牌读**那一个群**的 `chat`/`note`、`normal`/`personal` 消息。敏感、`secret`、其它群、私聊永不包含；每次披露写审计（`group` + `requester_hash`）。

## 主要接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/health` | 存活 + 索引统计（唯一免鉴权） |
| GET | `/v1/capabilities` | 工具、限额、feature 开关 |
| GET | `/v1/config-schema` | 设置页 JSON Schema |
| GET | `/v1/config-state` | 读取可编辑配置（root） |
| POST | `/v1/config` | 更新白名单配置（root，热生效） |
| GET | `/v1/tokens` | 令牌元数据（root） |
| POST | `/v1/tokens/revoke` | 吊销一个 token（root；签发仍在 CLI） |
| POST | `/v1/bootstrap` | 身份 + 受众脸 + 最近标题 |
| POST | `/v1/search` | 关键词检索（语义可用时混合） |
| POST | `/v1/get` | 取一条（chunk id 或 doc id） |
| POST | `/v1/recent` | 最近记忆 |
| POST | `/v1/recall` | 按最近对话召回 2–3 条 |
| POST | `/v1/disclose` | 跨场景披露：一个群的最近消息（`disclose:group`） |
| POST | `/v1/write` | 追加一条事实并索引 |
| POST | `/v1/forget` | 忘记一条（JSONL 留 tombstone） |
| POST | `/v1/ingest` | 普通聊天入库为短期记忆（TTL） |
| POST | `/v1/review` | 待回顾的短期记忆 |
| POST | `/v1/persist` | 短期转长期（可带蒸馏 note） |
| POST | `/v1/audience` | 读受众卡 |

## 测试

```powershell
pnpm test     # 144 项
```

- 单测（tokenize / chunk / frontmatter / policy / token 热重载 / 可见性 / 混合排序 / 语义纯函数 / 面板冒烟）
- 集成（临时目录 + 真 SQLite + `app.inject`：recall 作用域、披露、配置热更新）
- 隐私矩阵（群搜工作=0、群 get owner=404、私聊互不可见、伪造 scene=403、`secret` 全隐藏、披露不串场景）
- 契约（路由 ↔ OpenAPI 一致）、MCP 工具（InMemoryTransport）、DSH 插件
- 沙箱里跑 `node --test` 需要 `--test-isolation=none`（脚本里已带）

## 状态

v2 已落地：语义检索（可选）、设置页（零配置令牌）、跨场景披露、一键部署 + 自检、
重启后验证与启动自检。2026-10-24 实测：144 项测试通过，部署链 `setup-all.ps1` 端到端跑通，
两个插件在 DSH 重启后加载标记到位。细节见 [`docs/RUNBOOK.md`](docs/RUNBOOK.md)。
