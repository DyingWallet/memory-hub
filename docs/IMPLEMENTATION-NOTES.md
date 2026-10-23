# 实现记录与偏差（v1）

> **隐私部分已过时**：2026-10-24 起改为「audience + 一个敏感位」，以 `RUNBOOK.md` §4.5 为准。
>
> 对照 `IMPLEMENTATION.md` 记录本次实现实际做法、偏差和原因。方案未变的部分不重复。

## 1. 总体

- 代码在 `memory-hub/`，pnpm workspace + `tsc -b`，7 个包；测试 67 项（unit / integration / privacy / contract / mcp / tokens）。
- 数据仍是 `memories/`（Markdown + `facts/*.jsonl`），索引 `data/index.db` 可删可重建。
- `/v1` HTTP 是正本；MCP 只是投影；OpenAPI 由 `ROUTE_SPECS` 生成。

## 2. 与方案的偏差

| # | 方案 | 实际 | 原因 |
|---|---|---|---|
| 1 | `GET /v1/audience` | `POST /v1/audience` | GET 带 body 语义差；统一成 JSON body，契约测试与客户端更简单。 |
| 2 | 测试用 `tsx --test` | `tsc -p tsconfig.tests.json` + `node --test --test-isolation=none` | tsx 的 esbuild 依赖在这台机器触发 pnpm `ERR_PNPM_SYMLINK_FAILED`；换成 tsc 还少一个 devDep。 |
| 3 | pnpm 默认 isolated 布局 | `pnpm-workspace.yaml` 里 `nodeLinker: hoisted` | isolated 在本机创建 junction，Node 不解析 realpath，`fastify` 找不到 `avvio`。 |
| 4 | `pc.audience` 默认 `[main]` | 同方案，另加 `identity → [shared]` 已在方案里 | 一致。 |
| 5 | 分块「标题/标签单独加权」 | 文档标题只并入**第一块**的文本，另存 `chunks.title` 用于展示与加权 | 标题 token 注入所有块会让「桌宠」命中一堆无关章节，且密度高的短块盖过正文。 |
| 6 | DSH 插件自动注入 bootstrap（方案 A） | MCP `initialize.instructions`（方案 B）+ AGENTS.md 规则（C） | A 需要本地插件包、`~/.dsh` 写入与重启；B 一行配置即生效。见 `SPIKE-DSH.md`。 |
| 7 | DSH 设置页（v1 要求） | **暂缓**，`/v1/config-schema` 已就绪 | DSH 无 schema 通用表单渲染器，需要客户端 bundle + 手写组件；先让工具链跑起来。 |
| 8 | 启动链并入 `qq-bridge/start-stack.ps1` | 已并入第 2.6 步（`memory-hub/scripts/start.ps1`，失败不阻断） | 部署决策要求 memd 跟 QQ stack 同生命周期。 |
| 9 | 审计异步写 | 同步 append（体积小） | 简化；30 天轮转在启动时做。 |
| 10 | 索引表 `chunks` 无 title | 增加 `title` 列 + `SCHEMA_VERSION` 迁移 | 结果标题要用文档标题；schema 变更时自动清库重建。 |
| 11 | token 只在启动读一次 | 按文件 mtime 热重载 | admin CLI 是另一个进程，签发/吊销后运行中的 memd 必须立即生效。 |

## 3. 关键实现细节

### 3.1 可见性

- `chunk_scopes(chunk_id, scope)` 存 audience 展开；SQL 过滤：
  `privacy <> 'secret'` + 工作闸门（`work|financial` 需 `work:read` 且 scene ∈ {main, qq:owner}）+ `EXISTS(scope='shared' OR scope IN token.scopes)`（root token 跳过 scope 过滤）。
- `core/policy.ts#canRead` 是同一规则的纯函数镜像；隐私测试同时走 HTTP 与纯函数。
- token 的 `scenes` 限制请求可传的 `scene`，伪造直接 403；模型无法自己扩场景。

### 3.2 检索

- 索引侧 token：CJK bigram + unigram + 拉丁词；查询侧：CJK bigram（单字才用 unigram）。
- 先 AND，命中不足 k 且 token 数 > 1 时降 OR，`weak=true` 返回给客户端。
- 排序：`-bm25` + 标题/章节命中 +0.2/0.35 + 30 天内 +0.08。
- 文档标题并入第一块，保证「只在 H1 出现的词」也能命中。

### 3.3 写入

- 追加 `facts/<YYYY-MM>.jsonl`，立即索引；`audience` 省略按 kind 默认（保守 `[main]`）。
- `work|financial` 的 audience 强制收敛到 `main/qq:owner`，且需要 `work:read`。
- `secret` 拒绝写入（v1 只做 allow/deny，secret 实际等于「不可写也不可读」）。
- `idempotency_key` 存 `meta` 表，重放返回相同 id + `duplicate=true`。
- token 库按文件 mtime 热重载：admin CLI 在另一个进程签发/吊销后，运行中的 memd 立刻生效（回归测试 `tests/unit/tokens.test.ts`）。
- QQ 场景 token 由 `scripts/issue-qq-tokens.mjs` 按 `qq-bridge/config.json` 的 allow 列表批量签发，同名旧 token 先吊销；桥接侧 `memory.tokens` 映射到每个场景，未映射的场景**没有回退**（否则会串权）。

### 3.4 身份与受众卡

- `bootstrap.identity` 取 `memories/user/identity.md` 前两段（≤300 字）。
- 受众卡 `memories/audiences/<scene>.md`，Windows 不允许 `:`，文件名用 `qq-group-10001.md`（读取时同时尝试 `:` / `-` / `_` 三种）。`main` 无卡时回退身份卡。
- v1 只读；face 混合/按对象切换留 v1.1。

### 3.5 MCP

- 7 个工具：bootstrap / search / get / recent / recall / write / call。
- 工具描述短、带「先 5 条、不取全量、只记 durable」的约束；`initialize.instructions` 同样内容，进 DSH 系统提示词。
- 写开关由插件配置控制；服务异常返回 `isError` 文本，不抛到 stdio。
- 已在 `~/.dsh/profiles/desktop/cordis.patch.yml` 注册为 `mcp-memory`（managed block），2026-10-23 实测热加载可用。

### 3.6 QQ 桥接

- `packages/adapter-qq/src/memory-client.ts` → `dist/memory-client.mjs`（零依赖、只用 `node:fs` + 全局 fetch；桥接的 `safe-fetch` 禁止环回）。
- `packages/adapter-qq/bridge/memory-bridge.js` 是给桥接的 drop-in 模块：scene 由 convKey/ownerQQ 现算、recall 800ms 超时 + 5s 缓存、mirror 写 fire-and-forget + 幂等键、按场景选 token。
- 已接到 `qq-bridge/src/bridge.js` 7 处；配置已启用，只剩重启桥接。

## 4. 已知缺口

1. DSH 设置页（需要客户端半侧 bundle）。
2. QQ 桥接尚未重启（代码与配置已就位）。
3. `social-v2.json` 真实迁移（CLI 有 `import-social`，未跑真实 state）。
4. QQ 读工具 `qq_memory_search/get/recent`（桥接端点 + MCP 工具）。
5. 图片/文档/语义检索按需求暂缓。
6. `scripts/start.ps1` 拉起的进程在沙箱会话里活不过父进程；长期运行靠普通 PowerShell / 启动链。
