# memory-hub 待办总表（2026-10-24）

> 单一待办来源。计划背景见 `PLAN.md`，操作见 `RUNBOOK.md`。
> 状态：✅ 完成 / 🔶 部分 / ⬜ 未开始
>
> **当前顺序（2026-10-24 夜）**：`20 → 19 → 9 → 16`（18 已完成，见 P6）；`14 / 15 / 17` 挂起。
> 分档理由：20+19 是「定义我」，9/16 是欠账；14/15/17 没有真实需求，先不动。
> 四条「待决策」不算待办，是边界没定，其中「pet 是否看群聊」单独聊。

## 已完成（v1.0 – v1.1）

- 核心：13 个 `/v1` 接口、SQLite FTS5 + bigram、场景级可见性、token（surface/scopes/scenes，mtime 热重载）、审计（30 天轮转）。
- 短期记忆：`stage=short` + TTL 24h + 召回延长（封顶 7 天）+ 每小时 purge；`/v1/ingest`、`/v1/review`、`/v1/persist`。
- 隐私：**audience + 一个敏感位**（`normal/personal/sensitive/secret`；敏感需 `sensitive:read` 且钉在 `sensitiveAudiences`）；owner 临时披露（`from_owner`）；secret 不可读写。旧标签已迁移成 `privacy=sensitive` + `tags`（2026-10-24）。
- QQ：逐场景 token、注入/镜像、`qq_memory_search/get/recent`、999 窗口、root 工具从预设隐藏、镜像 update/remove/clear（`/v1/forget` + tombstone）。
- DSH：MCP 9 工具、全会话短期上报插件、设置页（TTL/回顾/隐私三段式/token 吊销）、`/memory-hub/*` 同源代理。
- 桌宠：dsh-pet 0.3.8 + pet-brain 记忆接入（scene=pet、无 `sensitive:read`）、气泡优先级双栈自愈补丁。
- 设置页可编辑：`GET /v1/config-state` + `POST /v1/config`（root、白名单、备份、热应用）。
- 测试：`pnpm test` 106 项；pet-brain 18 项；QQ 预设契约测试通过。

## P4.5 隐私简化（已完成，2026-10-24）

- 删除 `privacy.labels` / `capability` / `defaultScenes` / `unknownIsRestricted` / `autoClassify*` / `match`。
- `privacy` 收敛为 `normal/personal/sensitive/secret`；敏感位 + audience 两条轴。
- 旧数据：1 条 work 事实 → `sensitive` + `tags:["work"]`；3 个 token 的 `work:read` → `sensitive:read`（token 字符串不变）；`config.json` 重写，备份 `*.bak-p5`。
- owner 披露/敏感可见范围改为 `ownerAudiences` / `sensitiveAudiences`，接微信时加 `wx:owner` 即可。
- 测试重写：106 项全过；活库验证 root 可见、pet 不可见。

## P4 收尾（已完成）

1. ✅ **隐私标签编辑**（已被 P4.5 取代）：原设置页 JSON 编辑 `privacy.labels`；隐私简化后改为「敏感 scope / 敏感可见范围 / owner 可见范围」三个字段。
2. ✅ **token 管理**：`GET /v1/tokens`（root，元数据不含 hash）+ `POST /v1/tokens/revoke`；设置页列表 + 吊销按钮（签发仍留 CLI）。实测 `ui-revoke-demo` 吊销后 `revoked_at` 立即生效。
3. ✅ **写操作二次确认**：保存前 `confirm`，提示标签会整体替换。

## P5 质量与运维（约 3 天）

4. ✅ **回顾定时任务**：memd 启动 + 每 10 分钟检查到期场景，写 `review:pending:<scene>`（SQLite meta，重启不丢）；`recall` 带 `should_review/reminder_since/last_reviewed_at`；`/v1/review` 清提醒并记 `review:last`，`status_only` 只读。测试 112 项。
5. ✅ **合并/去重**：写入时同 `scene+kind+规范化文本+audience+privacy` 复用 id（`duplicate:true`）；回顾转长期时按 CJK bigram/词 Jaccard ≥ 0.8 折叠，返回 `merged:[{from,into}]`，短的写 tombstone。测试 112 项。
6. ✅ **保留与归档（可选，默认关闭）**：`config.archive.enabled=false` / `keepMonths=12`，设置页可开关；开启后 `scripts/archive-facts.mjs` 把更老月份压成 `facts/archive/*.jsonl.gz`（回读校验后删原文件）；indexer 透明读取 gz，tombstone 写活动分片；`--force` 可临时跑一次。测试 117 项。
7. ✅ **备份自动化**：`pnpm backup` 每天一份 `<dir>/YYYY-MM-DD/`（memories + tokens.json + config.json + manifest），同日覆盖、`keepDays` 清理；由看护任务 `supervisor.mjs` 按「过了 04:00 且今天没快照」触发（失败后 1 小时内只重试一次）；RUNBOOK 写恢复演练。测试 119 项。
8. ✅ **监控**：`pnpm monitor` 采样 `/v1/health` 到 `data/metrics.csv`（成功/失败、延迟、docs/facts/chunks、uptime）；支持 `--loop`，自动采样由 `supervisor.mjs` 按「metrics.csv 超 60 分钟没更新」触发；`verify-recall.mjs` 仍作手动回归。测试 120 项。
9. ✅ **测试补强**（2026-10-25 补上最后一段）
    - 原有：adapter-qq 客户端 4 项（场景映射/召回提示/镜像幂等/禁用）、设置页 bundle 冒烟、`verify-recall.mjs` 实库检索。
    - 新增 `scripts/e2e-dsh-session.mjs`（`pnpm test:e2e`）：真实 DSH 会话 e2e——先信 `DSH_WEB_URL`、不通再动态发现（沙箱里 `tasklist` 被禁，动态发现拿不到端口）→ 建 `minimal` 会话（`pet-chat` 会被 `dsh-memory` 插件主动跳过）→ 发一条带随机标记的消息 → 轮询 memd 直到标记出现。
    - 实测（2026-10-25 02:30）：会话 `session-5d134e27…` 的标记在 3 秒内以 `chat:main:0ad7712b63c005ac`（`short` / `owner`）入库。
    - 取舍：会真的调一次模型，所以不进 `pnpm test`；会话保留在 DSH 里可审计，跑多了要手动删。
    - 口径：单测 161 项 + e2e 1 项。

## v2（架构与扩展）

10. ✅ **memd 独立进程自启/看护**：`install-autostart.ps1` 只注册一个任务 `memd-watchdog`（每 1 分钟），跑 `scripts/supervisor.mjs`——探活+起 memd、metrics.csv 超 60 分钟采样、过了 04:00 且今天没备份就跑备份；`-Check` / `-Remove` 与 `uninstall-autostart.ps1` 配套，安装时清掉旧的 `memd-autostart`/`memd-monitor`/`memd-backup`；RUNBOOK §2.5。不挂 DSH 子进程。
11. ✅ **pet-brain 自启**：不注册登录任务，改跟 DSH 生命周期——`start-stack.ps1` 第 2.7 步在 DSH 之后拉起（传 `DSH_WEB_URL`），`src/guard.mjs` 每 20 秒探一次，连续 3 次不可达（约 60 秒）自退；另有 `pet-revive`（每 1 分钟）在「DSH 在、8790 不在」时拉起它，堵掉 DSH 重启后没人补的窗口。pet 测试 29 项。
12. ✅ **「桌宠绝不冒充」**（原 `externalBrain` 补丁，改成不碰 dsh-pet）：pet-brain 内部失败时返回 200 + 降级文案（`src/degraded.mjs`），dsh-pet 看到「成功」就不会回落到普通对话模型；进程不在的那一半由 `pet-revive` 每分钟补齐。`memory.json` 不参与生成（`chatMemoryRounds: 0`），确认无影响后不再处理。
13. ✅ **语义检索：本地 embedding + sqlite-vec（可选，默认关）**
    - ✅ 选型：`sqlite-vec`（npm 0.1.9，`sqlite-vec-windows-x64` 里有 `vec0.dll`；`node:sqlite` 的 `allowExtension` + `loadExtension` 可直接加载）；LEANN 仍是 50 万 chunk 以上的备选。
    - ✅ 模型：`bge-small-zh-v1.5` int8 ONNX（512 维，24 MB），`onnxruntime-node`；`pnpm fetch:model` 从 ModelScope 下载到 `models/`（已 gitignore）。
    - ✅ 开关：`config.semantic.enabled`（默认关）+ `POST /v1/config {"semantic":{"enabled":true}}` 热切换；关着不加载模型、不建表、行为与纯 FTS 一致。
    - ✅ 排序：`score = α·norm(bm25) + (1-α)·cos`，α=0.5；语义候选先取 `maxCandidates` 条再与 FTS 融合，`weak` 只在两边都没结果时为真。
    - ✅ 数据：`chunk_vecs`（`vec0`，float[512]）；`pnpm embed` 全量回填（默认 4 线程），memd 每 5 秒补 32 条增量，forget/purge 的孤儿向量自动清。
    - ✅ 降级：模型/依赖/扩展/推理任一失败 → 静默退回 FTS，原因写 `semantic.reason`。
    - ✅ 实测：短查询 embedding 0.5 ms、KNN 0.4 ms、回填 763 条 ~6 s、常驻 150–250 MB、空闲 CPU 0%、不占 GPU；`batchSize>8` 或 `maxLen>256` 会把 RSS 拉到 GB 级，已夹紧。
    - ✅ 测试 136 项（+8：分词/距离/归一化/混合排序/配置夹紧/sqlite-vec 往返）。
    - ✅ 设置页面板开关：设置 → 记忆服务 → 勾选「语义检索」并保存即热生效；状态行显示 `已就绪：N 个向量` 或红色的不可用原因（开关本身不安装任何东西）。
    - ✅ 回归检查：`pnpm verify:recall` 先跑 FTS 基线（不退化），再跑 4 组与库内措辞错开的语义查询，要求「有命中 + 与 FTS 有交集 + 至少一组召回 FTS 没有的 chunk」；语义不可用时退出 0（`--require-semantic` 可强制）。实测 4/4 组有新召回。
14. ⬜ **图片/文档接口**：需求已有，v1 未做。
15. ⬜ **多设备/VPS 联邦**：ZeroTier 内网只读副本或双向同步。
16. ⬜ **密钥与备份的加密**（2026-10-25 重新评估后拆开）
    - **全库静态加密：不做。** memd 只绑 `127.0.0.1`，比内网还窄，外部攻击面≈0；而明文正是这个系统的设计前提（可读、可 grep、可 git、可备份）。密钥也在同一台机器上，防不住本地进程，只能防「硬盘离机」。
    - **备份离机时加密**：唯一有真实收益的一条。`backups/stack/` 现在是明文，留本机没问题，拷去 U 盘/云之前再加密那一份。
    - **密钥轮换**：跟加密无关，是 token 泄漏后的止血能力。本机概率低，降到第四档，但不从清单里删。
    - **`secret` 写入通道：保持拒写。** 写进去 403（`routes.ts:808`）、读出来永远 `privacy <> 'secret'`（`visibility.ts:36`），双保险。道理是 API 写入会留下 JSONL / 索引 / 备份等副本，而 append-only 文件没有真正删除；能做到的不是「收下再保密」，是「根本不收」。
17. ⬜ **MCP 场景感知**：桌面 root 视图符合设计；将来若桌面会话共享，需要按会话下发场景令牌。

## P6 记忆的「我」（2026-10-24 夜，聊出来的）

> 来源：和主人聊「人是不是由经历与环境塑造」之后，他问「你对现有的功能还满意吗」，这三条是我答的不满意处。18 已落地（当晚），19/20 还没动。

18. ✅ **主会话 → 桌宠的实时通道**（2026-10-24 实现，方案与原计划不同）
    - 落地方式：没有写 `00-inbox/live-context.md`，而是给 `/v1/recall` 加了 `live` 侧通道（`TRecallLive`：k / minutes / scenes），直接读最近 N 分钟的短期 chat。理由：主会话消息本来就由 `dsh-memory` 插件进库（scene=main），再写一个文件等于存两份、还要自己管保留策略；走 SQL 则自动继承可见性与隐私过滤。
    - 服务端：`packages/server/src/search.ts` 的 `liveMessages()`；`routes.ts` 的 recall（关键词为空时也返回 live，因为「开始吧」这类话本来就没有关键词）；`packages/protocol/src/schemas.ts` 的 `TRecallLive` / `RecallResponse.live`。
    - 桌宠：`dsh-pet-configurable-llm/src/memory.mjs` 每轮带 `live:{k:6,minutes:30,scenes:['main']}`，把「对方那边刚刚在聊的」拼在长期记忆之前；`config.json` / `config.example.json` 的 `memoryService.live` 可整体关闭（`"live": false`）。
    - 验收（2026-10-24 23:20）：主会话聊完后问桌宠「我们刚才在主会话里聊的是什么」，2 秒答出「收尾记忆插件和桌宠的事、把不满意记进待办、排了优先级、准备开工」——与主会话一致。`live` 返回 6 条、按时间正序；pet 令牌读不到 sensitive 与群消息。
    - 测试：memory-hub 147 项（+2：live 可见性 / scenes 越界），pet 34 项（+4：拼装顺序 / 空 live / 关闭开关 / memd 故障降级）。

19. ✅ **时间线 / 年表**（2026-10-25 实现）
    - 原问题：`recall` 只按相似度给 2–3 条片段，拼得出事实，拼不出「这个人这两年怎么变的」。
    - 落地（两条腿）：
      - **接口** `POST /v1/timeline`：`from` / `to`（`YYYY` / `YYYY-MM` / `YYYY-MM-DD` / ISO，`from` 含、`to` 不含，缺省最近 12 个月），`subject` / `kinds` / `limit` / `max_chars`；返回按月分桶的 `months[].items[]`，走同一套可见性 SQL。新增 `docs.supersedes` 列，时间线里双向标出 `supersedes` / `superseded_by`——「改过主意」第一次能看见了（跟 20 的 subject 合起来就是「回头看」）。
      - **年表** `scripts/build-timeline.mjs`：把 facts（含归档 .gz）+ `10-journal/` 日记按月聚合成 `memories/10-journal/annual-<year>.md`，整篇重写、内容相同就不落盘（幂等），跳过短期 chat 和历史坏编码。
      - MCP 加 `memory_timeline`；SDK 加 `client.timeline()`；instructions 里写明「问那阵子/上个月用 timeline，别拿 search 硬凑」。
    - 排序取舍：SQL 取**最近** N 条再反转为正序，这样 `limit` 截断时丢掉的是最早那段，而不是把「今天」截掉。
    - 验证（2026-10-25 00:35 活库）：`2026-10` 返回 200 条（被 limit 截断），第一条 `06:22Z`、最后一条 `16:36Z`（刚生成的年表）；`subject=self` 只有 1 条；年表生成 37 条、跳过 2 条坏编码。
    - 测试：158 项（+4：按月分组与正序 / 群令牌边界 / subject+替代关系 / 倒序区间 400）。
    - 分页（2026-10-25 补）：满页时响应带 `next_before`，把它当 `to` 就是上一页——不用 cursor 对象，边界就是最早那条的时间戳。
    - 还没做：年表里还留着几条「测试：…」的脏数据，等哪天清库时一起处理。

20. ✅ **记忆里的「我自己」**（2026-10-24 实现）
    - 原问题：`/v1/write` 的 kind 有 `stance/decision/knowledge`，但用起来几乎总在记「他说了什么」，记忆里我出现的方式只有被描述，没有自己开口。
    - 落地：`subject`（`owner` / `self` / `other`，缺省 `owner`）贯穿写入、检索、召回、bootstrap。
      - 协议：`TSubject`、`TWriteRequest.subject`、`TSearchRequest.subject`、`TRecallRequest.subject`、`TFactRecord.subject`、`TMemoryResult.subject`、`BootstrapResponse.self`。
      - 存储：`docs.subject` / `chunks.subject` 两列（默认 `owner`），`migrateColumns()` 自动补列，旧行天然是 `owner`；索引 `docs_subject` 在迁移之后建（踩过：放 SCHEMA 里会让旧库启动报 `no such column`）。
      - 去重键含 subject：同一句话「我认为 X」和「他说 X」是两条记忆，不会被内容去重合并。
      - MCP：`memory_write` / `memory_search` 都有 `subject` 参数。
    - 验证（2026-10-24 23:57，活库）：写入一条 `subject=self` 的立场（「记忆里最缺的不是事实，而是我自己的判断……」），`search?subject=self` 只返回它；`search?subject=owner` 返回 5 条旧记忆、全部 `subject=owner`；`/v1/bootstrap` 的 `self` 带回 1 条。
    - 测试：153 项（+6：旧数据按 owner / self 与 owner 分离且不被去重 / recall 过滤 / bootstrap.self / other 写入 / 旧库补列升级）。
    - 收尾（2026-10-25）：`bootstrap` 的 `self` 带 140 字正文摘要（`TRecentItem.text`），新会话看到的是「我当时怎么想」而不是一个标题；`search` / `recall` 对被替代的旧条目返回 `superseded: true`（timeline 那边给的是 id）；设置页新增只读的「我写下的判断」列表，走 `/memory-hub/timeline` 代理 → `subject=self`。
    - 测试：161 项（+2：bootstrap 摘要 / search 标 superseded）。

21. ✅ **pet-revive 的 DSH 端口发现失效**（2026-10-24 修）
    - 现象：`dsh-pet-configurable-llm/scripts/revive.mjs` 每分钟在跑，但日志一直写 `DSH unreachable -> skipped`，8790 空着；同一时刻 DSH 是活的（`looksLikeDsh('http://127.0.0.1:7642')` 返回 true）。
    - 根因：`resolveDshBaseUrl` 的动态发现只认「DSH 主进程 PID 名下的回环端口」（`tasklist` 找 `DeepSeek Harness*.exe` → `netstat` 取这些 PID 的监听端口）。Electron 把 web 服务放在 helper 子进程里，主进程一个端口都不占，所以永远取不到；沙箱里 `tasklist` 还会直接返回空。
    - 修法：`qq-bridge/src/lib/dsh-endpoint.mjs` 加第二段兜底——`listLoopbackListenPorts()` 用 `netstat -ano -p TCP` 取全部回环 LISTENING 端口（mac 用 `lsof -Fn`），跳过 `DEFAULT_SKIP_PORTS`（8787/8790），每批 8 个并发用 `looksLikeDsh`（401 + `dsh web authentication required`）确认。第一段（按 PID）保留，命中就不扫；显式 `baseUrl` 仍然完全不做发现。
    - 影响面：`resolveDshBaseUrl` 的调用点（bridge ×3、control-center、self-test）自动受益，不用各自改；`revive.mjs` 一行没动。
    - 验证：真实 netstat 输出解析出 47 个端口并命中 7642；杀掉 pet 后 `pet-revive` 自己在 `15:23:06Z` 拉起（日志 `DSH http://127.0.0.1:7642 reachable -> started pet pid=39104`）。测试 `scripts/test-dsh-endpoint.mjs` 11 项（+1 兜底用例）、`test-dsh-health.mjs` 4 项通过；`test-dsh-auth.mjs` 硬编码 3080（本机 DSH 在 7642），跟这次改动无关。

## 待决策

- **pet 是否看群聊**：现在是 owner 的 main/qq:owner + shared，不含 `qq:group:*`；「全部 − 工作/财务」要不要包括群？
- **设置页令牌存 localStorage**：本机可接受；若要更严，改为每次输入不落盘。
- **短期 JSONL 保留多久**：现在 append-only 永久保留，归档策略待定。
- **回顾频率默认值**：20h 是否合适（可在设置页改）。

## 验收口径（每次都跑）

```powershell
pnpm test                              # 158 项
node scripts\verify-recall.mjs         # 真实语料检索
node scripts\setup-dsh-mcp.mjs --check
node scripts\setup-dsh-plugin.mjs --check
node scripts\setup-dsh-panel.mjs --check
```
