# memory-hub 交接单

> 状态：**v1 已上线并实测**：服务端 + MCP + QQ 桥接（注入/镜像/读工具/短期记忆/回顾）+ DSH 全会话上报插件；90 项测试通过。
> 最后更新：2026-10-24 01:55

## 先读这五份

1. 需求定稿：`memories/40-decisions/2026-10-23-0006-memory-system-requirements.md`
2. 部署决策：`memories/40-decisions/2026-10-23-0007-memory-hub-local-deployment.md`
3. 实现方案：`memory-hub/docs/IMPLEMENTATION.md`
4. 本次实现记录：`memory-hub/docs/IMPLEMENTATION-NOTES.md`（偏差与取舍）
5. 运维：`memory-hub/docs/RUNBOOK.md`
6. 研发计划与待办：`memory-hub/docs/PLAN.md`

DSH 插件结论：`docs/SPIKE-DSH.md`；QQ 桥接落点：`docs/QQ-BRIDGE-INTEGRATION.md`、`docs/QQ-BRIDGE-PATCH.md`。

## 已经实现（可直接跑）

| 模块 | 状态 | 入口 |
|---|---|---|
| `protocol` | TypeBox schema + 路由表 + OpenAPI | `packages/protocol/openapi.yaml` |
| `core` | tokenize（bigram）/chunk/frontmatter/policy | `packages/core/src/` |
| `server` | Fastify `/v1`、SQLite FTS5、鉴权、审计、可见性 SQL、token 热重载 | `packages/server/src/` |
| `sdk` | 类型化客户端 | `packages/sdk/src/index.ts` |
| `admin` | token issue/list/revoke、reindex、health、import-social | `packages/admin/src/cli.ts` |
| `adapter-dsh` | MCP stdio（9 个工具，含 review/persist）+ 全会话短期入库 host 插件 `plugins/dsh-memory` | `packages/adapter-dsh/src/`、`plugins/dsh-memory/` |
| `adapter-qq` | 零依赖客户端（编译 `dist/memory-client.mjs`）+ 桥接模块（注入/镜像/读工具/短期上报） | `packages/adapter-qq/` |

验收证据（2026-10-24）：

- `pnpm test` → `tests 90 / pass 90 / fail 0`。
- 真实 `memories/` 30 个文档 → `docs=30`；`verify-recall.mjs`：记忆 1.3ms、桌宠 0.4ms、记忆简报 0.7ms、QQ 桥接 0.5ms、股票 0.1ms，全部命中。
- QQ 线上：`17:47:07 ingest | qq:group` → `recall ids 3` → `17:47:14 发送 1/1`（999 窗口 + from_owner 都走了真实流量）。
- DSH 插件：`17:29 / 17:38 / 17:42 / 17:45 / 17:47 / 17:52 ingest | main`，桌面会话持续上报。
- 短期→长期：`memory_review` 列出 4 条 → `memory_persist` → `stage=long`、`expires_at` 消失；recall 后 TTL 从 6 分钟延长到约 48 小时。

## 怎么启动

```powershell
cd D:\deepseek_workspace\memory-hub
& $node $pnpm run build
node packages\admin\dist\cli.js token issue --name desktop-main --surface main --scope "*" --scope "sensitive:read"
powershell -ExecutionPolicy Bypass -File scripts\start.ps1
```

> 沙箱会话里用 `Start-Process` 拉起的 memd 会随父进程结束被回收；长期运行请在普通 PowerShell 或 `start-stack.ps1` 里启动。

## 还没做 / 下一步

1. **设置页（P2.5）**：需要客户端半侧 `dsh.client` + 预构建 `lib/client.js`，DSH 没有 schema 通用表单渲染器；`/v1/config-schema` 已就绪，见 `SPIKE-DSH.md` §3。
2. **桌宠**：等实际接入后再做（需求已定：桌宠视图 = 全部 − 工作/股票）；如果它跑独立进程，需要像桥接一样接 `/v1/ingest`（不限条数）。
3. `memory-update/remove/clear` 的镜像（v1 只镜像 append）。

已完成（2026-10-24）：

- **QQ 读工具**：桥接 3 个端点 + MCP `qq_memory_search/get/recent`（按会话 scene token）。
- **QQ 隐藏 root 记忆工具**：`qq-tool-restrict.mjs` 把 `mcp__memory__*` 九个工具加进 restrict 名单（schema 层隐藏 + 执行期白名单兜底）。
- **DSH 端口自愈**：`dsh.baseUrl` 留空自动识别；显式端口失效自动降级；连续 3 次 0 帧切自动模式。
- **social-v2 迁移**：识别真实 `{paused, conversations}` 结构，实跑 4 条、幂等。

## 环境事实与坑（这一轮新踩到的）

- pnpm **必须** `nodeLinker: hoisted`（写在 `pnpm-workspace.yaml`）。isolated 布局在这台机器上产生 junction，Node 不解析 realpath，`fastify` 报 `Cannot find module 'avvio'`。
- **不要装 `tsx`**：esbuild 依赖触发 pnpm `ERR_PNPM_SYMLINK_FAILED Maximum call stack size exceeded`。测试 = `tsc -p tsconfig.tests.json` + `node --test`。
- 沙箱跑 `node --test` 必须加 `--test-isolation=none`，否则子进程管道 `spawn EPERM`。
- `PACKAGE_ROOT` 不能靠「模块路径上三级」推：hoisted 布局下会落到 `packages/<pkg>/node_modules`。现在用向上找 `pnpm-workspace.yaml` 的标记法（`server/src/config.ts`）。
- Fastify 只能 `listen` 一次；多地址用 `http.createServer(app.routing)`，每个地址一个 server，关闭时逐个 close。
- 索引 schema 变更要 bump `SCHEMA_VERSION`（`db.ts`），否则旧库不会被清理；纯索引逻辑变更需 `admin reindex --force`。
- token 文件按 mtime 热重载，签发/吊销不用重启 memd（`tests/unit/tokens.test.ts`）。
- **不要用 PowerShell 的 `Get-Content/Set-Content` 改 UTF-8 文档**：PS 5.1 默认按 GBK 读写，会把中文写坏。用编辑工具的 `write/edit`。

## 一页验收清单

```powershell
# node 不在 PATH 上时先加：
$env:PATH = "D:\Software\dsh\resources\runtime\primary-runtime\dependencies\node\bin;$env:PATH"

pnpm test                                                     # 构建 + 编译 tests + 67 项全过
node scripts\verify-recall.mjs                                # 真实语料召回
node packages\admin\dist\cli.js health                        # 服务在跑时
node scripts\setup-dsh-mcp.mjs --check                        # DSH 是否已注册
node --check ..\qq-bridge\src\bridge.js                       # QQ 补丁语法
```
