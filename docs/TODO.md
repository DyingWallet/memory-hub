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
- 桌宠：dsh-pet 0.3.8 + dsh-pet-configurable-llm 记忆接入（scene=pet、无 `sensitive:read`）、气泡优先级双栈自愈补丁。
- 设置页可编辑：`GET /v1/config-state` + `POST /v1/config`（root、白名单、备份、热应用）。
- 测试：`pnpm test` 106 项；dsh-pet-configurable-llm 18 项；QQ 预设契约测试通过。

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
11. ✅ **dsh-pet-configurable-llm 自启**：不注册登录任务，改跟 DSH 生命周期——`start-stack.ps1` 第 2.7 步在 DSH 之后拉起（传 `DSH_WEB_URL`），`src/guard.mjs` 每 20 秒探一次，连续 3 次不可达（约 60 秒）自退；另有 `pet-revive`（每 1 分钟）在「DSH 在、8790 不在」时拉起它，堵掉 DSH 重启后没人补的窗口。pet 测试 29 项。
12. ✅ **「桌宠绝不冒充」**（原 `externalBrain` 补丁，改成不碰 dsh-pet）：dsh-pet-configurable-llm 内部失败时返回 200 + 降级文案（`src/degraded.mjs`），dsh-pet 看到「成功」就不会回落到普通对话模型；进程不在的那一半由 `pet-revive` 每分钟补齐。`memory.json` 不参与生成（`chatMemoryRounds: 0`），确认无影响后不再处理。
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

## 2026-10-25 检索质量与披露（讨论稿）

> 来源：QQ 私聊里问「昨晚一起实现了什么」，答成了 10-23 的旧状态。排查出若干独立问题（检索质量、生命周期、披露、工具面），按性价比排。编号接 21。

22. ✅ **QQ search 透传 stage**
    - 现状：`adapter-qq` 的 `normalizeResults` 只留 `id/title/kind/text`，把服务端一直返回的 `stage` / `expires_at` 裁掉了。
    - 已做：`MemoryItem` 加字段 + 透传 + 单测（7/7 过）+ `dist` 已构建；桥接 17:49 重启后生效。
    - 成本：已完成（~40 分钟）。

23. ✅ **ingest 去噪（源头）**
    - 数据：短期 709 条里 114 条是噪音（16%）——`[图片]` 46、桌宠系统提示 24、`[表情N]` 17、`[卡片消息]` 11、黑话学习器 prompt 8、工具报错 8；另有 287 条 ≤10 字。
    - 已做（2026-10-25）：新增 `packages/server/src/ingest-filter.ts`（占位符剥离 / 内部 prompt 前缀 / 最短 2 字 / 空白折叠），`/v1/ingest` 循环里接入，过滤掉的计入 `skipped`（协议不变）；9 项单测 + 全量 171 项通过；真实库回放覆盖 125/732（17%：占位 71、过短 18、内部 prompt 36）。
    - 已生效：memd 17:45 重启后实测 `written=1 skipped=3`；上游根因仍要修（桌宠别把 system prompt 当 user message、黑话学习器 prompt 不该进 main 短期）——入口过滤只是兜底，改上游能让 JSONL 也干净。
    - 成本：已完成（约 1 小时）。

24. ✅ **过期短期记忆不再复活**
    - 数据：`chunks_fts` 1180 行里 324 行是已过期短期（27.5%），仍参与 bm25 统计。
    - 根因：`purgeExpired` 每小时删索引，但 `indexFacts` 无过期判断，任何一次 reindex（ingest 写 JSONL 就触发）都把过期记录插回来。
    - 已做（2026-10-25）：`indexFacts` 跳过 `stage=short && expires_at <= now` 的记录；如果索引里该 id 已经是 `long`（persist 过，JSONL 仍留原 short 行）则加进 `liveIds` 保住，不被 stale 清理误删。新增 `tests/integration/indexer-expiry.test.ts` 3 项（purge 后不复活 / persist 的 long 幸存 / 未过期短期正常）；全量 174 项通过。
    - 顺手补上（同日）：`/v1/persist` 现在会往 JSONL 追加一行同 id 的 `stage=long`（无 `expires_at`），reindex 后行覆盖前行——索引终于可以从 `memories/` 完整重建（备份不含 `index.db`，在此之前从备份恢复会把长期记忆变回短期并在 TTL 后删掉）。只对原本是 short 的记录写，多 chunk 文档不会被截断。测试 `tests/integration/persist-jsonl.test.ts` 2 项；存量缺标记的 1 条已手工补齐。全量 176 项通过。
    - 已生效：memd 17:45 重启后 `chunks` 1180 → 743；25 已完成。
    - 成本：约 1 小时。

25. ✅ **存量噪音清理**
    - 已做（2026-10-25）：干跑 746 条短期 chat → 噪音 126（占位 71 / 内部 prompt 36 / 过短 19），其中 68 条还没过期；先把 `memories/facts/` 备份到 `backups/facts-before-cleanup-2026-10-25T09-18-05-181Z/`，再逐条 `/v1/forget` 写 tombstone：**126/126 成功，0 失败**。验证：short chat 746 → 620，噪音 0。
    - 剩余：304 条「已过期但索引里还在」的短期记录没有 tombstone——等 24 上线后由 purge 处理（只删索引、保留 JSONL），不需要永久删除。
    - 没重启也能生效：tombstone 是 JSONL 里的 `deleted:true` 行，旧版 indexFacts 同样会跳过。
    - 成本：0.5 小时。

26. ✅ **跨场景披露放开（在群全量 / 退群拒绝）**
    - 口径：当前在群的成员，披露该群全部历史（不限时间）；已退群/非成员拒绝；不做 `joinedAt`、不做入群时间判断。
    - 已做（2026-10-25）：
      - memd `/v1/disclose`：`since_hours` 改为可选，不传 = 不限时间（响应用 `since_hours: 0` 表示）；`k` 默认 8→20、上限 20→50。
      - 桥接 `group-disclosure.js`：去掉时间窗（`detectDisclosureIntent` 不再推断 sinceHours）、条数 12→20、单条 160→300 字；文案改成「历史消息」。
      - 桥接 `bridge.js`：`fetchDisclose` 不再传 `since_hours`。
      - 保留：实时成员校验（防退群事件丢失）、`chat/note`、`normal/personal`、60 秒限流、审计。
    - 测试：桥接 `test-group-disclosure.mjs` 22 项全过；memd 新增「不传 since_hours 不限时间」用例，`disclose.test.ts` 5 项全过；全量 178 项。
    - 已生效：memd 与桥接均已重启，`/v1/disclose` 实测不传 `since_hours` 返回 `since_hours=0`、`count=20`。
    - 成本：约 1 小时。

27. ✅ **QQ 加 timeline 入口**
    - 依据：实测同一个「昨晚」问题，`/v1/timeline` 直接给出 `memory-hub.md`、`live-context.md`，`search` 给的全是聊天碎片。
    - 已做（2026-10-25）：`adapter-qq` 加 `timeline()`（from/to/limit/subject/kinds，归一化 months）；`memory-bridge.js` 加 `timeline()`；桥接加 `POST /api/socialV2/memory-timeline`（鉴权同 memory-search）；MCP 注册 `qq_memory_timeline`（描述照抄主会话口径：问「那阵子/上个月」用它，别拿 search 硬凑）；`TOOL_FEATURES` 映射到 `memory`。
    - 测试：adapter-qq 8 项（新增 timeline 归一化 + 参数透传）；桥接三个文件 `node --check` 通过；全量 178 项。
    - 已生效：桥接 + DSH 重启后，`qq_memory_timeline` 实测调用成功（total=341、带 next_before 分页）。
    - 成本：约 2 小时。

28. ✅ **统一入口（compact 视图 + 薄透传）**
    - 已做（2026-10-25）：
      - `adapter-qq` 的 `search(query, scene, k, { kinds, subject, maxChars })`：`max_chars` 默认 400→600（与主会话一致），`kinds`/`subject` 透传；`normalizeResults` 补 `score`，字段与主会话对齐（`id/title/kind/text/stage/expires_at/score`）。
      - `memory-bridge.js` 的 `search()` 透传 options；桥接 `/api/socialV2/memory-search` 解析并透传 `kinds/subject/max_chars`（只过滤、不扩权）。
      - MCP `qq_memory_search` 的 schema 加 `kinds`/`subject`，描述补「问最近先用 timeline」。
    - 测试：adapter-qq 9 项（新增 kinds/subject/max_chars 透传 + score 归一化）；全量 179 项。
    - 已生效：桥接重启后 `kinds`/`subject`/`score` 实测可用。
    - 成本：约 1.5 小时。

29. ✅ **排序改造（短期降权，已实现）**
    - 问题：`709 short vs 90 long`，bm25 天然偏短文档；问句和文档词面重合低。
    - 评估（2026-10-25，5 个查询，main 场景 k=10）：
      - 现状 long@top5 平均 2.4；short×0.5 后平均 4.0（首个 long 从 #2–#3 提到 #1）；
      - 但「期望命中」5 个里 4 个没中——说明降权只解决「谁排前面」，不解决「问句和文档对不上」。回顾类问题（「昨晚实现了什么」）应走 timeline（27 已补入口）。
    - 已做：`config.searchShortWeight` 默认 0.5（1 = 关闭），`/v1/search` 返回前按 `score × stage 权重` 重排；返回的 `score` 仍是原始召回分。测试 `tests/integration/search-short-weight.test.ts` 2 项；`shortterm.test.ts` 里依赖 `results[0]` 的断言改成按 stage 找目标条目。
    - 已生效：memd 重启后实测 long 在 top6 里占 4 条、short 掉到第 3/6 位。
    - 成本：约 2 小时（评估 1 小时 + 实现 1 小时）。

30. ✅ **QQ 记忆工具面：不合并，定契约**
    - 现状：QQ 侧 7 个——`append/query/remove/clear` 是本地轻量记忆（`social-v2.json`），`search/get/recent` 是 memd；加 `timeline` 后 8 个。主会话 10 个（含 `memory_call` 兜底）。两层存储语义不同，不能合成一个工具。
    - 已做（2026-10-25）：新增 `qq-bridge/docs/guides/MEMORY_CONTRACT.md`——两层存储的分工、8 个工具的参数与返回字段、与主会话工具的对应关系、不合并的理由、以后加工具用兜底入口而非替换。
    - 成本：0.5 小时。

31. 🔶 **两层记忆保留，补对账**
    - 决定：桥接轻量记忆（`social-v2.json`）不迁到 memd。理由：memd 挂时唤醒仍要能注入（fail-soft）；轻量记忆是「我主动提炼的当前关注」，memd short 是「自动收录的原文流」；按会话 key 隔离比 `*` scope 更干净。
    - 现状：写入已镜像（`mirrorWrite` → `qq-topic` / `qq-impression`），但读取仍各走各的，可能漂移。
    - 要做：`mirrorWrite` 失败时记日志；定期对账 `social-v2` 的轻量条目与 memd facts 是否一致。
    - 成本：约 1 小时。
    - **进展（2026-10-26 01:15）：包 A（可观测性）已落地**，B（稳定身份）与 C（定时）未做。
      - 新增 `qq-bridge/src/memory/{idem,mirror-journal,reconcile}.js` + `scripts/reconcile-memory.mjs`；
        `memory-bridge.js` 的 `mirrorWrite`/`mirrorForget` 失败落 `logs/mirror-failures.jsonl`，
        `mirrorForget` 失败进 `state/forget-queue.jsonl`，桥接每 5 分钟自己重试（`forgetQueueRetryMs`，默认 300000）。
      - 对账只读打开 `index.db`（校验 `meta.schema_version=3`），分五桶：`present / legacy / partial / missing / staleDocs`；
        **只补不删**，`--fix missing` 与 `--fix forget` 需显式调用，且报告过期（size/mtime 变了）直接拒跑。
      - 实测（真数据）：live 4 → present 0 / legacy 2 / partial 1 / missing 1；孤儿 idem 键 37；长期层多出 26 条（只报不删）。
      - 测试 7 项（`npm run test:memory`），覆盖 key 稳定性、失败流水、队列去重与上限、摊平映射、五桶判定、截断副本、schema 断言。
        RUNBOOK §2.6 已写。第 2 步（`entryId` 稳定键 + legacy 认领）待决。

32. ✅ **QQ 桥接看护并入 `memd-watchdog`**（2026-10-25 夜）
    - 起因：桥接原本只有登录时的 `Startup\qq-stack.vbs` 一条链，会话里手动关掉后没人补；沙箱身份也起不了它（`qq-bridge\state\` 与 `config.json` 做过 ACL 收紧）。
    - 已做：`scripts/supervisor.mjs` 新增可选第 2 步——`config.bridge.enabled`（默认 `false`）为真时探 `probeUrl`（默认 `http://127.0.0.1:3100/`，**401 也算活着**），掉线跑 `qq-bridge\start-bridge.ps1`，起不来退避 `retryMinutes`；`logs/supervisor-state.json` 从「直接覆盖」改成合并写入，`bridgeRetryAt` 与 `lastBackupAttemptAt` 互不踩。
    - 配置面：`ServerConfig.bridge`（`enabled/dir/probeUrl/retryMinutes/startTimeoutSeconds`）+ `normalizeBridge` 夹紧；`config.example.json` / `RUNBOOK.md` §2.5 有样例。
    - 实测：手动 `Stop-Process` 掉桥接 → `22:43:01 bridge down -> starting`、`22:43:13 exit=0`、`22:43:14 bridge healthy again`，13 秒补回；心跳 `memd=up bridge=up`。
    - 测试 184 项（+2 `normalizeBridge`）；commit `71eb617`。没单开任务：临时建的 `qq-bridge-manual` 与 `run-bridge-hidden.cmd` 已删，全机仍只有 `memd-watchdog` / `pet-revive`。

### 明确不做（已实测负收益）

- **k 上限 10 → 20**：实测多出的 5 条全是短期 chat（0.285–0.298），纯噪音。
- **放宽短期 TTL / 检索时间范围**：会把 323 条过期聊天放回来。
- **QQ 直连 `mcp__memory__*`**：桌面 root token，群里等于交出整库读权限。
- **用 memd 取代桥接轻量记忆**：会丢 fail-soft、提炼语义和话题生命周期；而且 `qq-owner` 带 `*` scope，读 memd 会连 main/pet 一起看到，污染更大不是更小。

### 本轮新增待决策

- `search` 是否默认排除短期（只走 recent/review/timeline）？
- 披露是否保留 `sensitive` 不给（建议保留，与成员资格无关）。
- `qq-owner` 的 scope 要不要收窄（去掉 `*`）：更纯净，但会失去「主人私聊 = 主会话」的读范围一致性。

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
