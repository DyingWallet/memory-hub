# memory-hub 研发计划（2026-10-24）

> 用途：一页看清「目标 → 已完成 → 待办 → 风险」。执行细节看 `RUNBOOK.md`，取舍看 `IMPLEMENTATION-NOTES.md` 与 `memories/40-decisions/`。

## 目标与原则

1. **一个星形记忆库**：主人是中心，看得到全部；群只看 shared + 本群；第三人私聊只映射自己；工作/财务只进 main 与 qq:owner。
2. **隐私是代码不是自觉**：能用 SQL/令牌拦的，不靠提示词。
3. **会遗忘**：普通聊天进短期层（TTL + 召回延长），每日回顾由模型挑重要的转长期。
4. **可运维**：本机优先、离线可跑、索引可重建、原文 append-only。

## 阶段与状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 核心 | 协议 / 索引 / 检索 / 鉴权 / 审计 / 管理 CLI / SDK | ✅ v1 已上线 |
| P1 接入 | DSH MCP（9 工具）、QQ 桥接（注入/镜像/读工具/入库）、DSH 全会话上报插件、只读设置页 | ✅ 实测通过 |
| P2 隐私 | 标签可配置、owner 临时披露、QQ 隐藏 root 工具、secret 不可读 | ✅ 基本闭环，剩镜像与审计保留 |
| P3 桌宠 | dsh-pet 0.3.8 + pet-brain 接入（recall/ingest、pet 场景、免工作/财务） | ✅ 已安装并实测（桌面形态） |
| P4 设置页 | 可编辑隐私/TTL/回顾频率、token 管理 | 🔶 只读状态页已完成 |
| P5 质量与运维 | 回顾定时、合并去重、保留策略、备份、监控 | ⬜ |
| P6 扩展 | 语义检索、图片/文档、多设备/VPS、加密、**memd 独立进程自启与看护（v2）** | ⬜ |

## 已完成（可演示）

- 13 个 `/v1` 接口：health / capabilities / config-schema / bootstrap / search / get / recent / recall / write / ingest / review / persist / audience。
- SQLite FTS5 + 中文 bigram；`chunk_scopes` 做 SQL 级可见性；`core/policy.ts` 与 SQL 规则互为镜像。
- 令牌模型：surface + scopes + scenes，scrypt 哈希，文件 mtime 热重载；审计只记 id/hash/scope。
- 短期记忆：`stage=short`、TTL 24h、召回延长（base×2^n 封顶 7 天）、每小时 purge、JSONL 保留。
- 每日回顾：`/v1/review` 候选、`/v1/persist` 转长期、召回回传 `review.should_review`；QQ 唤醒提示「【记忆回顾】」。
- 隐私：audience + 一个敏感位（`normal/personal/sensitive/secret`）；敏感记忆钉在 `sensitiveAudiences`、需要 `sensitive:read`；旧标签已迁移成 `privacy=sensitive` + `tags`。
- owner 临时披露：`from_owner` → recall 带 `disclosure: owner_initiated`，敏感/他人私聊不放开。
- DSH：MCP 9 工具 + 全会话短期上报插件；客户端设置页（只读状态）。
- QQ：逐场景 token、注入/镜像、`qq_memory_search/get/recent`、999 窗口（50/批、按 id 去重）、root 记忆工具从预设隐藏。
- 迁移：`import-social` 识别真实 `{paused, conversations}`，实跑 4 条 + 幂等。
- 运维：端口自愈（显式失效自动降级、连续 0 帧切自动）、`start.ps1`/`stop.ps1`、`setup-dsh-mcp`/`setup-dsh-plugin`/`setup-dsh-panel`（均带备份与 `--remove`）。
- 测试：93 项（单测 / 集成 / 隐私矩阵 / 契约 / MCP / 插件 / pet 可见性）。

## 待办（按优先级）

> 详细清单与验收口径见 `TODO.md`（单一待办来源）；本节保留阶段视图。

### P2 收尾（已完成）

1. ✅ **`memory-update/remove/clear` 的镜像**：新增 `POST /v1/forget`（按 id 或 idempotency_key，写 tombstone 后重建索引不会复活）；桥接 `memory-update/remove/clear` 会先忘旧文本再写新文本，memberImpression 按 target 处理。测试 97 项。
2. ✅ **QQ 预设隐藏 root 工具的回归验证**：`test-agent-preset-patches.mjs` 断言 9 个 `mcp__memory__*` 都在 restrict 名单且执行期被拒，`mcp__snowluma__qq_memory_search` 仍放行。
3. ✅ **审计保留**：`AuditLog.prune(30 天)` 启动时执行；新增 `tests/unit/audit.test.ts` 验证旧行被删、新行保留、坏行丢弃。

### P3 桌宠接入（已完成）

4. ✅ **pet 场景与令牌**：`pet` token（scopes `main/qq:owner/pet`，无 `sensitive:read`，scenes 含 pet）；活库实测敏感/私聊/群内容 0 命中。
5. ✅ **pet-brain 记忆客户端**：`src/memory.mjs`，`/v1/recall`（scene=pet）拼进 prompt、`/v1/ingest` 上报用户与回复（50/批、失败静默）。
6. ✅ **避免双写**：`dsh-memory` 插件识别 `agentPreset === 'pet-chat'` 时跳过。
7. ✅ **pet 视图边界**：新增 `tests/privacy/pet.test.ts`（工作/群/私聊不可见、owner 可见、pet 短期可被 owner 审计）。
8. ✅ **联调 + 本体安装**：`dsh-pet` 0.3.8 已装（`dsh plugin add`），`pet-brain/xi` 路由已注册；`/dsh-pet-7340/config` 显示 `chatModel=pet-brain/xi`；`/chat` 实测回复正常、工资问题不含 1280；audit `recall|pet` + `ingest|pet` 持续写入，pet 短期已 13 条。

### P4 设置页可编辑（已完成）

9. ✅ **写接口**：`GET /v1/config-state` + `POST /v1/config`（root token，白名单字段：`shortTerm.*` / `privacy.sensitiveScope` / `privacy.sensitiveAudiences` / `privacy.ownerAudiences`）；写前备份、`loadConfig` 复验、热应用到运行中的 config。
10. ✅ **UI 表单**：root 令牌输入 + 短期 TTL/回顾参数/自动分类 + 隐私标签 JSON 编辑 + token 列表/吊销；保存前二次确认；走 DSH 同源代理，热生效。
11. ✅ **权限**：配置与 token 接口只接受 root token（group 403）；字段白名单 + 范围校验；token 列表不带 hash，吊销立即生效。

### P5 质量与运维

12. ✅ **回顾定时任务**：memd 每 10 分钟检查，到期写 `review:pending:<scene>`；`recall` 带 `should_review/reminder_since`；`/v1/review` 清提醒并记 `review:last`（`status_only` 只读）。
13. ✅ **合并/去重**：写入时同 `scene+kind+文本+audience+privacy` 复用 id；回顾转长期时按相似度折叠（CJK bigram + 词 Jaccard ≥ 0.8），`merged:[{from,into}]`，短的 tombstone。
14. ✅ **保留与归档（默认关闭）**：`config.archive.enabled` + `keepMonths`，设置页可开关；开启后 `pnpm archive:facts` 月末归档 gz（校验后删原文件），indexer 读 gz，`--force` 临时执行。
15. ✅ **备份自动化**：`scripts/backup.mjs` 每日快照（memories + tokens + config + manifest，keepDays 清理，同日覆盖）；`install-backup-task.ps1` 计划任务；RUNBOOK 含恢复演练。
16. ✅ **监控**：`scripts/monitor.mjs` 采样 health 到 `data/metrics.csv`（延迟/计数/失败原因），`--loop` 或 `install-monitor-task.ps1` 定时；`verify-recall.mjs` 手动回归。
17. 🔶 **测试补强**：adapter-qq 客户端测试 + 设置页 bundle 冒烟 + `verify-recall` 已做（125 项）；真实 DSH 会话 e2e 仍手动。

### P6 扩展

18. 语义检索（embedding + 混合排序）；图片/文档接口（需求 § 已有但 v1 不做）。
19. 多设备/VPS 联邦（ZeroTier 内网、只读副本或双向同步）。
20. 静态加密与密钥轮换；`secret` 的写入通道（现在一律拒写）。
21. 其他 surface（未来新客户端复用 adapter 模式；桌宠已列 P3）。

## v2：memd 独立进程自启与看护

已定方案（2026-10-24 决定，**放到 v2 实现，不挂 DSH 子进程**）：

1. `scripts/install-autostart.ps1`：注册两个计划任务（当前用户、无需管理员）——
   - `memd`：`AtLogOn` 跑 `start.ps1 -NoWait`；
   - `memd-watchdog`：每 5 分钟跑一次 `start.ps1 -NoWait`，已健康则立即退出（幂等补起）。
2. `scripts/uninstall-autostart.ps1`：删除任务。
3. 为什么不挂 DSH 子进程：DSH 每次重启换端口且重启频繁，子进程会随之死掉（今天已发生两次），还会把 DSH 的 fail-loud 崩溃耦合进记忆服务；QQ 桥接、桌宠、未来的 VPS 副本都不应依赖“DSH 桌面版开着”。
4. 验收：重启 DSH 后 memd 仍在；`Get-Process` 只有一个 memd；`stop.ps1` 后看护任务 5 分钟内补起；`setup-dsh-* --check` 全绿。

## 里程碑

- **v1.0**：核心 + DSH + QQ + 短期/回顾 + 只读设置页。✅
- **v1.1**：P2 收尾 + P3 桌宠（dsh-pet 本体 + 记忆接入 + 气泡自愈）。✅
- **v1.2**：P4 可编辑设置页（TTL/回顾/自动分类 + 同源代理）。✅ 表单完成，剩隐私标签与 token 管理。
- **v1.3**：P5 质量与运维（回顾定时、合并去重、归档备份、监控）。
- **v2.0**：memd/pet-brain 独立进程自启与看护 + P6 语义检索 / 多设备。

## 验收口径（每个版本都跑）

```powershell
pnpm test                       # 100 项，全绿
node scripts\verify-recall.mjs  # 真实语料检索
node scripts\setup-dsh-mcp.mjs --check
node scripts\setup-dsh-plugin.mjs --check
node scripts\setup-dsh-panel.mjs --check
```

## 风险与待决策

| 风险 | 影响 | 建议 |
|---|---|---|
| `mcp__memory__*` 在桌面会话是 root 视图 | 桌面会话能看到全部（符合设计）；若未来把桌面会话给别人用就过宽 | 需要时按会话下发场景令牌，MCP 改为每次请求带 scene |
| 回顾靠唤醒触发 | 长期不唤醒就不回顾 | P5 加定时任务 |
| 短期层写入量（QQ 999 回填） | 首次可能写数百条；24h 后清 | 已实测 149 条 facts，空间 <0.3 MB；无需干预 |
| JSONL 永久保留 | 磁盘单调增长（每年约几十 MB） | P5 归档 |
| DSH 内部 API 变更 | 插件/预设可能随版本失效 | 锁版本 + 启动自检（`setup-dsh-* --check`） |
| 设置页写接口 | 本机任意进程可改配置 | 只回环 + 二次确认 + 白名单字段；token 签发仍 CLI |
