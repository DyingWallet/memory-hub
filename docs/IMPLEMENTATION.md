# memory-hub 实现方案（v1）

> **隐私部分已过时**：2026-10-24 起改为「audience + 一个敏感位」，`privacy.labels` / `capability` / `autoClassify` 均已删除；以 `RUNBOOK.md` §4.5 为准。本文其余部分仍是有效的设计记录。
>
> 状态：方案稿，未开始写代码。
> 依据：`memories/40-decisions/2026-10-23-0006-memory-system-requirements.md`、`2026-10-23-0007-memory-hub-local-deployment.md`。
> v1 目标：让 DSH 主会话与 QQ 桥接读同一份文本记忆；关键词检索；本机部署；隐私按 scope 隔离。

## 0. v1 范围

做：

- 文本记忆：`memories/*.md` + `facts/*.jsonl`。
- 关键词检索：SQLite FTS5 + 中文 bigram；默认 5 条，弱时 10 条。
- 一个常驻服务 `memd`，本机 `127.0.0.1:8787` + `172.22.0.10:8787`。
- DSH 插件：MCP 工具 + 会话启动 bootstrap + DSH 设置页。
- QQ 桥接：唤醒 recall、`qq_memory_search/get/recent`、`qq_memory_append` 镜像。
- 迁移现有 `memories/` 与 `social-v2.json` 的会话记忆。
- 本机启动链、健康检查、备份、审计。

不做：

- 图片、文档、OCR、视觉 API。
- 语义检索、向量库、embedding API。
- 桌宠接入（等实际接入后再做）。
- 离线缓存、新终端适配器、L3 平台化。

## 1. 仓库结构

monorepo，pnpm workspace；`tsc -b` 构建到 `dist/`。

```
memory-hub/
  pnpm-workspace.yaml
  tsconfig.base.json
  package.json
  config.example.json
  docs/IMPLEMENTATION.md
  packages/
    protocol/            # TypeBox schema、OpenAPI 生成、共享类型
    core/                # tokenize / chunk / policy / 纯逻辑
    server/              # Fastify、路由、索引器、watcher
    sdk/                 # 类型化客户端
    adapter-dsh/         # MCP stdio + DSH 插件 + 设置页
    adapter-qq/          # qq-bridge memory client（编译成 mjs）
    admin/               # token / reindex / health CLI
  tests/
    integration/
    contract/
    privacy/
```

数据：

- 记忆原文：`D:\deepseek_workspace\memories\`。
- 服务数据：`memory-hub\data\`（token 哈希、审计、索引）。
- 索引：`memory-hub\data\index.db`，可重建。

## 2. 技术选型

| 层 | 选型 | 说明 |
|---|---|---|
| 运行时 | Node.js 24（DSH 自带） | `node:sqlite`、FTS5 已实测可用 |
| 语言 | **TypeScript 5.x + ESM** | strict；不用 enum，用 union；`tsc -b` 到 `dist/` |
| 构建 | **pnpm workspace + tsc project references** | 无 bundler；DSH 客户端设置页如需要再单独打包 |
| Schema | **TypeBox → JSON Schema / OpenAPI** | TS 类型从 schema 推；合同是 JSON Schema/OpenAPI |
| HTTP | Fastify + `@fastify/type-provider-typebox` | 路由、校验、日志一体 |
| 数据库 | `node:sqlite` | 无原生依赖；若 API 变动，回退 `better-sqlite3` |
| 检索 | FTS5 + bigram | 两字中文可命中；不引向量库 |
| MCP | `@modelcontextprotocol/sdk` | stdio，DSH 插件接 |
| 测试 | `tsx --test`（node:test）+ `tsc --noEmit` | 不加 Jest/Vitest |
| 进程 | Windows 启动脚本 + 健康检查 | 跟 QQ stack 一起起 |

已验证：`node:sqlite` 的 FTS5 可用；`trigram` 对「记忆」「桌宠」不命中，`bigram` 预处理后命中。

TypeScript 的边界：

- `packages/core` 不碰 I/O，纯函数，最好测。
- `packages/protocol` 只有 TypeBox schema 和生成的类型，没有业务逻辑。
- `packages/adapter-dsh` 里 DSH 的未类型化 API 集中在一个 `dsh-types.ts`，不把 `any` 漏进 core。
- `packages/adapter-qq` 编译成 `dist/memory-client.mjs`，qq-bridge 仍是 JS，只 import 这个产物。

## 3. 数据模型

### 3.1 事实记录（`facts/YYYY-MM.jsonl`，一行一条）

```json
{
  "schema_version": 1,
  "id": "f_01J...",
  "ts": "2026-10-23T21:00:00.000Z",
  "kind": "note|event|stance|promise|person|identity|qq-topic|qq-impression",
  "text": "纯文本",
  "tags": ["memory"],
  "audience": ["shared"],
  "privacy": "normal|personal|work|financial|secret",
  "source": "main|qq|import|work",
  "device": "desktop",
  "scene": "qq:group:10001",
  "meta": {}
}
```

规则：

- `id`：`f_<timestamp>_<uuid短段>`，全局唯一。
- `audience` 省略时默认 `["main"]`（保守）。
- `privacy` 省略时默认 `normal`；`work/financial` 必须显式。
- `meta` 原样保留，未来加字段不迁移。
- 只追加，不改写；纠正用新记录 + `supersedes`。

### 3.2 文档记录（Markdown）

- `memories/**/*.md` 仍是叙事真源。
- front matter 可写：
  ```yaml
  audience: [shared]
  privacy: normal
  tags: [memory]
  ```
- 缺省：`audience: [main]`、`privacy: normal`。
- `user/identity.md` 例外：默认 `audience: [shared]`。
- `10-journal`、`40-decisions`、`50-knowledge` 默认 `main`，不直接进群。

### 3.3 受众记录（`memories/audiences/<id>.md`）

```yaml
---
id: qq:group:10001
kind: group
name: 朋友群
face: 助手
relationship: 朋友群，熟人多
boundaries: [工作, 股票, 别的群的八卦]
known: [我叫小助手]
---
```

v1 只读，用于 `bootstrap` 返回一段 ≤300 字的 `face` 文本；完整 face 混合、按对象切换放 v1.1。

## 4. Scope 与隐私

### 4.1 身份

| 名称 | 含义 |
|---|---|
| `*` | root：主会话 / 你的 QQ 私聊 |
| `shared` | 任何会话可见 |
| `main` | 主会话/终端私人面 |
| `qq:owner` | 与你的 QQ 私聊 |
| `qq:group:<id>` | 某个群 |
| `qq:private:<qq>` | 与某个人的私聊 |
| `work:read` | 可读工作/股票（附加能力） |

### 4.2 Token

```json
{
  "id": "tok_01J...",
  "name": "desktop-main",
  "surface": "main",
  "scopes": ["*", "work:read"],
  "hash": "scrypt:...",
  "created_at": "...",
  "revoked_at": null
}
```

签发：

```powershell
node packages/admin/dist/cli.js token issue --name desktop-main --surface main --scopes "*","work:read"
node packages/admin/dist/cli.js token revoke tok_...
```

规则：

- 明文只显示一次；服务端只存 `scrypt` 哈希。
- token 文件放 ACL 收紧的路径；不进日志、不进 localStorage。
- 模型不能自己扩 scope；scope 由 token 决定。

### 4.3 可见性

```text
canRead(memory, token, scene):
  if memory.privacy == "secret": false
  if memory.privacy in {"work","financial"}:
      if !token.scopes.includes("work:read"): false
      if scene not in {"main","qq:owner"}: false
  if token.scopes.includes("*"): true
  if memory.audience.includes("shared"): true
  if memory.audience ∩ token.scopes: true
  return false
```

默认：

- `kind=identity` → `["shared"]`。
- `kind=journal|decision|knowledge` → `["main"]`。
- QQ 群写入 → `["qq:group:<id>"]`。
- QQ 私聊写入 → `["qq:private:<qq>"]`；owner 私聊 → `["qq:owner"]`。
- 工作导入 → `["main","qq:owner"]` + `privacy=work`。

关键：**过滤在 SQL 里做，不在返回后做**；群 token 的查询里根本不存在 owner/work 行。

## 5. 索引与检索

### 5.1 表

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE docs (
  id TEXT PRIMARY KEY,
  path TEXT,
  title TEXT,
  kind TEXT,
  audience TEXT,      -- JSON array
  privacy TEXT,
  source TEXT,
  scene TEXT,
  hash TEXT,
  updated_at INTEGER
);

CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  doc_id TEXT,
  path TEXT,
  heading TEXT,
  text TEXT,
  tokens TEXT,        -- bigram 后的 token 串
  audience TEXT,
  privacy TEXT,
  kind TEXT,
  updated_at INTEGER
);

CREATE VIRTUAL TABLE chunks_fts USING fts5(
  tokens, text,
  content='chunks', content_rowid='rowid',
  tokenize='unicode61'
);
```

- `chunks` 与 FTS 用 rowid 对齐；重建时先清空。
- 索引文件可删，启动重建。

### 5.2 分块

- Markdown 按 `##` 标题切；段落再切到 ≤600 字符，重叠 80。
- facts 一条一块。
- 每块保留 `path`、`heading`，返回时带引用。
- 标题/标签单独加权。

### 5.3 Tokenize

- 中文：连续汉字的 **bigram**；单字也保留。
- 英文/数字：小写词。
- 查询同样 tokenize；多 token 用 `AND`，弱结果时降为 `OR`。
- 例：`记忆简报` → `记忆 忆简 简报`。

### 5.4 排序

- FTS5 `bm25` 基础分。
- `+` 标题命中、标签命中、最近 30 天、同 scene。
- `-` 过于久远（可选，不硬性）。
- 默认 `k=5`，最大 `k=10`。

## 6. HTTP API

统一：

- `Authorization: Bearer <token>`
- JSON body；Fastify JSON Schema 校验。
- 错误：`{ "error": { "code": "...", "message": "..." } }`
- 请求 id 回显 `x-request-id`。

### 6.1 路由

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/v1/health` | 存活、版本、索引统计 |
| GET | `/v1/capabilities` | 工具、限额、features（images/documents/semantic 均 false） |
| GET | `/v1/config-schema` | DSH 设置页的 JSON Schema |
| POST | `/v1/bootstrap` | 身份 + 受众 face + 最近标题 |
| POST | `/v1/search` | 关键词检索 |
| POST | `/v1/get` | 取一块 |
| POST | `/v1/recent` | 最近标题/片段 |
| POST | `/v1/recall` | 按最近消息召回 2–3 条 |
| POST | `/v1/write` | 写一条事实 |
| GET | `/v1/audience` | 读某个 scene 的受众卡（可选） |

### 6.2 关键请求

`POST /v1/bootstrap`

```json
{ "surface": "main", "scene": "main" }
```

返回：

```json
{
  "identity": "小助手……",
  "audience": { "id": "main", "face": "……" },
  "recent": [
    { "id": "f_...", "title": "桌宠接入", "kind": "event" }
  ],
  "counts": { "docs": 12, "facts": 34 },
  "instructions": "需要细节时调用 memory_search；不要一次取全量。"
}
```

`POST /v1/search`

```json
{ "query": "上次桌宠接入", "k": 5, "scene": "main", "kinds": ["event", "note"] }
```

返回 `results[]`，每项：

```json
{
  "id": "f_...",
  "score": 0.82,
  "title": "桌宠接入",
  "render": { "type": "text", "text": "……" },
  "path": "50-knowledge/...",
  "updated_at": "..."
}
```

`POST /v1/write`

```json
{
  "kind": "note",
  "text": "……",
  "audience": ["shared"],
  "privacy": "normal",
  "tags": ["memory"],
  "source": "main",
  "idempotency_key": "optional"
}
```

`POST /v1/recall`

```json
{
  "messages": [{ "role": "user", "text": "上次那个桌宠的事" }],
  "k": 3,
  "scene": "qq:group:10001"
}
```

服务端提取关键词，走 search，返回更短的片段（≤300 字/条）。

## 7. MCP 工具

`packages/adapter-dsh/src/mcp-server.ts`（编译到 `dist/mcp-server.js`），stdio：

| 工具 | 对应 |
|---|---|
| `memory_bootstrap` | `/v1/bootstrap` |
| `memory_search` | `/v1/search` |
| `memory_get` | `/v1/get` |
| `memory_recent` | `/v1/recent` |
| `memory_recall` | `/v1/recall` |
| `memory_write` | `/v1/write` |
| `memory_call` | 未来 op 的兜底，服务端白名单 |

工具描述要短，告诉模型：

- 用户提到过去/旧事时先 search。
- 不要一次读全量；先 5 条，不够再 `k=10`。
- 写入只记 durable 的事实/承诺/立场，不记流水账。

## 8. DSH 插件

### 8.1 组成

1. `packages/adapter-dsh/src/mcp-server.ts`：MCP stdio，读配置，转发 HTTP；`tsc` 编译到 `dist/`。
2. DSH 插件：会话启动时注入 `bootstrap`；设置页。
3. 配置：`~/.dsh/plugins/dsh-memory/config.json` 或 profile patch：

```json
{
  "endpoint": "http://172.22.0.10:8787",
  "tokenFile": "C:\\Users\\70903\\.dsh\\memory-token",
  "surface": "main",
  "bootstrap": true
}
```

### 8.2 注入点（先 spike）

先确认三件事，再写代码：

1. DSH 插件能否在会话启动/第一轮前注入一条 `system-reminder`。
2. 设置页用哪套客户端插件 API；能否 schema 渲染。
3. profile 安装本地包的命令与回滚方式。

优先级：

- A：插件注入 bootstrap（最佳，自动）。
- B：MCP `initialize.instructions` + AGENTS.md 一条“先调 memory_bootstrap”（一次工具调用）。
- C：只在 AGENTS.md 写约定（最差，但能跑）。

### 8.3 设置页

字段：

- endpoint、surface、token（掩码）、bootstrap/recall/write 开关。
- 状态：连接、版本、capabilities、索引统计、最近错误。
- 操作：测试连接、重新加载配置。
- 不放记忆正文；token 签发/轮换在主机 CLI。

## 9. QQ 桥接接入

`packages/adapter-qq` 用 TS 写，编译成 `dist/memory-client.mjs`；qq-bridge 仍是 JS，只 import 这个产物，不把 TS 构建链塞进桥接。

### 9.1 配置

`qq-bridge/config.json` 增加：

```json
"memory": {
  "enabled": true,
  "endpoint": "http://127.0.0.1:8787",
  "tokenFile": "state/memory-bridge.token",
  "recallK": 3,
  "maxChars": 800
}
```

### 9.2 Scene 映射

| convKey | scene | 可见 |
|---|---|---|
| `group:<id>` | `qq:group:<id>` | shared + 本群 |
| `private:<ownerQQ>` | `qq:owner` | 全部 |
| `private:<qq>` | `qq:private:<qq>` | shared + 该私聊 |

桥接代码决定 scene；模型不能传 scene。

### 9.3 唤醒

在 `buildWakePromptV2Core` 里加：

```
【长期记忆】<identity 一行>
【相关记忆】<recall 2–3 条，≤800 字>
```

- 取最近 2 条消息做 recall。
- 服务不可用时静默跳过，不影响 QQ。
- 不再注入 `brief-qq.md`（P0 产物退役）。

### 9.4 工具

- `qq_memory_search(query, k)`
- `qq_memory_get(id)`
- `qq_memory_recent(k)`

全部由桥接用 scene 调服务；模型只给 query/id。

### 9.5 写入镜像

`qq_memory_append` 成功后，异步 `POST /v1/write`：

```json
{
  "kind": "qq-topic|qq-impression",
  "text": "...",
  "audience": ["qq:group:10001"],
  "privacy": "normal|personal",
  "source": "qq",
  "scene": "qq:group:10001"
}
```

失败只记日志，不阻断 QQ。

## 10. 迁移

### 10.1 现有 memories

- 全量扫描 `.md`，默认 `audience:["main"]`。
- `user/identity.md` → `["shared"]`。
- `user/profile.md`、`preferences.md`、`00-inbox/live-context.md` → `["main"]`。
- `10-journal`、`40-decisions`、`50-knowledge`、`20-people` → `["main"]`。
- 工作区以后导入的工作数据 → `privacy=work`，`["main","qq:owner"]`。

### 10.2 social-v2.json

- `activeTopics` → `qq-topic`，audience `[scene]`。
- `pendingThoughts` → `qq-topic`，audience `[scene]`。
- `memberImpressions` → `qq-impression`，audience `[scene]`，`privacy=personal`。
- ID 用 `import:<scene>:<hash>`，重复导入跳过。

### 10.3 people.json

- 按 scope 映射到 `qq:group` / `qq:private`。
- 读不到 scope 的条目 → `["main"]`，人工复核。

## 11. 启动、运维、备份

### 11.1 启动

`memory-hub/scripts/start.ps1`：

1. 读 `config.json`，检查端口/路径。
2. 启动 `node packages/server/dist/index.js`（启动前确保 `pnpm -r build` 已跑过）。
3. 轮询 `/v1/health`，10 秒超时。
4. 失败写日志，退出码非 0。

`qq-bridge/start-stack.ps1` 在启动桥接前调用；`memd` 失败不阻断 QQ，只记日志。

### 11.2 防火墙

一次性管理员：

```powershell
New-NetFirewallRule -DisplayName "dsh-memory 8787" -Direction Inbound `
  -Protocol TCP -LocalPort 8787 -RemoteAddress 172.22.0.0/28 -Action Allow
```

只绑 `172.22.0.10` 和 `127.0.0.1`，不绑 `0.0.0.0`。

### 11.3 备份

- `memories/`：现有 `backup.ps1` 已覆盖。
- `memory-hub/data/tokens.json`、`config.json`：加入备份。
- `index.db` 可不备份，重建即可。
- 恢复：拷回 `memories/` + `data/`，`node packages/admin/dist/cli.js reindex`。

### 11.4 审计

`data/audit.jsonl`：

```json
{"ts":"...","token":"tok_x","surface":"qq:group:10001","route":"search","query_hash":"...","ids":["f_..."],"denied":0,"ms":12}
```

只记 id、hash、scope；不记正文。保留 30 天。

## 12. 测试与验收

### 12.1 自动测试

- 单测：tokenize、chunk、policy、默认 audience。
- 集成：临时目录 + 临时 DB，起服务，走 HTTP。
- 契约：OpenAPI 路由、错误码、MCP 工具 schema。
- 隐私：
  - 群 token 搜「股票/工作」→ 0。
  - 群 token `get(owner_id)` → 403/404。
  - 第三人私聊 token 搜另一个私聊 → 0。
  - 主会话 token 搜全部 → 有。
  - QQ owner scene 搜 work → 有。
  - 伪造 `scene` 参数从群 token → 拒绝。

### 12.2 手工验收

1. `curl /v1/health` → 200。
2. 主会话问「你叫什么」→ 小助手。
3. 主会话问「上次桌宠」→ 返回 pet-brain 相关片段。
4. QQ 群问「你叫什么」→ 小助手。
5. QQ 群问「股票/工作」→ 没有；不编。
6. QQ 私聊 A 的内容，私聊 B 搜不到；群也搜不到。
7. QQ owner 私聊能搜到工作/股票。
8. 重启 `memd` → 索引重建，数据不丢。
9. 撤销 token → 客户端 401。
10. 延迟：本机 search <100ms；VLAN <300ms。

## 13. 阶段与工时

| 阶段 | 内容 | 工时 |
|---|---|---|
| P0 | TS monorepo、TypeBox 协议、schema、tokenizer 原型 | 1–1.5 天 |
| P1 | store/index/auth/policy + HTTP API + 测试 | 1.5–2 天 |
| P2 | DSH 插件 spike + MCP + 设置页 + 主会话验收 | 1–1.5 天 |
| P3 | QQ 桥接 recall/工具/写入镜像 + 验收 | 1 天 |
| P4 | 迁移、隐私测试、启动链、备份、文档 | 1 天 |

合计约 **6 人日净开发**，不含联调。比 JS 版多出的约 1 天是 TS 骨架、类型检查和构建；换来的是 scope/policy 的类型约束和开源 SDK 的可用性。

## 14. 风险与回退

| 风险 | 处理 |
|---|---|
| DSH 插件注入 API 不确定 | P2 先 spike；回退 MCP instructions + AGENTS.md |
| DSH 插件 API 没有类型 | `adapter-dsh/src/dsh-types.ts` 集中手写接口；`any` 不进 core |
| `node:sqlite` 实验性 | 锁 Node 24；回退 `better-sqlite3` |
| 中文检索漏召回 | bigram + 我扩展 + 标签/标题加权；测试集覆盖 |
| QQ 桥接文件大 | 只加一个模块 + 三处调用；加测试 |
| token 泄漏 | ACL、哈希、撤销、审计；不进日志 |
| 服务挂了 | QQ 静默降级；启动链健康检查；索引可重建 |
| 数据丢失 | facts 追加写；每日备份；索引可重建 |

## 15. 先做的三件小事

1. 搭 TS monorepo + `tsconfig.base.json`；写 `packages/protocol` 的 TypeBox schema，生成 `openapi.yaml`。
2. 写 `packages/core/src/search/tokenize.ts` + FTS5 原型，验证 20 条真实记忆的召回。
3. Spike DSH 插件注入点和设置页 API；拿到结论再写其余代码。
