# QQ 桥接接入补丁（P3）

> 状态：**代码已落地，token 已签发并写入 `state/`，`config.json` 已启用；只剩重启桥接。**（2026-10-23 23:20）
> 前置侦察：`QQ-BRIDGE-INTEGRATION.md`（行号按 13138 行 LF 口径，改动后已漂移）。

## 已改动的文件

| 文件 | 改动 |
|---|---|
| `qq-bridge/src/memory/memory-bridge.js` | 新增（从 `memory-hub/packages/adapter-qq/bridge/memory-bridge.js` 复制） |
| `qq-bridge/src/bridge.js` | 8 处：import、`cfg.memory` 默认值、`createMemoryBridge` 初始化、`buildWakePromptV2/Core` 第三参数、`longMemoryLine` 拼接、唤醒前 `recallBlock`、唤醒前 `recentFacts`（2026-10-28）、`memory-append` 后 `mirrorWrite` |
| `qq-bridge/config.example.json` | 新增 `memory` 段（默认 `enabled: false`） |
| `qq-bridge/start-stack.ps1` | 第 2.6 步调用 `memory-hub/scripts/start.ps1`，memd 随 stack 自启（失败不阻断） |

`memory-hub` 侧对应产物：`packages/adapter-qq/dist/memory-client.mjs`（`pnpm run build` 生成）。

改动只读验证：

```powershell
node --check qq-bridge\src\bridge.js
node --check qq-bridge\src\memory\memory-bridge.js
node -e "JSON.parse(require('fs').readFileSync('qq-bridge/config.example.json','utf8'))"
```

## 行为

- **唤醒**：`deliverPromptNow` 用最近 2 条非自己消息调 `/v1/recall`，把 `【长期记忆】/【相关记忆】` 插在会话记忆之后、人物档案之前。800ms 超时、每 key 5 秒缓存、失败返回空串。
- **最近记得的事**（2026-10-28）：唤醒时额外调一次 `/v1/recent`（k=8，按 scene 过滤），拼成 `【最近记得的事】` 接在召回块后面。它**不看 query、只看写入时间**——`recallBlock` 用最近两条消息做检索，query 一跑题就整块为空，这张摘要补的就是那个缺口（「上周答应过什么」）。10 分钟缓存（不随 query 变），失败返回空串或上次结果，不阻断唤醒。
- **写入镜像**：`/api/socialV2/memory-append` 成功后 fire-and-forget `POST /v1/write`，`(scene, category, target, text)` 哈希做幂等键；失败只记日志。
- **scene**：`group:<id> → qq:group:<id>`；`private:<ownerQQ> → qq:owner`；其余 → `qq:private:<qq>`。模型不能传 scene。
- **降级**：`enabled=false`、产物缺失、memd 挂掉，全部 no-op，桥接行为与改动前一致。

## 认人：看 QQ 号（2026-10-28）

名字不可靠——群名片会改、昵称会撞、群里还会用外号（群里管主人叫「阳光」，名片却是「阳光开朗大男孩er~~」）。所以身份判定只在两处做，都靠号：

| 位置 | 判据 | 渲染 |
|---|---|---|
| 发言者 | `String(event.user_id) === String(cfg.ownerQQ)` | 群上下文「【管理员】名字(QQ xxx)：内容」 |
| 被 @ 者 | `String(at.qq) === String(cfg.ownerQQ)` | 「@名字（管理员）」 |

- `appendRecentMessage` 新增 `userId` 参数并存进消息；`buildContextBlock` 渲染时带 `(QQ xxx)`。
- `segmentsToText` 的 `at` 分支在解析出名字之后仍保留 QQ 号用于判定，调用点传入 `ownerQQ`。
- 快照（`/api/socialV2` 的 unread/recent）本来就有 `userId`，`compactModelMessage` 只删 `isOwner: false`，所以 `isOwner: true` 会保留。
- preset 侧配了一句【认人：看号不看名】，并明确「QQ 号只给自己判断用，不要写进对群友的回复」。

## 主人主动提起 → 临时可见（2026-10-24）

- 桥接把最近消息里发送者是 `ownerQQ` 的标成 `from_owner: true` 传给 `/v1/recall`（模型不能自己传）。
- 服务端因此临时放开「owner 本人的记忆」（audience 属于 `main` / `qq:owner`），结果带 `disclosure: "owner_initiated"`；桥接在注入文本里标「（对方自己提起过的记忆）」。
- 不放开：敏感记忆仍要求 `sensitive:read` + audience ∈ `sensitiveAudiences`（默认 main/qq:owner）；其他人的私聊（`qq:private:*`）不放开；`secret` 永不读。只影响 recall，`search`/`get` 权限不变。
- 说还是不说，由她按场合判断（`AGENTS.md` 第六节）。

## 为什么群里看起来「没有记忆」

2026-10-23 实测结论：注入是通的，群场景拿到的是 `【长期记忆】` 身份行 + **0 条相关记忆**。

- 群 token 只能读 `shared` + `qq:group:<本群>`；`40-decisions`、`50-knowledge`、日志这些默认 `main`，按需求 §2 就不进群。
- 「本群记忆」要等 `qq_memory_append` 写入后镜像过来（`kind=qq-topic|qq-impression`，audience 是本群）。目前 `facts=0`，所以群里没有可召回的本群内容。
- 验证方法：用群 token 写一条 `qq-topic`（audience 本群）→ 群场景 `recall` 立刻出现 `【相关记忆】`；删掉、`reindex --force` 后恢复 0。

想让群记住东西，两条路：

1. 让她在群里用 `qq_memory_append` 记群话题 / 群友印象，镜像会自动落成 `qq-topic`/`qq-impression`（推荐，符合「受众由我维护」）。
2. 明确把某条知识发布到群可见：写入时 `audience: ["qq:group:10001"]`（或 `shared`），相当于主动选择共享，不做隐式放宽。

## 激活状态（2026-10-23 23:20）

| 步骤 | 状态 |
|---|---|
| 按 scene 签发 token | ✅ `scripts/issue-qq-tokens.mjs` 已跑：1 个 group、1 个 owner、5 个 private（ID 见脚本输出） |
| token 写进 `qq-bridge/state/` | ✅ 7 个 `memory-*.token`（ACL 目录，非沙箱写入） |
| `config.json` 打开 `memory` | ✅ `enabled: true` + `tokens` 映射全量；备份 `config.json.bak-2026-10-23T15-18-33-157Z` |
| 重启桥接 | ⬜ **待做**（见下） |

签发脚本可重复执行：同名 token 会先吊销再发新的，不会堆积。

### 只剩：重启桥接

```powershell
# 普通 PowerShell（非沙箱）：
cd D:\deepseek_workspace\qq-bridge
# 停掉 3100 上的旧进程
Get-NetTCPConnection -LocalPort 3100 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
# 用启动链重新拉起（-StartDsh 0 表示不代启 DSH；DSH 已在跑）
# 注意：-File 模式下 -StartDsh $false 会被当字符串，参数转换报错，必须写 0 或 1
powershell -ExecutionPolicy Bypass -File .\start-stack.ps1 -StartDsh 0
```

> 沙箱里不要做：后台子进程会随命令结束被回收，QQ 会掉线。重启后看 `logs\stack.log` 与桥接日志，确认 `memd` 与桥接都起来。

### 验证

- owner 私聊说「你还记得上次桌宠的事吗」→ 唤醒提示里出现 `【长期记忆】`；
- 群聊里说「股票」→ 不出现工作/股票内容（group token 无 `sensitive:read`，且每个场景走自己的 token）；
- 未映射的私聊 → 完全没有记忆块（**没有回退**，避免串权）；
- 停掉 memd → QQ 仍正常回复，只是没有记忆块。

## 附：按 scene 签发 token 的原始命令

```powershell
$cli = "D:\deepseek_workspace\memory-hub\packages\admin\dist\cli.js"
node $cli token issue --name qq-group-10001 --surface qq:group:10001
node $cli token issue --name qq-owner --surface qq:owner --scope "*" --scope "sensitive:read"
node $cli token issue --name qq-private-10002 --surface qq:private:10002
```

或者直接跑 `node memory-hub\scripts\issue-qq-tokens.mjs`（读 `qq-bridge/config.json` 的 `allow` 自动发全套，写到 `memory-hub/data/qq-tokens/`）。

## 验证

- owner 私聊说「你还记得上次桌宠的事吗」→ 唤醒提示里出现 `【长期记忆】`；
- 群聊里说「股票」→ 不出现工作/股票内容（group token 无 `sensitive:read`，且每个场景走自己的 token）；
- 未映射的私聊 → 完全没有记忆块（**没有回退**，避免串权）；
- 停掉 memd → QQ 仍正常回复，只是没有记忆块；
- `GET /v1/health` 的 `index.facts` 随 QQ 写入增长。

## 回滚

- 代码：`git checkout`（若无 git，恢复 `.bak`）；`config.json` 里 `memory.enabled=false` 等价关闭。
- 不改 `state/` 结构与 `social-v2.json` 格式，回滚不需要数据迁移。

## 未做（v1 之外）

- `memory-update/remove/clear` 的镜像（v1 只镜像 append）。

## 补充（2026-10-24）：QQ 读工具已接

桥接新增三个端点，全部用**该会话自己的 scene token** 查，可见范围与唤醒注入一致：

```text
POST /api/socialV2/memory-search  { key, query, k? }   -> { ok, key, scene, count, items }
POST /api/socialV2/memory-get     { key, id }          -> { ok, key, scene, item }
POST /api/socialV2/memory-recent  { key, k? }          -> { ok, key, scene, count, items }
```

MCP 工具层新增 `qq_memory_search` / `qq_memory_get` / `qq_memory_recent`，参数都是 `key` + `token`（+ `query`/`id`/`k`），走 `x-agent-token` 鉴权；开关沿用 `socialV2.tools.memory`。

这样 QQ 会话不必用 root token 的 `mcp__memory_*`，群只能看到 shared + 本群，第三人私聊也只能看到自己的。

生效条件：重启桥接（端点）+ 重启 DSH（新 MCP 工具）各一次。

## 补充（2026-10-24）：镜像 update / remove / clear

v1 只镜像 append；现在编辑和删除也会同步到 memd：

- memd 新增 `POST /v1/forget`：接受 `id` 或 `idempotency_key`，写一行 `deleted:true` tombstone 到 facts JSONL，再删索引；重建索引不会复活（tombstone 在 indexFacts 里跳过并删除）。
- 桥接的 `memory-update`：先按**旧文本**的 idempotency key forget，再写新文本；`memberImpression` 按旧/新 target 分别 forget/write。
- `memory-remove`：删掉 activeTopic/pendingThought 文本或群友印象时同步 forget（印象用旧 traits + target）。
- `memory-clear`：清空前把该类别现存条目逐条 forget。
- 权限：`/v1/forget` 只允许 root 或**同一 scene** 的 token；跨场景返回 403。

生效：重启桥接（新代码）+ 重启 memd（新端点）各一次。

## 补充（2026-10-24）：QQ 会话隐藏 root 记忆工具

`mcp__memory__*` 用的是桌面 root token（scope `*`、surface main），不认会话场景。QQ 预设的 `qq-tool-restrict.mjs` 现在把这 9 个工具加进了 restrict 名单：

- 群/私聊/第三人会话里，工具清单不再出现 `mcp__memory__*`（执行期白名单本来也会拒绝，这次是连 schema 一起隐藏，省 token 且避免误调）；
- 正确的入口是 `qq_memory_search` / `qq_memory_get` / `qq_memory_recent`（按会话 scene token，群只能看 shared + 本群）；
- 桌面/主会话不受影响，仍用 root 工具。

注意时序：MCP 工具是**异步注册**的，预设 `apply` 时 `restrict()` 常因 “unknown global tool” 被跳过，所以第一版只做到执行期拒绝（模型仍看得见）。现在 `apply` 之后 1.5s / 5s 各有一次重试，并在首次 `agent/pre-step`（工具已注册）再 restrict；若第一条消息时还看得见，第二条起会消失，执行期拦截始终有效。

## 补充（2026-10-24）：DSH 端口自愈

`dsh.baseUrl` 留空即自动识别；DSH 桌面版每次重启换随机端口时：

- 启动时若显式端口连不上 → 自动降级到发现模式（进程监听端口 + 401 特征文字 `dsh web authentication required`）；
- 运行中连续 3 次「0 帧断开」→ 切自动模式并 10 秒内重连；
- `start-bridge.ps1` 的 `Test-DshPort` 也改成校验特征文字：本机有个 2013 端口同样回 401（空 body），只看状态码会把配置写成它；
- 残留 DSH 实例仍可能被选中（同样是 DSH 特征），日志会写明实际连的地址，遇到就关掉旧窗口。
