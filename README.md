# memory-hub

本机优先的记忆服务：`memd`（HTTP + SQLite）+ 两个 DSH 插件 + QQ 桥接 / 桌宠适配器。

目标只有一个：**让 DSH 主会话、QQ 桥接、桌宠读同一份文本记忆，并且各自只看得到该看的部分。**
记忆以 Markdown 和 append-only JSONL 落盘，索引随时可以从文件重建；不需要数据库服务，也不需要把记忆交给任何云。

- 协议：`/v1` HTTP（JSON），OpenAPI 见 [`packages/protocol/openapi.yaml`](packages/protocol/openapi.yaml)
- 接口：20 个 `/v1` 路由，路由表是唯一契约源（`packages/protocol/src/openapi.ts`）
- 测试：`pnpm test` **190 项**（单测 / 集成 / 隐私矩阵 / 契约 / MCP / 插件）
- DSH 版本：**0.2.1-rc.2 / 0.2.1-rc.3 已验证**（MCP server、两个插件的加载契约、`webServer.register`、`session/*` RPC）；其它版本未验证，升级后先跑 `node scripts\doctor.mjs`
- 运行时：**工作区便携版 Node** `..\tools\node\node.exe`（`pnpm fetch:node` 安装）。memd / pet-llm / 桥接都是常驻进程，跑 DSH 自带的 `node.exe` 会锁住安装目录，升级时安装器改名失败（`WinError 32`）。细节见 [`../tools/README.md`](../tools/README.md)
- 监听：默认只绑 `127.0.0.1:8787`
- 数据：`../memories/`（Markdown + `facts/*.jsonl`），索引 `data/index.db` 可重建

## 它解决什么问题

一句话：**Agent 每开一个新会话就从零开始，而记忆又不能全塞进上下文。**

所以分成三条路径——常驻的少量事实、按需检索的长期证据、会自动过期的近期聊天：

| 形态 | 存在哪 | 怎么进入上下文 |
|---|---|---|
| 长期事实 / 文档 | `memories/**/*.md`、`facts/*.jsonl` | 检索到才给，`/v1/search`、`/v1/recall`、`/v1/timeline` |
| 短期聊天 | 同一份 JSONL，`stage=short` + TTL | 24 小时内可召回，过期自动失效 |
| 身份与受众 | `memories/user/identity.md`、`memories/audiences/`（可选） | `/v1/bootstrap` 拉取（MCP 工具 `memory_bootstrap`），会话启动时给一次 |
| 最近记得的事 | 同一份 JSONL 的最近 8 条长期记忆 | 每次唤醒追加一次（`/v1/recent`，10 分钟缓存），补「召回按 query 命中、跑题就空」的盲区 |

## 快速开始

一条命令装完（幂等；**普通 PowerShell 窗口**，`~/.dsh` 对沙箱只读）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-all.ps1
# → 重启一次 DSH → 再跑 -Check 应该全绿
```

依次做：构建 → MCP 注册 + root 令牌（存在且有效就复用）→ `dsh-memory` → `dsh-memory-panel` →（可选）看护任务 →（可选）语义检索 → 写安装戳 → 自检。

| 开关 | 作用 |
|---|---|
| `-WithAutostart` | 顺带注册 `memd-watchdog`（每分钟）和 pet 的 `pet-revive` |
| `-Semantic` | 下模型 + 打开 `semantic.enabled` + 回填向量 |
| `-Check` | 只跑自检（= `node scripts\doctor.mjs`） |
| `-Uninstall` | 反向卸载（MCP + 两个插件 + 任务） |
| `-SkipBuild` | 复用现有构建 |

只起服务、不接 DSH 时：

```powershell
pnpm start                                 # memd → 127.0.0.1:8787
node packages\admin\dist\cli.js health
```

没有 `config.json` 时，`scripts/start.ps1` 会从 `config.example.json` 复制一份。

## 架构

```text
                    ┌──────────────── DSH 主会话 ────────────────┐
                    │  MCP stdio server（9 个工具，root 令牌）    │
                    │  dsh-memory 插件：全会话消息 → /v1/ingest   │
                    │  dsh-memory-panel：设置页 + 同源代理         │
                    └──────────────────┬─────────────────────────┘
 QQ 桥接 ── 逐场景令牌 ──┐                │
 桌宠 pet-llm ─ 独立令牌 ─┼── HTTP ───► memd（Fastify, 127.0.0.1:8787）
                         │                │
                         │       ┌────────┴────────┐
                         │   SQLite 索引        搜索/召回/时间线
                         │   （FTS5 + 可选 vec）  隐私过滤在 SQL 里
                         │                │
                         └────────►  memories/（Markdown + JSONL，append-only）
```

- **索引是派生物**：`data/index.db` 随时删除重建，备份里不含它。
- **append-only**：遗忘写 tombstone，不物理改写历史；索引重建时 tombstone 生效。
- **过滤在 SQL 层**：群令牌的查询根本不会把 owner 或敏感行载入内存，不是取回后再删（`packages/server/src/visibility.ts`）。
- **夜间整理**：`supervisor.mjs` 每天 `config.sleep.at`（默认 03:00）跑一次 `sleep-consolidate.mjs`——它唤起一个 `sleep-consolidator` preset 的 DSH 会话（同 workspace、同 `AGENTS.md`，只有 read/glob/grep + MCP 记忆工具，没有 shell），把当天记忆交给它整理，写回走普通 `memory_write` / `memory_forget`。

## 检索

四段，按请求进入的顺序：

1. **分词**：中文按 bigram 切开，拉丁词与数字保留，`extractKeywords` 去停用词。
2. **两趟 FTS**：先 AND（精确），结果太弱再降级 OR；两趟都跑完后在 JS 里重排（bm25 不懂标题与新鲜度）。
3. **两处修正**：
   - **长口语查询的覆盖度加分**——整句口语（token > 6）AND 必然失败、OR 之后 bm25 偏爱短文本，所以按「高信号 token 命中比例」补刀（`COVERAGE_BOOST = 6.0`，短查询不受影响）。
   - **短期降权**——返回前按 `score × stage` 权重重排，`searchShortWeight` 默认 `0.5`，让长期记忆不被大量聊天碎片挤走。
4. **语义（可选）**：本地 `bge-small-zh-v1.5`（int8 ONNX，512 维）写入 sqlite-vec 的 `vec0` 表，与 FTS **RRF 融合**（倒数排名，`RRF_K = 60`）；`alpha` 只是两路各贡献多少比例，不再拿裸分相加。

默认取 5 条、最多 10 条；`searchShortWeight = 1` 关闭降权。

> **加权模型（未实现）**：[`docs/MEMORY-WEIGHTING.md`](docs/MEMORY-WEIGHTING.md) 定义了相关分之外的四个因子——重要性、紧迫性、使用强度、未闭合——以及它们如何互相影响。当前检索只有「相关 + stage 降权」，这些还没接。

## 记忆生命周期

```text
对话 ──/v1/ingest──► short（TTL 24h，可召回延长，封顶 168h）
                        │  到期：purge 只删索引，JSONL 保留原文
                        │  整理（每天一次，见架构那节）：agent 读当天 short + long，
                        │    用 memory_write 新增 / supersedes 改写 / memory_forget 撤回
                        └──► long（写同 id 的 stage=long 行，reindex 后覆盖）
                                 │
                            /v1/forget → tombstone（deleted:true）
                                 │
                            归档（可选，默认关）：更老月份压 gzip，索引透明读回
```

- **回顾**：原来的 `/v1/review` → `/v1/persist` 这条链**已移除**（2026-10-28）——短期转长期现在只有夜间整理一条路，`review:pending` 也不再写。
- **夜间整理**：见上面架构那节；`config.sleep.enabled` 默认关，开了之后每天一次，失败按 `retryMinutes` 退避，当天成功过就不再触发。
- **去重**：同 `scene + kind + 规范化文本 + audience + privacy + subject` 复用 id；转长期时按 CJK bigram / Jaccard ≥ 0.8 折叠。
- **`subject`**：`owner`（默认）/ `self`（我自己的判断）/ `other`。去重键包含它，所以「我认为 X」和「他说 X」是两条。
- **时间线**：`/v1/timeline` 按月倒出，`supersedes` / `superseded_by` 双向标出「改过主意」；满页返回 `next_before` 当翻页游标。

## 隐私与可见性

两条轴，没有第三种：

- **audience**：记忆住在哪个场景（`main`、`qq:owner`、`qq:group:<id>`、`qq:private:<id>`、`pet`、`shared`）。
- **一个敏感位**：`normal` / `personal` / `sensitive` / `secret`。敏感记忆钉在 `sensitiveAudiences`，读它需要令牌带 `sensitive:read`。
- **`secret`**：读写各要一个 scope（`secret:read` / `secret:write`），root 令牌两者兼备，audience 钉在 `secretAudiences`（默认 `main`）。群、第三人私聊、pet 的令牌都不带这两个 scope，读不到。**它不是加密存储**：明文落盘、进备份、append-only 不可删，写进去就永远在磁盘上。

令牌 = `surface + scopes + scenes`：

| 令牌 | scopes | scenes | 实际能读 |
|---|---|---|---|
| `dsh-desktop`（MCP） | `*` + `sensitive:read` | `main` | 全库（含 `secret`） |
| `qq-owner` | `*` | `qq:owner` | 全库（含 `secret`），但只能在该场景 |
| `pet` | `main` / `qq:owner` / `pet` | 三个场景 | 仅这三类 |
| `qq-group-*` | 只含本群 | 本群 | 本群 |
| `qq-private-*` | 只含该私聊 | 该私聊 | 该私聊 |
| `qq-disclose` | `disclose:group` | `qq:bridge` | 一次披露的目标群 |

- **scene 由客户端传，但必须落在令牌允许的范围内**——模型不能自己扩权。
- **主人主动提起**：桥接标记 `from_owner` 后，该场景可临时读到主人自己的记忆；敏感、他人私聊、`secret` 不放开。- **跨场景披露**：群友私聊问「刚才群里聊了什么」，桥接先做实时成员校验（持久成员表 + 增删事件 + 每日对账 + fail-closed），通过后才用 `disclose:group` 读**那一个群**的 `chat`/`note`、`normal`/`personal`；每次披露写审计。
- **审计**：`data/audit.jsonl` 记录 route / token / 命中 ids / 拒绝数 / 耗时，30 天轮转。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/health` | 存活 + 索引统计（唯一免鉴权） |
| GET | `/v1/capabilities` | 工具、限额、feature 开关 |
| GET | `/v1/config-schema` | 设置页 JSON Schema |
| GET | `/v1/config-state` | 读取可编辑配置（root） |
| POST | `/v1/config` | 更新白名单配置（root，热生效） |
| GET | `/v1/tokens` | 令牌元数据（root，不含 hash） |
| POST | `/v1/tokens/revoke` | 吊销一个令牌（root；签发仍在 CLI） |
| POST | `/v1/bootstrap` | 身份 + 受众脸 + 最近标题 + 最近 `self` |
| POST | `/v1/search` | 关键词检索（语义可用时 RRF 混合） |
| POST | `/v1/get` | 取一条（chunk id 或 doc id） |
| POST | `/v1/recent` | 最近记忆；`stage:"long"` 只取长期层；传 `format:"block"` 时多返一段已渲染的 `block` |
| POST | `/v1/recall` | 按最近对话召回，可带 `live` 侧通道；传 `format:"block"` 时多返一段已渲染的 `block` |
| POST | `/v1/timeline` | 时间线：按月分组、可分页 |
| POST | `/v1/disclose` | 跨场景披露：一个群的最近消息 |
| POST | `/v1/write` | 追加一条事实并索引 |
| POST | `/v1/forget` | 忘记一条（JSONL 写 tombstone） |
| POST | `/v1/ingest` | 普通聊天入短期记忆（带入口去噪） |
| POST | `/v1/audience` | 读受众卡 |

## 记忆块与 ID

**记忆块**：`/v1/recall` 传 `format:"block"` 时，memd 直接返回一段能塞进 prompt 的文本（标题、时间、截断、`（对方自己提起过的）` 标记都在服务端做，纯函数在 `packages/server/src/recall-format.ts`）：

```text
【最近在聊的】（近 30 分钟，是现状，不是回忆）
- 21:40 ……

【长期记忆】（只是背景，不要原样复述）
- （对方自己提起过的）……
```

取数仍由各端决定（哪个 scene、k 多大、要不要 live），渲染由 memd 统一。

**ID**（2026-10-27 统一，`packages/core/src/ids.ts`）：

```text
事实  <source>-<scene>-<time36>-<rand4>     例：fact-qq-group-650866701-m8x2k-7f3a
文档  doc-<pathHash8>                       例：doc-e8cc8701
```

- `scene` 里的 `:` 归一化成 `-`（`qq:group:123` → `qq-group-123`），所以段数不固定。
- 文档用路径 hash，重命名文件不换 id。
- 旧前缀 `f_<epoch>_<hex>` / `chat:<scene>:<hash>` / `import:<scene>:<hash>` / `doc:<path>#<ord>` 由 `scripts/migrate-ids.mjs` 一次性迁移，脚本只处理这四种，已迁的会原样跳过。
- **幂等键不从 id 派生**：ingest 写 `source_message_id = <provider id>#<内容 hash 前 12 位>`。QQ 会在同一会话里复用短 messageId，只用 id 当键会把「第二条不同的消息」当成重复丢掉。

## DSH 集成

**MCP server**（`packages/adapter-dsh/dist/mcp-server.js`，stdio）暴露 9 个工具：

`memory_bootstrap` · `memory_search` · `memory_timeline` · `memory_get` · `memory_recent` · `memory_recall` · `memory_write` · `memory_forget` · `memory_call`（兜底入口）。

`memory_write` 带 `supersedes`（替代旧记忆）、`idempotency_key`、`source`（来源标记，**只有 root 能设**；不传按场景记 `main`/`qq`，夜间整理传 `sleep` 便于整批回滚）；`privacy` 枚举是 `normal / personal / sensitive / secret`（`work`、`financial` 作为旧别名按 sensitive 处理）。`memory_forget` 走 `/v1/forget`，写 tombstone。

**两个插件**：

- `plugins/dsh-memory`：挂 `agent/pre-step`，把用户消息 fire-and-forget 上报 `/v1/ingest`；跳过桥接会话与 `pet-chat` 预设；memd 挂了也不能影响这一轮。
- `plugins/dsh-memory-panel`：设置页 + `/memory-hub/*` 同源代理（绕开 Chromium 的 Local Network Access），宿主侧零配置注入 root 令牌；加载 8 秒后自动跑一次 doctor 写 `logs/doctor-boot.log`。

## QQ 桥接（内嵌）

`qq-bridge/` 是 [qq-bridge-enhanced](https://github.com/Derpyu520/qq-bridge) 的二次开发，**源码直接放在本仓库**，有自己的 `package.json`，不参与 pnpm workspace。

- **令牌**：`node scripts\issue-qq-tokens.mjs` 按场景签发（owner / 每个群 / 每个私聊 / disclose），写进 `qq-bridge/state/`；配置里 `memory.enabled=true` 并映射 `tokens`。
- **镜像**：轻量记忆（`social-v2.json`）写入时镜像到 memd；失败落 `logs/mirror-failures.jsonl`，删除失败进 `state/forget-queue.jsonl`，每 5 分钟自动重试。
- **对账**：`qq-bridge/scripts/reconcile-memory.mjs` 只读打开 `index.db`，分 `present / legacy / partial / missing / superseded` 五桶，**只补不删**；桥接内置定时器每天 17:30 跑一次（`graceHours: 2`），桶非 0 时给 owner 发一条只含计数与路径的私聊。
- **看护**：memd 的 `supervisor.mjs` 可选第 2 步——`config.bridge.enabled` 为真时探活（**401 也算活着**），掉线跑 `qq-bridge\start-bridge.ps1`，失败退避 10 分钟。

部署与配置见 [`qq-bridge/docs/guides/CONFIGURATION.md`](qq-bridge/docs/guides/CONFIGURATION.md)，源码同步用 `scripts\sync-qq-bridge.ps1`（`-Apply` 才写，`-Restart` 顺带重启）。

## 桌宠

`dsh-pet-configurable-llm`（独立仓库）以 `scene=pet` 接入，持有自己的令牌（`main` + `qq:owner` + `pet`，**非 root**），每轮带 `live:{k:6,minutes:30,scenes:['main']}` 拉主会话最近的短期聊天，记忆块走 `format:"block"` 由 memd 渲染。它的失败不回落到普通对话模型——内部失败返回 200 + 降级文案，进程不在时由 `pet-revive` 每分钟补（这个任务独立于 memory-hub 的 supervisor，两个项目保持隔离）。

## 运维

```powershell
node scripts\doctor.mjs            # 自检：核心 + 提示
node scripts\doctor.mjs --json     # { ready, checks[] }
node scripts\doctor.mjs --shallow  # 只查文件，不发请求
```

- **重启后验证**：插件 `apply()` 写 `data/plugin-load/<name>.json`，doctor 与 `data/setup-stamp.json` 比时间——「装了但没重启」显示 `FAIL … 需要重启 DSH`。
- **看护**：`memd-watchdog` 每分钟跑 `supervisor.mjs`——探活并拉起 memd；`config.bridge.enabled` 为真时盯桥接；`metrics.csv` 超 60 分钟补采样；过了 04:00 且今天没备份就跑备份；`config.sleep.enabled` 为真时按周期跑整理（**日**每天 / **周**周一 / **月**1 号 / **年**1 月 1 日，都在 `config.sleep.at` 之后，失败按 `retryMinutes` 退避）。**memory-hub 侧只有这一个看护任务**；桌宠有自己的 `pet-revive`（每 1 分钟，见它的仓库），两个项目保持隔离、互不管对方的进程。
- **备份**：`pnpm backup` 每天一份到 `../backups/memory-hub/YYYY-MM-DD/`（memories + tokens + config + manifest，**不含 index.db**），同日覆盖、`keepDays` 清理。
- **监控**：`pnpm monitor` 采样 `/v1/health` 到 `data/metrics.csv`。
- **归档**：默认关；开启后更老月份压成 `facts/archive/*.jsonl.gz`（回读校验后才删原文件）。
- **升级 DSH**：`powershell -ExecutionPolicy Bypass -File scripts\post-upgrade.ps1` 检查 memd / doctor / pet-llm / 桥接四处，一处挂就红。
- **恢复**：索引可重建——`pnpm build && node packages\admin\dist\cli.js reindex`，tombstone 与过期规则都会在重建时重新生效。

## 测试

```powershell
pnpm test       # 190 项
pnpm test:e2e   # 真实 DSH 会话：建 minimal 会话 → 发标记 → 等 memd 收到（会调一次模型）
```

- 单测：tokenize / chunk / frontmatter / policy / 令牌热重载 / 可见性 / RRF 融合 / 语义纯函数 / 面板冒烟 / 旧库补列
- 检索基线：`node scripts/verify-recall.mjs --baseline` 按 12 条固定查询比排名升降（`--update` 重写，基线在 `data/recall-baseline.json`）；只报告不阻塞。
- 集成：临时目录 + 真 SQLite + `app.inject`——recall 作用域、披露、配置热更新、live、timeline、subject、短期权重
- 隐私矩阵：群搜工作=0、群 get owner=404、私聊互不可见、伪造 scene=403、`secret` 只对带 `secret:read`/root 的令牌可见、披露不串场景
- 契约：路由 ↔ OpenAPI 一致；MCP 工具（InMemoryTransport）；DSH 插件
- 沙箱里跑 `node --test` 需要 `--test-isolation=none`（脚本里已带）

## 目录结构

```text
memory-hub/
  packages/
    protocol/     TypeBox schema → JSON Schema / OpenAPI，路由表（唯一契约源）
    core/         tokenize（bigram）、chunk、frontmatter、policy（纯函数）
    server/       Fastify 路由、SQLite FTS5 索引、鉴权、审计、可见性 SQL、语义索引
    sdk/          类型化 HTTP 客户端
    adapter-dsh/  MCP stdio server + bootstrap 注入文本
    adapter-qq/   给 QQ 桥接用的零依赖客户端（编译成 dist/memory-client.mjs）
    admin/        令牌签发/吊销、reindex、health、social-v2 导入
  tests/          unit / integration / privacy / contract / mcp / plugin
  plugins/
    dsh-memory/        全会话消息 → /v1/ingest
    dsh-memory-panel/  设置页 + 同源代理
  scripts/        setup-all · doctor · supervisor · backup · monitor · archive-facts
                  verify-recall · build-timeline · e2e-dsh-session · issue-qq-tokens
                  sync-qq-bridge · install-autostart · fetch-model · embed · set-semantic
                  sleep-consolidate · install-sleep-preset · migrate-ids
  preset/         sleep-consolidator.patch.yml（夜间整理专用 preset）
  docs/           RUNBOOK · PLAN · TODO · IMPLEMENTATION · SPIKE-DSH · QQ-BRIDGE-PATCH · HANDOFF
  qq-bridge/      QQ 桥接（独立 package.json；MIT，见其 NOTICE.md）
```

## 文档

| 文档 | 什么时候看 |
|---|---|
| [`docs/SLEEP-CONSOLIDATION.md`](docs/SLEEP-CONSOLIDATION.md) | 夜间整理 + 桌宠记忆分层的正式方案 |
| [`docs/SLEEP-PENDING.md`](docs/SLEEP-PENDING.md) | 夜间整理的执行记录、跑过的验证、还欠什么 |
| [`docs/RUNBOOK.md`](docs/RUNBOOK.md) | 部署、看护、备份、恢复演练、故障对照 |
| [`docs/PLAN.md`](docs/PLAN.md) | 里程碑与取舍 |
| [`docs/TODO.md`](docs/TODO.md) | 单一待办来源（含明确不做与待决策） |
| [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) | 实现细节与设计理由 |
| [`docs/SPIKE-DSH.md`](docs/SPIKE-DSH.md) | 为什么选 MCP instructions + 工具，而不是别的注入方式 |
| [`../memories/50-knowledge/2026-10-24-memory-hub-deploy-from-zero.md`](../memories/50-knowledge/2026-10-24-memory-hub-deploy-from-zero.md) | 从零部署的踩坑记录 |

## 许可

- `memory-hub` 本体：MIT（见 [`LICENSE`](LICENSE)）。
- `qq-bridge/`：MIT，保留上游 Copyright 与 `NOTICE.md`；SnowLuma 本体是专有组件，不随仓库分发。
- 语义模型 `bge-small-zh-v1.5` 由脚本按需下载，不随仓库分发。
