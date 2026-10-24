# memory-hub 待办总表（2026-10-24）

> 单一待办来源。计划背景见 `PLAN.md`，操作见 `RUNBOOK.md`。
> 状态：✅ 完成 / 🔶 部分 / ⬜ 未开始

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
7. ✅ **备份自动化**：`pnpm backup` 每天一份 `<dir>/YYYY-MM-DD/`（memories + tokens.json + config.json + manifest），同日覆盖、`keepDays` 清理；`scripts/install-backup-task.ps1` 注册每日计划任务（默认 04:00），uninstall 反向删除；RUNBOOK 写恢复演练。测试 119 项。
8. ✅ **监控**：`pnpm monitor` 采样 `/v1/health` 到 `data/metrics.csv`（成功/失败、延迟、docs/facts/chunks、uptime）；支持 `--loop` 与每小时计划任务脚本；`verify-recall.mjs` 仍作手动回归。测试 120 项。
9. 🔶 **测试补强**：adapter-qq 客户端 4 项（场景映射/召回提示/镜像幂等/禁用）+ 设置页 bundle 冒烟 + `verify-recall.mjs` 实库检索通过；**真实 DSH 会话 e2e** 仍靠手动清单（起会话、看 ingest 落库、看 review 提示）。测试 125 项。

## v2（架构与扩展）

10. ✅ **memd 独立进程自启/看护**：`install-autostart.ps1` 注册两个任务——`memd-autostart`（AtLogOn + 30 秒延迟）+ `memd-watchdog`（每 5 分钟，已健康则 exit 0），均跑 `start.ps1 -NoWait`；`-Check` / `-Remove` 与 `uninstall-autostart.ps1` 配套；RUNBOOK §2.5。不挂 DSH 子进程。
11. ✅ **pet-brain 自启**：不注册登录任务，改跟 DSH 生命周期——`start-stack.ps1` 第 2.7 步在 DSH 之后拉起（传 `DSH_WEB_URL`），`src/guard.mjs` 每 30 秒探一次，连续 3 次不可达（约 90 秒）自退。pet 测试 24 项（+6 孤儿保护）。
12. ⬜ **dsh-pet `externalBrain` 补丁**（可选）：严格只走 pet-brain、失败不回落普通模型；文件参照 `pet-brain/patches/dsh-pet-external-brain.md`。
13. ⬜ **语义检索：本地 embedding + sqlite-vec（v2，暂不实现）**
    - ✅ 选型：`sqlite-vec`；LEANN 已评估，仅作为 50 万 chunk 以上的备选（见 `memories/40-decisions/2026-10-24-1500-semantic-search-sqlite-vec.md`）。
    - 目标：泛问/语义问法（“有意思的事”“那次说的那个”）能命中；FTS 仍是主路径，向量只做混合排序。
    - 方案：本地 embedding（`bge-small-zh` 或 `bge-m3`，ONNX/llama.cpp/Ollama 常驻），`sqlite-vec` 存 chunk 向量；`score = α·BM25 + (1-α)·cosine`，α 初定 0.5。
    - 数据：现有约 545 chunk 全量回填；512 维 float32 ≈ 2 KB/chunk，1 万 chunk ≈ 20 MB；新增/重建索引时同步写向量。
    - 接口：`/v1/recall` 与 `/v1/search` 请求不变；内部检索层加向量通道；模型不可用时**静默退回 FTS**，绝不阻塞对话。
    - 成本：开发 2–4 天；常驻内存 200–500 MB；查询 +10–30 ms；Windows 下 sqlite-vec 扩展加载需先验证。
    - 验收：`verify-recall.mjs` 的语义查询有提升；FTS 基线不下降；模型缺失时自动降级；索引重建可复现。
    - 前置：v2 的 memd/模型进程自启与看护；否则模型挂了检索会退化。
14. ⬜ **图片/文档接口**：需求已有，v1 未做。
15. ⬜ **多设备/VPS 联邦**：ZeroTier 内网只读副本或双向同步。
16. ⬜ **静态加密与密钥轮换**；`secret` 的写入通道（现在一律拒写）。
17. ⬜ **MCP 场景感知**：桌面 root 视图符合设计；将来若桌面会话共享，需要按会话下发场景令牌。

## 待决策

- **pet 是否看群聊**：现在是 owner 的 main/qq:owner + shared，不含 `qq:group:*`；「全部 − 工作/财务」要不要包括群？
- **设置页令牌存 localStorage**：本机可接受；若要更严，改为每次输入不落盘。
- **短期 JSONL 保留多久**：现在 append-only 永久保留，归档策略待定。
- **回顾频率默认值**：20h 是否合适（可在设置页改）。

## 验收口径（每次都跑）

```powershell
pnpm test                              # 128 项
node scripts\verify-recall.mjs         # 真实语料检索
node scripts\setup-dsh-mcp.mjs --check
node scripts\setup-dsh-plugin.mjs --check
node scripts\setup-dsh-panel.mjs --check
```
