# RUNBOOK — memory-hub 运维手册

> 面向本机（Windows）部署。协议与设计见 `IMPLEMENTATION.md`；DSH 接入见 `SPIKE-DSH.md`；QQ 桥接落点见 `QQ-BRIDGE-INTEGRATION.md` / `QQ-BRIDGE-PATCH.md`。
> 2026-10-24：隐私模型已收敛为「audience + 一个敏感位」，旧标签（work/financial/…）已迁移成 `privacy=sensitive` + `tags`。

## 1. 前置

| 项 | 值 |
|---|---|
| Node | `D:\Software\dsh\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`（v24.21.0） |
| pnpm | `...\dependencies\pnpm\bin\pnpm.mjs`（用上面的 node 跑） |
| 工作区 | `D:\deepseek_workspace\memory-hub` |
| 数据 | `memory-hub\data\`（index.db / tokens.json / audit.jsonl） |
| 记忆源 | `memories\`（`facts\*.jsonl` 是唯一真源；Markdown 文档在 `10-journal/` 等） |
| 监听 | `127.0.0.1:8787` + ZeroTier `172.22.0.10:8787`；`loadConfig` 拒绝 `0.0.0.0` |

## 2. 启停与健康

```powershell
# 后台启动 + 等 health（已在线时只做 health-check）
powershell -ExecutionPolicy Bypass -File scripts\start.ps1

# 只发后不管
powershell -ExecutionPolicy Bypass -File scripts\start.ps1 -NoWait

# 前台（开发用）
powershell -ExecutionPolicy Bypass -File scripts\start.ps1 -Foreground

# 停止
powershell -ExecutionPolicy Bypass -File scripts\stop.ps1

# 健康
node packages\admin\dist\cli.js health
```

日志在 `logs\memd.log`。索引可随时重建（JSONL 是源）：

```powershell
node packages\admin\dist\cli.js reindex --force
```

## 2.5 自启与看护（v2）

memd 是独立进程，不挂 DSH 子进程（DSH 每次重启换端口、重启频繁，子进程会跟着死）。
整个 memory-hub 只注册**一个**计划任务，每分钟跑一次 `scripts\supervisor.mjs`：

```powershell
# 注册（当前用户、无需管理员；必须在**非沙箱** PowerShell 里跑）
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1

# 看状态（先看这里再排查）
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Check

# 删除（先删任务再 stop，否则看护任务 1 分钟内又把它拉起来）
powershell -ExecutionPolicy Bypass -File scripts\uninstall-autostart.ps1
powershell -ExecutionPolicy Bypass -File scripts\stop.ps1
```

| 任务 | 触发 | 动作 |
|---|---|---|
| `memd-watchdog` | 每 1 分钟 | `wscript run-hidden.vbs` → `node scripts\supervisor.mjs` |

`supervisor.mjs` 每分钟做三件事，顺序固定：

1. **探活** `/v1/health`，不在就用 `scripts\start.ps1 -NoWait` 拉起来（最常见的情况什么都不做）；
2. `data\metrics.csv` 超过 60 分钟没更新 → 跑一次 `scripts\monitor.mjs`；
3. 今天的备份目录不存在且已过 04:00 → 跑一次 `scripts\backup.mjs`（失败后同一小时内只重试一次，记在 `logs\supervisor-state.json`）。

- **为什么合成一个**：原来是四个任务（登录、看护、监控、备份），触发器各写一份，改一个忘三个；现在只有一个触发器、一份日志。
- **动作链**：任务计划直接跑控制台程序必闪黑框（窗口在程序启动前就创建），所以走 `wscript.exe + scripts\run-hidden.vbs`（window style 0）。`supervisor.mjs` 自己写日志，不需要中间垫 powershell。
- **看护是否真的在跑**：`logs\task-last-tick.txt` 每次触发覆盖（含本次动作摘要，如 `memd=up` / `memd=restarted`）；有动作时才追加 `logs\supervisor.log`。`-Check` 会打印最后心跳与最后事件。
- 幂等：`start.ps1` 先探 `/v1/health`，已在线就只做 health-check，所以和 `start-stack.ps1` 第 2.6 步撞上也无害。
- 沙箱身份下 `Get-ScheduledTask` / `schtasks` 一律「拒绝访问」（低完整性进程，连 `New-ScheduledTaskSettingsSet` 都会拒），装/查任务请用普通 PowerShell 窗口。
- `schtasks /TR` 有 **261 字符上限**：动作串更长时（隐藏启动器就接近上限）先用 `schtasks` 建出无限期重复的触发器，再用 `Set-ScheduledTask -Action` 换动作。
- **pet-brain 没有登录任务**：它只服务 DSH 的 `pet-chat` preset，跟着 DSH 生命周期——`qq-bridge\start-stack.ps1` 第 2.7 步在 DSH 起来后拉起它，DSH 关闭/崩溃后它自己退出（每 20 秒探一次，连续 3 次不可达约 60 秒退出，见 `dsh-pet-configurable-llm/src/guard.mjs`）。调试时可 `PET_LLM_ORPHAN_GUARD=0` 关掉。

## 3. 令牌

签发（明文只显示一次）：

```powershell
# 主会话（可读敏感）
node packages\admin\dist\cli.js token issue --name desktop-main --surface main --scope "*" --scope "sensitive:read" --scene main

# owner 的 QQ 私聊
node packages\admin\dist\cli.js token issue --name qq-owner --surface qq:owner --scope "*" --scope "sensitive:read" --scene qq:owner

# 某个群（无敏感能力）
node packages\admin\dist\cli.js token issue --name qq-group-<id> --surface qq:group:<id> --scope qq:group:<id> --scene qq:group:<id>
```

- 列表 / 吊销：`token list`、`token revoke <id>`；设置页也能吊销。
- 记录在 `data\tokens.json`，按 mtime 热重载，吊销**下一个请求**生效。
- `work:read` 仍被当作 `sensitive:read` 的别名接受；新 token 请用 `sensitive:read`。
- 桌面 root token 在 `%USERPROFILE%\.dsh\memory-token`；QQ 场景 token 在 `qq-bridge\state\memory-*.token`；桌宠在 `pet-brain\state\memory.token`。

## 4. API 速查（`/v1`）

| 接口 | 用途 |
|---|---|
| `POST /v1/write` | 写事实（`kind/text/audience/privacy/tags`） |
| `POST /v1/search` | 全文检索（bigram FTS5） |
| `POST /v1/get` | 按 id 取一条 |
| `POST /v1/recent` | 最近文档 |
| `POST /v1/recall` | 会话召回（短期+长期+audience 卡） |
| `POST /v1/disclose` | 跨场景披露：只给**一个群**的 chat/note（`disclose:group` 令牌；成员校验在桥接侧） |
| `POST /v1/ingest` | 普通聊天入短期记忆 |
| `POST /v1/review` | 待回顾的短期记忆（`status_only` 只报状态和计数） |
| `POST /v1/persist` | 回顾后转长期 |
| `POST /v1/forget` | 按 id 或 idempotency_key 遗忘（tombstone） |
| `GET /v1/config-state` | 读可编辑配置（root） |
| `POST /v1/config` | 改 `shortTerm.*` / `privacy.*`（root） |
| `GET /v1/tokens` / `POST /v1/tokens/revoke` | token 列表 / 吊销（root） |

约定：所有接口 `Authorization: Bearer msv1...`；错误体 `{error:{code,message}}`；`/v1/health` 公开。

`/v1/write` 按 `scene + kind + 规范化文本 + audience + privacy` 做内容去重：重复写入返回已有 `id` 和 `duplicate:true`，不再追加 JSONL。不同 audience 的同文仍是两条；`idempotency_key` 仍然优先。

## 4.5 隐私：audience + 一个敏感位

可见性只有两条轴：**audience（在哪些场景）** 和 **sensitive（是否敏感）**。`work` / `financial` 等不再是权限标签，只是 `tags`。

```json
"privacy": {
  "sensitiveScope": "sensitive:read",
  "sensitiveAudiences": ["main", "qq:owner"],
  "ownerAudiences": ["main", "qq:owner"]
}
```

- `privacy` 取值：`normal` / `personal` / `sensitive` / `secret`。
- `sensitive` 记忆自动钉到 `sensitiveAudiences`，读取需要 token 带 `sensitiveScope`；`normal`/`personal` 只看 audience。
- root（`*`）也不能绕过敏感位：读 `sensitive` 仍要 `sensitive:read`。
- `secret` 永远不可读、不可写。
- 接入新平台（微信等）时，把 `wx:owner` 加进 `sensitiveAudiences` 与 `ownerAudiences` 即可，不用改代码。
- 设置页可改这三个字段，保存即热生效并备份 `config.json.bak-*`。
- 群/私聊写敏感记忆会被 audience/capability 拒绝（403），桥接镜像静默失败——属预期。
- 测试：`tests/unit/policy.test.ts`、`tests/privacy/privacy.test.ts`、`tests/privacy/policy-config.test.ts`。

### 4.5.1 迁移旧标签（已完成，保留供参考）

旧 `privacy=work|financial|health|relationship|legal|id_docs` 的事实已在 2026-10-24 迁移：

- 事实 JSONL：`privacy` 改成 `sensitive`，原标签写进 `tags`；
- token：`work:read` → `sensitive:read`（token 字符串不变，hash 仍有效）；
- `config.json`：改为上面的三段式；备份 `*.bak-p5`；
- 删除索引让 memd 从 JSONL 重建。

## 4.6 短期记忆与每日回顾

普通聊天落成 `stage=short`，带 `expires_at`；召回会延长 TTL（`base × 2^n`，封顶 `maxTtlHours`），每小时 purge。

```json
"shortTerm": {
  "enabled": true,
  "ttlHours": 24,
  "maxTtlHours": 168,
  "reviewLookbackHours": 72,
  "reviewLimit": 30,
  "reviewIntervalHours": 20
}
```

- 唤醒时若 `should_review` 为真，用 `memory_review` 看候选，挑重要的 `memory_persist` 转长期，其余自然过期。
- **每日定时**：memd 启动时 + 每 10 分钟检查一次；到期且有短期候选就把 `review:pending:<scene>` 写进 `meta`。之后任何一次 `recall` 都会带 `review.should_review=true` + `reminder_since`，不依赖“正好那一刻有人说话”。
- `POST /v1/review`（非 `status_only`）会清掉提醒并记录 `review:last:<scene>`；`status_only` 只读，不清。
- 设置页可改这几个值；`reviewIntervalHours` 是提示节奏，不是硬删除。
- 短期记忆对 pet/群同样按隐私过滤；`persist` 后变长期。
- **转长期折叠**：`/v1/persist` 先在同一场景的长期事实里找相似文本（规范化后相同，或 CJK bigram/词 Jaccard ≥ 0.8 且长度接近），命中就不新增，把短的写 tombstone，返回 `merged:[{from,into}]`；`persisted` 里只列真正升级的 id。

## 4.7 月度归档（默认关闭）

数据量很小，归档是**可选**功能，默认不启用：

```json
"archive": { "enabled": false, "keepMonths": 12 }
```

- `enabled=false` 时脚本直接退出，不会动任何文件；
- 开启后，比「当前月往前 `keepMonths` 个月」更老的月份会被归档；当前月与最近 N 个已结束月份保持明文；
- 设置页也有「月度归档」勾选和「保留最近几个月」。

```powershell
pnpm archive:facts                 # 按配置归档（enabled=false 时不动）
pnpm archive:facts --dry-run       # 只看会动哪些文件
pnpm archive:facts --force         # 临时跑一次，不看 enabled
pnpm archive:facts --keep-months 3 # 临时覆盖保留月数
```

- 输入 `memories/facts/YYYY-MM.jsonl`，输出 `memories/facts/archive/YYYY-MM.jsonl.gz`；
- 写 gz 后先 `gunzip` 回读比对，字节一致才删除原文件，不一致就跳过并报告；
- 当前月份不动；重复执行幂等；
- indexer 透明读取 `.jsonl.gz`，`reindex --force` 仍能看到归档月；
- 归档月份的 fact 被 forget 时，tombstone 追加到**当前活动分片**（归档文件只读）；
- 建议每月 1 号手动跑一次，或以后并入 v2 的定时任务。

## 5. DSH 接入

**一条命令装完**（幂等，需普通 PowerShell 窗口——`~/.dsh` 对沙箱只读）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-all.ps1                 # 构建 + MCP + 令牌 + 两个插件
powershell -ExecutionPolicy Bypass -File scripts\setup-all.ps1 -WithAutostart  # 顺带注册看护任务
powershell -ExecutionPolicy Bypass -File scripts\setup-all.ps1 -Semantic       # 顺带下模型 + 开启语义 + 回填
powershell -ExecutionPolicy Bypass -File scripts\setup-all.ps1 -Check          # 只自检（= node scripts\doctor.mjs）
powershell -ExecutionPolicy Bypass -File scripts\setup-all.ps1 -Uninstall      # 反向卸载
```

做完只需**重启一次 DSH**（MCP server 与插件的加载时机）。脚本不会自己重启 DSH——那会把你正在用的会话一起杀掉。

单独自检：

```powershell
node scripts\doctor.mjs          # 表格；核心项全绿才 exit 0
node scripts\doctor.mjs --json   # CI / 脚本消费
```

doctor 检查项：构建产物、两个插件（dep/bundle/linked）、MCP 注册块、root 令牌、memd 健康、
语义状态（提示项）、模型目录（提示项）、看护心跳（提示项）。

**令牌是幂等的**：`setup-dsh-mcp.mjs --with-token` 发现 `~/.dsh/memory-token` 里的令牌仍然有效就复用，不会每次部署都换一个（换令牌会让面板/桥接里已配好的副本集体失效）。

### 5.1 全会话短期上报（`plugins/dsh-memory`）

`agent/pre-step` 把用户消息发到 `/v1/ingest`（scene=main），跳过含「【会话令牌】」的桥接会话；按 50 条/批，失败静默（memd 不在线不能拖垮 DSH）。

### 5.1.1 设置页（`plugins/dsh-memory-panel`）

设置 → 记忆服务。页面在 DSH 渲染帧里运行，**不能直连** `127.0.0.1:8787`：Chromium 152 的 Local Network Access 会拦掉不透明来源的本机请求（症状：`Failed to fetch`，请求无 Origin）。host 半侧注册了固定同源代理：

```text
GET  /memory-hub/health        -> memd /v1/health
GET  /memory-hub/config-state  -> memd /v1/config-state   （需 Authorization）
POST /memory-hub/config        -> memd /v1/config         （需 Authorization）
GET  /memory-hub/tokens        -> memd /v1/tokens         （需 Authorization）
POST /memory-hub/tokens/revoke -> memd /v1/tokens/revoke  （需 Authorization）
```

- **令牌零配置**：页面不带 `Authorization` 时，host 半侧自动注入 `%USERPROFILE%\.dsh\memory-token`
  （可用 `MEMD_TOKEN_FILE` 覆盖）。想手动指定某个令牌时，在页面里填就会被转发、覆盖宿主令牌；
  输入框已改成 300 ms 防抖（以前每敲一个字符发两个请求）。
- 可改短期参数、隐私三段式、月度归档，以及**语义检索开关**（勾选并保存即热生效）；
- 语义检索那一行的状态会跟着 `config-state.semantic` 走：
  - 关：`只走 FTS（子串/关键词）`；
  - 开且就绪：`已就绪：N 个向量（512 维，α=0.5，模型 …）`；
  - 开但不可用：红色显示原因（如 `model missing: …`）并提示去跑 `pnpm fetch:model` + `pnpm embed`。
  **开关本身不会安装任何东西**——不装 npm 包、不下载模型，只是改配置并尝试加载；
- 令牌区可吊销（签发仍走 CLI）；
- 改 host 半侧（`lib/index.js`）必须**重启 DSH**；只改 `client.js` 刷新页面即可。

### 5.2 桌宠（pet-brain）

- 令牌：`pet-brain\state\memory.token`（surface `pet`，scopes `main/qq:owner/pet`，**无 `sensitive:read`**；scene `pet`）。
- 每轮：`POST /v1/recall`（scene=pet）→ 拼进 prompt；`POST /v1/ingest` 上报（50/批、失败静默）。
- 可见性：owner 的 `main/qq:owner` + shared；**看不到**敏感、`qq:group:*`、`qq:private:*`。
- `pet-brain/xi` 由 profile 的 `llm-pi-ai` 提供方指向 `127.0.0.1:8790`。
- 生命周期跟着 DSH（v2 方案 B）：`start-stack.ps1` 第 2.7 步拉起（并把 `DSH_WEB_URL` 传给子进程，省掉首轮端口发现），DSH 关掉后孤儿保护 3 x 20 秒（约 60 秒）自退。**不要**再给 pet 注册登录任务。
- 它自己的看护是 `dsh-pet-configurable-llm/scripts/install-revive-task.ps1` 注册的 `pet-revive`（每 1 分钟）：DSH 在、8790 不在就拉起（DSH 重启超过 60 秒后 pet 会自退，这是补回来的那一手）。日志 `dsh-pet-configurable-llm/logs/revive.log`。
- 失败不回落：pet-brain 内部失败时返回 200 + 降级文案（`src/degraded.mjs`），否则 dsh-pet 会改用普通对话模型回答，看起来还是桌宠但不是那条 DSH 会话。
- 手工起停：`powershell -ExecutionPolicy Bypass -File scripts\start.ps1`（前台）；确认在跑：`curl http://127.0.0.1:8790/health`。
- 气泡层级：启动时对网页 `lib/client.js` 与桌面 `runtime/electron-helper/sprite.js` 各打一次补丁（幂等，`.bak-petbrain`）；桌面 helper 要重启 DSH 才重新加载。

## 6. QQ 桥接

```powershell
# 按场景重签并复制到 ACL 目录（非沙箱）
node scripts\issue-qq-tokens.mjs
Copy-Item data\qq-tokens\*.token qq-bridge\state\ -Force
```

- 桥接只把「轻量记忆」（activeTopic/pendingThought/memberImpression）镜像到 memd；长期召回直接调 `/v1/recall`，memd 挂了桥接照常回复。
- 镜像：append → write；update → forget 旧 + write 新；remove/clear → forget；幂等键 `scene|category|target|text`。

### 6.1 跨场景披露（群友私聊问「刚才群里聊了什么」）

方案 B：**成员校验在桥接，取内容在 memd**。

```text
群友私聊 → 桥接识别意图 → 确定是哪个群 → 查持久化成员表（state/group-members.json）
        → 通过后才调 memd POST /v1/disclose（令牌 disclose:group）
        → memd 只返回该群的 chat/note、normal/personal → 拼进 prompt
```

- **令牌**：`node scripts\issue-qq-tokens.mjs` 现在会多签一个 `qq-disclose`（scopes 只有 `disclose:group`，
  scenes `qq:bridge`），明文在 `data\qq-tokens\memory-disclose.token`；复制到 `qq-bridge\state\`。
  **重新签发会让所有 `state\memory-*.token` 失效**，必须整批覆盖（`Copy-Item data\qq-tokens\*.token qq-bridge\state\ -Force`）。
- **成员表**（`qq-bridge/src/group-members.js`）：落盘在 `state/group-members.json`（0o600，目录已 ACL 收紧），
  三处维护：① `group_increase` / `group_decrease` 事件即时增减；② **每天一次全量对账**
  （启动后 5 分钟一次 + 之后每 24 小时，`GROUP_MEMBERS_BOOT_REFRESH_MS` 可调启动延迟），
  兜住「事件丢失 / 网关闭」这类意外；③ 访问时若条目超过 24 小时或没有基线，再补拉一次。
  拿不到成员表 → **拒绝披露**（fail-closed，不拿旧缓存放行），下次访问会重试。
  重连后漏掉的事件另有 `reconcileGroupMembers` 对账。
- **多群**：提问者只在机器人所在的一个群里 → 直接披露；在多个群里且没点名 → 不猜，
  让模型先问清楚是哪个群（prompt 里给出候选群号）。
- **范围**：只给该群 `chat`/`note`、`privacy IN (normal, personal)`；敏感、secret、私聊、其它群永不包含。
- **限流与留痕**：同一提问者 60 秒冷却；memd 审计写一行 `route=disclose`，带 `group` 与
  `requester_hash`（QQ 号只留哈希，不落明文）。
- **关掉**：桥接 `config.json` 的 `memory.disclosure: false`。
- 纯逻辑测试：`node scripts\test-group-disclosure.mjs`（18 项，不依赖 QQ）。
- 999 条窗口只属于 QQ；`dsh-memory` 插件不限条数。
- owner 自己提起的记忆会带 `from_owner` 做临时披露；不放开 `qq:private:*`，不绕过敏感位。

## 7. 故障排查

| 症状 | 处理 |
|---|---|
| `401 unauthorized` | token 被吊销/拼错；设置页看 `token list`；重新签发 |
| `403 forbidden`（scene） | 请求 scene 不在 token.scenes；换对应场景 token |
| `403`（写敏感） | token 无 `sensitive:read`，或 audience 超出 token scopes |
| 设置页 `Failed to fetch` | 不要直连 8787；用 `/memory-hub/*` 代理；host 改动后重启 DSH |
| memd 起不来 | 看 `logs\memd.log`；`loadConfig` 拒绝非回环 host |
| 记忆「消失」 | 先查 `privacy=sensitive` 与 token 是否带 scope，再看 audience |
| 检索不到旧数据 | `reindex --force` 从 JSONL 重建；确认事实行没有 `deleted:true` |

## 8. 备份与安全检查

### 8.1 每日备份

```json
"backup": { "enabled": true, "dir": "../backups/memory-hub", "keepDays": 14 }
```

```powershell
pnpm backup                 # 生成/替换今天快照，并按 keepDays 清理
node scripts\backup.mjs --force   # 无视 enabled 临时跑一次
```

- 快照目录：`<dir>/YYYY-MM-DD/`（**本地日期**，一天一份，同日重跑覆盖）；
- 内容：`memories/`（facts + archive + docs）、`tokens.json`、`config.json`、`manifest.json`；
- 先写 `.tmp` 再 rename，失败不会破坏上一份；`manifest.json` 记文件数与字节数；
- 清理：早于 `keepDays` 的快照整目录删除；
- 本机默认目录 `D:\deepseek_workspace\backups\memory-hub`，实测 47 个文件 / 约 0.5 MB。

每日定时由看护任务负责（不需要单独注册）：`scripts\supervisor.mjs` 每分钟检查一次，过了
`04:00` 且今天的快照目录不存在就跑一次 `backup.mjs`；失败后同一小时内只重试一次。
要改时刻或关掉备份，改 `config.json` 的 `backup.enabled` / 在 supervisor 里改 `MEMD_SUPERVISOR_BACKUP_AT`。

恢复演练：

1. 停 memd（`scripts\stop.ps1`）；
2. 把快照里的 `memories\` 与 `tokens.json`、`config.json` 拷回原位（先备份当前状态）；
3. `node packages\admin\dist\cli.js reindex --force`；
4. 起 memd，`node packages\admin\dist\cli.js health`，抽查 `memory_search`。

### 8.2 安全

- 审计只记 id/hash/scope，30 天轮转，不含正文。
- token 文件 ACL：`icacls <file> /inheritance:r /grant:r "%USERNAME%:R"`。
- 备份目录含 token 哈希与全部记忆，也应收紧 ACL，不要放同步盘/公共目录。
- 上线前清单：
  - [ ] 只绑 `127.0.0.1` + ZeroTier，不从 `0.0.0.0` 暴露；
  - [ ] `secret` 不可读写；
  - [ ] 敏感只出现在 `sensitiveAudiences`，且 token 要有 `sensitive:read`；
  - [ ] QQ 每场景独立 token，未映射场景不回落；
  - [ ] `pnpm test` 全绿；`node scripts\verify-recall.mjs` 通过。

## 9. 监控

```powershell
pnpm monitor                  # 采样一次，追加到 data\metrics.csv
node scripts\monitor.mjs --loop 900   # 每 15 分钟采样（前台常驻）
```

- 每次采样一行：`at,iso,ok,latency_ms,docs,facts,chunks,uptime_s,error`；
- 固定打 `127.0.0.1:${port}/v1/health`，不依赖绑定的 ZeroTier 地址；
- 3 秒超时；失败也记一行（`ok=0` + `error`），不会中断；
- 文件在 `data\metrics.csv`，一行约 80 字节，每小时采样一年约 0.7 MB；
- 手工看趋势：按天取 `docs/facts/chunks` 最后一行的差值；`latency_ms` 持续 > 200ms 时先查索引大小和磁盘。

自动采样由看护任务负责（不需要单独注册）：`supervisor.mjs` 每分钟检查 `data\metrics.csv` 的
mtime，超过 60 分钟没更新就采样一次。间隔可用 `MEMD_SUPERVISOR_MONITOR_MINUTES` 覆盖。

## 10. 语义检索（可选，默认关）

本地 embedding + `sqlite-vec` + 与 FTS 的混合排序。**关着的时候 memd 不加载模型、不建向量表，
行为和 v1 的纯 FTS 完全一致。**

安装体积（都不进仓库）：

| 东西 | 体积 | 谁装 |
|---|---|---|
| 模型权重 `models/bge-small-zh-v1.5/` | 23 MB | `pnpm fetch:model`（只在要开语义时下） |
| `onnxruntime-node` | 287 MB（含全平台二进制，Windows 实际用 ~50 MB） | `pnpm install`（optionalDependencies） |
| `sqlite-vec` + `sqlite-vec-windows-x64` | 0.3 MB | `pnpm install` |

选择「开箱即用」：`pnpm install` 就把运行时装好，代价是即使不开语义也会占这 287 MB。
要更轻的话可以把 `onnxruntime-node` 从 `optionalDependencies` 挪走、开功能时 `pnpm add`
（2026-10-24 决定：暂时保持开箱即用）。

```powershell
# 1) 下载模型（约 24 MB，落在 models/bge-small-zh-v1.5/，已被 .gitignore 忽略）
pnpm fetch:model

# 2) 打开开关（config.json；也可以走设置页/接口，见下）
#    "semantic": { "enabled": true }

# 3) 一次性回填（默认用 backfillThreads=4；跑完即退，模型不常驻）
pnpm embed

# 只看状态（不回填）
pnpm embed -- --stats
```

运行中开关（root token；立即生效，开 = 建索引 + 先补 256 条向量）：

```powershell
$token = Get-Content "$env:USERPROFILE\.dsh\memory-token" -Raw
Invoke-RestMethod http://127.0.0.1:8787/v1/config -Method Post `
  -Headers @{ authorization = "Bearer $($token.Trim())"; 'content-type' = 'application/json' } `
  -Body '{"semantic":{"enabled":true}}'

# 状态（enabled/ready/vectors/dim/model/alpha）
Invoke-RestMethod http://127.0.0.1:8787/v1/config-state -Headers @{ authorization = "Bearer $($token.Trim())" }
```

- **增量**：新写入的 chunk 由 memd 每 5 秒补一批向量（最多 32 条）；删除（forget/purge）留下的孤儿向量
  在下一次同步里清掉。
- **降级**：模型缺失 / `onnxruntime-node` 没装 / `sqlite-vec` 加载失败 / 推理报错 —— 一律静默退回纯 FTS，
  检索不会报错；`/v1/config-state` 的 `semantic.reason` 会写原因。
- **资源**（本机实测，Ryzen 7 9700X / 32 GB）：稳态 1 线程，短查询 embedding 0.5 ms、KNN 0.4 ms，
  常驻 150–250 MB，空闲 CPU 0%，**不占 GPU**；回填 763 条约 6 秒。
- **别调大**：`batchSize > 8` 或 `maxLen > 256` 会把激活张量放大到 GB 级（实测 RSS 1.7 GB）；
  `threads > 1` 对单条查询没有收益，只抬高总 CPU。回填可以 `pnpm embed -- --threads 4`。
- 换模型：改 `semantic.{modelDir,modelFile,dim}` → 启动时维度不一致会自动重建向量表 → 再 `pnpm embed`。
- 回归检查：`pnpm verify:recall` 先跑 FTS 基线（不能退化），再跑 4 组「和库内措辞错开」的语义查询，
  要求每组至少 1 条命中、与 FTS 结果有交集、且至少一组召回 FTS 没给出的 chunk；
  语义不可用时只提示并退出 0（降级是预期），`--require-semantic` 则强制要求可用。
