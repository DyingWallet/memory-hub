# memory-hub

本机记忆服务 `memd` + DSH 插件 + QQ 桥接适配器。让 DSH 主会话和 QQ 桥接读同一份文本记忆，关键词检索，隐私按 scope 隔离。

- 协议：`/v1` HTTP（JSON），OpenAPI 在 [`packages/protocol/openapi.yaml`](packages/protocol/openapi.yaml)
- 部署：
  - 默认只绑 `127.0.0.1:8787`，本机 DSH / QQ 桥接 / 桌宠已经够用；
  - **可选**：需要多设备（笔记本、手机、VPS）经 ZeroTier 访问时，再追加 ZeroTier 内网地址（如 `172.22.0.10:8787`）。原因是 memd 本身没有公网防护，ZeroTier 提供点对点加密和成员准入，且地址只在虚拟内网可达；
  - 无论是否加入 VLAN/ZeroTier，都**绝不绑** `0.0.0.0`。
- 数据：`D:\deepseek_workspace\memories\`（Markdown + `facts/*.jsonl`），索引在 `data/index.db`，可重建
- 检索：`node:sqlite` FTS5 + 中文 bigram；默认 5 条，弱结果降到 OR、最多 10 条
- 运行时：Node 24（DSH 自带），TypeScript 5.9 + ESM，`tsc -b` 构建

## 快速开始

```powershell
# node 不在 PATH 上时先加
$env:PATH = "D:\Software\dsh\resources\runtime\primary-runtime\dependencies\node\bin;$env:PATH"

# 1. 构建
pnpm run build

# 2. 生成 openapi（可选）
pnpm run gen:openapi

# 3. 发一个本机会话 token（只显示一次，写进 ACL 文件）
node packages\admin\dist\cli.js token issue --name desktop-main --surface main --scope "*" --scope "sensitive:read"
# 把输出的 token 存到 C:\Users\<you>\.dsh\memory-token

# 4. 起服务并等健康检查
powershell -ExecutionPolicy Bypass -File scripts\start.ps1

# 5. 自检
node packages\admin\dist\cli.js health
```

首次启动若没有 `config.json`，`scripts/start.ps1` 会从 `config.example.json` 复制一份。

## 结构

```text
memory-hub/
  packages/
    protocol/     TypeBox schema → JSON Schema / OpenAPI，路由表（唯一契约源）
    core/         tokenize（bigram）、chunk、frontmatter、policy（纯函数）
    server/       Fastify 路由、SQLite FTS5 索引、鉴权、审计、可见性 SQL
    sdk/          类型化 HTTP 客户端
    adapter-dsh/  MCP stdio server + bootstrap 注入文本
    adapter-qq/   给 QQ 桥接用的零依赖客户端（编译成 dist/memory-client.mjs）
    admin/        token 签发/吊销、reindex、health、social-v2 导入
  tests/          unit / integration / privacy / contract / mcp
  scripts/        start.ps1 / stop.ps1 / gen-openapi.mjs / setup-dsh-mcp.mjs / setup-dsh-plugin.mjs / issue-qq-tokens.mjs
  plugins/        dsh-memory（DSH host 插件：全会话短期入库）
  docs/           SPIKE-DSH.md / QQ-BRIDGE-INTEGRATION.md / QQ-BRIDGE-PATCH.md / RUNBOOK.md
```

## 隐私模型（一句话版）

- 星形拓扑：你在中心；群和第三人彼此不可见；主会话和你的 QQ 私聊可见全部。
- token 绑定 `surface` + `scopes` + `scenes`；`scene` 由客户端传但必须落在 token 允许的场景里，模型不能自己扩权。
- 可见性在 SQL 里过滤（`packages/server/src/visibility.ts`），不是取回后再删；`core/policy.ts` 的 `canRead` 是同一规则的纯函数镜像，隐私测试两边都测。
- 隐私只有两条轴：**audience**（在哪些场景）和 **一个敏感位**（`privacy=sensitive`）。敏感记忆钉在 `sensitiveAudiences`，读取需要 token 带 `sensitive:read`；`secret` 不通过 API 写入、任何视图都读不到。
- 敏感位是配置项：`config.privacy.sensitiveScope` / `sensitiveAudiences` / `ownerAudiences`；接新平台（微信等）时把 `wx:owner` 加进后两个列表即可，不用改代码。
- QQ 桥接每个场景用独立 token（group / owner / 每个私聊各一个），未映射的场景没有回退。
- **主人主动提起**：桥接标记 `from_owner` 后，该场景可临时读到 owner 本人的 `ownerAudiences` 记忆（`disclosure: owner_initiated`）；敏感、其他人的私聊、`secret` 仍不放开，是否说出来由模型判断。

## 主要接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/health` | 存活 + 索引统计（唯一免鉴权） |
| GET | `/v1/capabilities` | 工具、限额、feature 开关 |
| GET | `/v1/config-schema` | 设置页 JSON Schema |
| POST | `/v1/bootstrap` | 身份 + 受众脸 + 最近标题 |
| POST | `/v1/search` | 关键词检索 |
| POST | `/v1/get` | 取一条（chunk id 或 doc id） |
| POST | `/v1/recent` | 最近记忆 |
| POST | `/v1/recall` | 按最近对话召回 2–3 条 |
| POST | `/v1/write` | 追加一条事实并索引 |
| POST | `/v1/ingest` | 普通聊天入库为短期记忆（TTL） |
| POST | `/v1/review` | 待回顾的短期记忆 |
| POST | `/v1/persist` | 短期转长期（可带蒸馏 note） |
| POST | `/v1/audience` | 读受众卡 |

## 测试

```powershell
pnpm test
```

- 67 项：单测（tokenize / chunk / frontmatter / policy / token 热重载）、集成（临时目录 + 真 SQLite + `app.inject`）、隐私矩阵、契约（路由 ↔ OpenAPI）、MCP 工具（InMemoryTransport）。
- 隐私：群 token 搜工作=0、群 get owner=404、私聊互不可见、伪造 scene=403、secret 全隐藏。
- 沙箱里跑 `node --test` 需要 `--test-isolation=none`（脚本里已带）。

## 状态

v1 已落地：服务端 / SDK / MCP / QQ 适配器 / admin 全部实现，67 项测试通过；DSH 已注册 `mcp__memory__*`（2026-10-23 实测）；QQ 桥接已配好 token 与开关，只剩重启桥接。见 `docs/HANDOFF.md`。
