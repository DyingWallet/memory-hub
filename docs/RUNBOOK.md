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

```powershell
# 注册两个计划任务（当前用户、无需管理员；必须在**非沙箱** PowerShell 里跑）
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1

# 看状态（先看这里再排查）
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Check

# 删除（先删任务再 stop，否则看护任务 5 分钟内又把它拉起来）
powershell -ExecutionPolicy Bypass -File scripts\uninstall-autostart.ps1
powershell -ExecutionPolicy Bypass -File scripts\stop.ps1
```

| 任务 | 触发 | 动作 |
|---|---|---|
| `memd-autostart` | 登录后 30 秒 | `scripts\start.ps1 -NoWait` |
| `memd-watchdog` | 每 5 分钟 | 同上（已健康则 `exit 0`） |

- 两者幂等：`start.ps1` 先探 `/v1/health`，已在线就只做 health-check，所以和 `start-stack.ps1` 第 2.6 步撞上也无害。
- 沙箱身份下 `Get-ScheduledTask` / `schtasks` 一律「拒绝访问」（低完整性进程，连 `New-ScheduledTaskSettingsSet` 都会拒），装/查任务请用普通 PowerShell 窗口。
- **pet-brain 没有登录任务**：它只服务 DSH 的 `pet-chat` preset，跟着 DSH 生命周期——`qq-bridge\start-stack.ps1` 第 2.7 步在 DSH 起来后拉起它，DSH 关闭/崩溃后它自己退出（每 30 秒探一次，连续 3 次不可达约 90 秒退出，见 `dsh-pet-configurable-llm/src/guard.mjs`）。调试时可 `PET_BRAIN_ORPHAN_GUARD=0` 关掉。

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

```powershell
node scripts\setup-dsh-mcp.mjs --check
node scripts\setup-dsh-plugin.mjs --check
node scripts\setup-dsh-panel.mjs --check
```

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

- root 令牌填 `%USERPROFILE%\.dsh\memory-token`（68 字符），存 localStorage；
- 可改短期参数与隐私三段式；保存前二次确认，写前备份；
- 令牌区可吊销（签发仍走 CLI）；
- 改 host 半侧（`lib/index.js`）必须**重启 DSH**；只改 `client.js` 刷新页面即可。

### 5.2 桌宠（pet-brain）

- 令牌：`pet-brain\state\memory.token`（surface `pet`，scopes `main/qq:owner/pet`，**无 `sensitive:read`**；scene `pet`）。
- 每轮：`POST /v1/recall`（scene=pet）→ 拼进 prompt；`POST /v1/ingest` 上报（50/批、失败静默）。
- 可见性：owner 的 `main/qq:owner` + shared；**看不到**敏感、`qq:group:*`、`qq:private:*`。
- `pet-brain/xi` 由 profile 的 `llm-pi-ai` 提供方指向 `127.0.0.1:8790`。
- 生命周期跟着 DSH（v2 方案 B）：`start-stack.ps1` 第 2.7 步拉起（并把 `DSH_WEB_URL` 传给子进程，省掉首轮端口发现），DSH 关掉后孤儿保护 3 x 30 秒自退。**不要**再给 pet 注册登录任务。
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

每日定时（可选，不需要管理员）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-backup-task.ps1        # 每天 04:00
powershell -ExecutionPolicy Bypass -File scripts\install-backup-task.ps1 -At 03:30
powershell -ExecutionPolicy Bypass -File scripts\uninstall-backup-task.ps1
```

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

每小时自动采样（可选，不需管理员）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-monitor-task.ps1              # 每小时
powershell -ExecutionPolicy Bypass -File scripts\install-monitor-task.ps1 -EveryMinutes 30
powershell -ExecutionPolicy Bypass -File scripts\uninstall-monitor-task.ps1
```
