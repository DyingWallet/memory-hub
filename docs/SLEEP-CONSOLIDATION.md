# 夜间整理 + 桌宠记忆分层（正式方案）

> 2026-10-27 定稿。上一版实现（规则打分 + 调 pet-llm 做模型入口）已回退，原因见文末「为什么推倒」。

## 一、核心结论

1. **整理由 DSH 的 agent 做**，不写在 memd 里，也不借 pet-llm 的模型入口。
2. **人格一致**：整理会话与主会话同 workspace、同 `AGENTS.md`，私密章节在内（已确认可接受）。
3. **全局整理**：当天所有场景的记忆一起看，写回时由 agent 判断 audience。
4. **桌宠去掉记忆卡**：人格 = `AGENTS.md` + preset persona（每轮都在）；记忆 = 每轮从 memd 实时取。

## 二、架构

```text
                    ┌──────────── 03:00 触发（计划任务 / supervisor）───────────┐
                    │                                                          │
                    ▼                                                          │
        scripts/sleep-consolidate.mjs                                          │
          ① 发现 DSH（resolveDshBaseUrl）                                     │
          ② 建/复用「整理会话」（preset: sleep-consolidator）                  │
          ③ 拼上下文：当日记忆 + 相关长期记忆 + 近期决策 + 来源标记             │
          ④ sessions.prompt(整理指令)                                          │
          ⑤ 等 turn/end，记审计                                                │
                    │                                                          │
                    ▼                                                          │
        DSH 会话（agent，同一 workspace，加载 AGENTS.md）                       │
          逐条判断：关联 / 整合 / 更新 / 遗忘 / 新增                            │
          写回：memory_write（带 audience、subject、privacy）                   │
                 + 需要时 memory_supersede / memory_forget                      │
                    │                                                          │
                    ▼                                                          │
        memd（长期事实 + 审计）                                                 │
                    │                                                          │
                    ▼                                                          │
        桌宠每轮：/v1/recall（k=5, 1500 字）+ /v1/recent + live 通道             │
```

## 三、整理会话

### 3.1 preset

新预设 `sleep-consolidator`，工具集：

- `read` / `glob` / `grep`（读记忆卡外的文件、index、决策）
- 继承全局的 `mcp__memory__*`
- **不注册** `pwsh`、`write`、`edit`、`subagent`
- persona prefix：只写「你在做夜间整理」的职责与纪律，**不重复人格**（人格由 AGENTS.md 提供）

### 3.2 上下文（每次整理注入）

| 内容 | 来源 | 说明 |
|---|---|---|
| 当日记忆清单 | `/v1/timeline` 当天 + `/v1/recent` | 每条带 `scene` / `audience` / `privacy` |
| 相关长期记忆 | 按当日高频实体做 `/v1/search` | 用于关联、判断重复与更新 |
| 近期决策 | `memories/40-decisions/` 最近 5 条 | `read` |
| 记忆索引 | `memories/index.md` | `read` |

### 3.3 纪律（写进 prompt）

- 只产出「值得长期保留」的内容：承诺、偏好、决定、关于主人的事实、对他人的印象。
- 不产出：提问、请求、寒暄、工具输出、日志、链接。
- **audience 由整理者判断**：涉及第三人具体言行 → 必须包含来源场景；关于主人自己 → `main`；跨场景共同事实 → 可写多个场景。
- 更新旧事实用 `supersedes`；确认过时的用 `forget`。
- 每条写 `reason`，便于复查。

## 四、桌宠记忆

### 4.1 人格

- 由 `AGENTS.md`（`dsh-agent-instructions`，每轮）+ preset persona（静态）承担。
- **不生成人格卡，不做版本比对**——这两层每轮重读，不存在「感知不到变更」。

### 4.2 记忆

每轮三路取数，全部本地：

| 接口 | 参数 | 用途 |
|---|---|---|
| `/v1/recall` | `k=5`、`maxChars=1500`、`scene=pet` | 与当前这句话相关的长期记忆 |
| `/v1/recall` 的 `live` | `k=6`、`minutes=30`、`scenes=['main']` | 主人那边正在聊什么 |
| `/v1/recent` | `k=5` | 最近发生了什么（recall 不擅长） |

完整内容兜底：`read memories/index.md`。

### 4.3 无 memd 的降级

- 保留**一层**降级：memd 不可达时三路全部静默返回空，桌宠正常回复，只是没有记忆。
- **不保留静态记忆文件**。第三方部署要么装 memd，要么接受「有人格、无记忆」。
- 文档里写清：memd 是可选的记忆后端。

## 五、统一记忆块输出（`/v1/recall` 的 `block`）

记忆提示词「长什么样」现在是每个端各写一份：pet 拼 `【对方那边刚刚在聊的】` + `【长期记忆】`（`memory.mjs:86-114`），QQ 拼 `【长期记忆】` + `【相关记忆】`（`memory-client.ts:203-205`）。第三个端还会再抄一份。

改成由 memd 渲染：

- 请求加 `format: "block"`（不传则行为不变）；
- 响应新增 `block: string`，`results` / `live` 仍返回（调试与兜底）；
- 调用端原样把 `block` 塞进 prompt，不再做任何格式化。

**边界：渲染搬服务端，取数留端。** 看哪个 scene、k 多大、要不要 live、要不要 owner 披露，仍然由端决定；过滤、排序、截断、标记由 memd 做。

块格式（两端共用，不再各自定制标题）：

```text
【最近在聊的】（近 30 分钟，是现状，不是回忆）
- 21:40 ……

【长期记忆】（只是背景，不要原样复述）
- （对方自己提起过的）……
```

代价：服务端承担展示逻辑。做成独立的纯函数 `packages/server/src/recall-format.ts`，不掺进 `routes.ts`，保持可测。

## 六、pet 独立化（前置）

pet 现在 `import '../../qq-bridge/src/dsh-client.js'` 与 `.../lib/dsh-endpoint.mjs`——跨仓库、指向桥接的**部署目录**，而 `package.json` 里没有任何依赖声明。后果：第三方 clone 必崩，桥接被同步/清理时 pet 也跟着崩。

切分到 pet 自己的仓库：

```text
dsh-pet-configurable-llm/src/dsh/
  cookie.mjs     ← Cookie 离线铸造（resolveDshHome / discoverDshLaunchToken /
                   readBrowserSessionSecret / mintBrowserSessionCookie /
                   discoverDshSessionCookie / isLoopbackBase）
  endpoint.mjs   ← 端口发现（dshHomeDir / detectDshDesktop / dshBaseUrlCandidates /
                   parse* / list* / looksLikeDsh / resolveDshBaseUrl）
  client.mjs     ← NodeApiClient（RPC + auth + events.mux/follow/forget +
                   stopSessionWork）+ AbstractApiClient
  util.mjs       ← unwrap / blocksToText / createTurnCollector
```

- 约 500 行（815 行扣掉桥接专用的 token ledger / queue / projections / control baseline）。
- `src/dsh.mjs` 的两个相对 import 改成 `./dsh/*`。
- **qq-bridge 那份先不动**，等 pet 稳定后再考虑反向共用。

同时拆 `/health`：

- `/health`（无鉴权）只留 `{ ok, service, version }`——纯探针；`revive.mjs` 用端口探测，不受影响。
- `/status`（需 Bearer）返回现有详情：`dsh.reachable / baseUrl / presets / sessions`、`memory`、`models`、`preset`、`workspacePath`。

测试影响：「health 不需要鉴权」那条只改一行断言（`memory.chars` 挪到 `/status`）；「第一轮注入记忆卡」用例因去卡删除。

### 6.3 健壮性改造（同批做）

2026-10-27 逐条决定：

| # | 问题 | 决定 | 做法 |
|---|---|---|---|
| 1 | `selectModel` 失败只警告 | **显式报错** | 建会话时抛错，请求返回 502；不再静默落到 DSH 默认模型 |
| 2 | 会话失效靠错误文案匹配 | **改判错误码** | `unwrap` 抛出带 `code` 的 Error；`promptOnce` 把 `code` 透传到重试判断（当前被吞成 `message`）；`sessionNotFound` 判 `code === 'session/not-found'`，删文本正则 |
| 3 | `/v1/models` 不反映真实模型 | **从 DSH 取** | 调 `session.modelCatalog`（回退 `session/models`）并缓存；`/v1/models` 仍返回**可请求的 id**（`config.models` 的键），每个条目附 `x_dsh` 映射；`/status` 暴露 DSH 完整目录 |
| 5 | body 无上限 | **1 MB 上限** | `readBody` 超限返回 413 |
| 6 | 日志无轮转 | **按大小轮转** | 10 MB × 1 份，写入前 stat 判断后 rename |
| 4 | 单模型映射 | 保持 | — |
| 7 | 无配置热更新 | 保持 | — |
| 8 | `/admin/sessions` 暴露 sessionId | 保持 | 需鉴权即可 |

第 3 条的语义界线：OpenAI 的 `/v1/models` 应返回「能拿去请求的 id」。DSH 的真实模型 id 未必等于 `config.models` 的键（pet 用键查 petId），所以**不能**把 DSH 目录直接塞进 `/v1/models`——那会让现有客户端拿到一堆会 404 的 id。真实目录放 `/status`，`/v1/models` 保持可请求语义并附映射信息。

第 2 条依赖切分后的 `client.mjs`（`unwrap` 改签名），与 6.2 同批做；qq-bridge 那份不动，各持一份。

## 七、实现前必须先补的四件事

这四个缺口不补，整理写不完整：

| # | 缺口 | 补法 |
|---|---|---|
| 1 | MCP 没有 `memory_forget` | 加工具（走 `/v1/forget`），或加 `memory_supersede` |
| 2 | `memory_write` 没有 `supersedes` | 加参数，透传 `/v1/write` |
| 3 | `memory_write` 的 `privacy` 枚举还是 `normal/personal/work/financial` | 改成 `normal/personal/sensitive`（`secret` 需 `secret:write`，见第十一节） |
| 4 | `secret` 双拒 | 放开读写：root 令牌可读写，其他令牌读不到（第十一节） |

## 八、改动清单

| 仓库 | 文件 | 改动 |
|---|---|---|
| memory-hub | `packages/adapter-dsh/src/mcp-server.ts` | 补 forget / supersedes / privacy 枚举 |
| memory-hub | `packages/protocol/src/schemas.ts` | `RecallRequest.format?`、`RecallResponse.block?` |
| memory-hub | `packages/server/src/recall-format.ts` | 新建：纯函数渲染记忆块 |
| memory-hub | `packages/server/src/routes.ts` | recall 末尾调渲染，塞 `block` |
| memory-hub | `packages/adapter-qq/src/memory-client.ts` | 删格式化，取 `block` |
| memory-hub | `docs/SLEEP-CONSOLIDATION.md` | 本文件 |
| memory-hub | `packages/server/src/visibility.ts` | `secret` 按 scope 放行（第十一节） |
| memory-hub | `packages/server/src/routes.ts` | write 放开 `secret`（需 `secret:write`） |
| memory-hub | `scripts/migrate-ids.mjs` | 新建：ID 统一与存量迁移（第十二节） |
| memory-hub | `scripts/verify-recall.mjs` | 加基线模式（第十三节） |
| memory-hub | `scripts/sleep-consolidate.mjs` | 新建：发现 DSH、建会话、拼上下文、发 prompt、审计 |
| memory-hub | `scripts/setup-sleep-preset.mjs` 或 `preset/*.yml` | 新建 `sleep-consolidator` preset |
| dsh-pet-configurable-llm | `src/memory-card.mjs` | 删 |
| dsh-pet-configurable-llm | `src/dsh/*` | 新建：从 qq-bridge 切出通用 RPC / Cookie / 端口发现 |
| dsh-pet-configurable-llm | `src/dsh.mjs` | import 改到 `./dsh/*`；删 bootstrapped 状态 |
| dsh-pet-configurable-llm | `src/server.mjs` | `/health` 收窄、新增 `/status`（需鉴权）；删 bootstrap 分支 |
| dsh-pet-configurable-llm | `test/server.test.mjs` | 改 health 断言、删 bootstrap 用例 |
| dsh-pet-configurable-llm | `test/memory-card.test.mjs` | 删除 |
| dsh-pet-configurable-llm | `src/config.mjs` | 删 `memory.cardFile/injectCard/refreshMs/maxChars` |
| dsh-pet-configurable-llm | `src/memory.mjs` | recallK 3→5、maxChars 800→1500；加 `/v1/recent`；删格式化，改取 `block` |
| dsh-pet-configurable-llm | `preset/pet-chat.patch.yml` | prompt 里删「读记忆卡」 |
| dsh-pet-configurable-llm | `README.md` | 写清「memd 可选」 |

## 九、风险

| 风险 | 处理 |
|---|---|
| audience 判断错误导致跨场景泄露 | prompt 给明确规则 + 每条写 reason + 审计可查；发现问题靠 forget 撤回 |
| 模型编造事实 | prompt 禁止；每条要求可追溯到当日原文；审计留来源 id |
| token 成本 | 一天一次；单次约 3–5 万 token（模型 + 上下文） |
| preset 工具边界失效 | 只注册 read/glob/grep，MCP 工具走全局层；不给 shell |
| DSH 接口漂移 | 复用切分出的 `src/dsh/client.mjs`（与桥接同源的 RPC 封装） |

## 十一、secret 记忆通道

2026-10-27 决定：`secret` 从「双拒」改为「**可读写，但要不要透露由我判断**」。

### 11.1 权限

| 动作 | 需要 | 谁有 |
|---|---|---|
| 写 `secret` | `secret:write` | root 令牌（MCP / 主会话） |
| 读 `secret` | `secret:read` | 仅 root 令牌；群、第三人私聊、pet 一律不读 |

- audience 钉死在 `secretAudiences`（默认 `main` + `qq:owner`），不随来源场景扩散。
- 由我判断是否在回答里提及；默认不复述原文，只当背景。

### 11.2 后端改动

- `visibility.ts`：`privacy <> 'secret'` 硬过滤改为「按 scope 放行」。
- `routes.ts` 的 write：移除 secret 403。
- 协议：给 `secret:read` / `secret:write` 加语义（与 `sensitive:read` 同构）。
- 审计：记录写入事件与 id，不记录正文。

### 11.3 边界（写进 README 与 AGENTS）

- **不是加密存储**：明文落盘、备份、append-only 不可删。写进去就永远在。
- 这是「记忆的一部分」，会影响人格与语气——但不等于可以随便说出来。
- 与第十六条的「不做备份加密」一致：接受本机明文这个前提。

## 十二、ID 统一与存量迁移

### 12.1 格式

```
<source>-<scene>-<time36>-<rand4>
例：fact-main-m8x2k-7f3a
    fact-qq-owner-m8x2k-1c9d
    doc-<pathHash8>-<ord>
```

- `source`：`fact` / `doc` / `sleep` / `import`。
- `scene` 归一化：`main`、`qq-owner`、`qq-group-650866701`、`pet`。
- 文档用路径 hash，重命名不变。

### 12.2 迁移步骤（一次性，趁数据量小）

1. 停 memd；
2. 备份 `memories/facts/`（现 1300+ 行含 tombstone）；
3. 脚本生成 `old → new` 映射表（全部 id 列出）；
4. 重写 JSONL：替换 `id`、`supersedes`、`source_message_id`；
5. 删 `index.db`，重建；
6. 校验：条数、tombstone 数、`supersedes` 引用完整、`idem:*` meta 已重映射。

### 12.3 风险

- 映射错误 → 引用断裂；靠映射表 + 前后计数校验。
- `meta` 里 `idem:<key>` 的值是 doc id，必须一起改。
- 不可逆：先备份，再动手。

## 十三、检索基线

### 13.1 做法

- 固定 12 条查询（中文短语 / 长口语 / 时间线类 / 跨场景 / 近期）。
- 每条记录「期望命中的 id 集合」。
- 每次运行对比：期望 id 是否仍在 top-10、排名升降。
- `--update` 写新基线。

### 13.2 输出

```text
12 查询：9 保持，2 上升，1 下降
  q7「昨晚实现了什么」：top3 → 未命中（期望 f_xxx）
```

### 13.3 定位

- 只报告，不阻塞。
- 与 `verify-recall.mjs` 互补：那个查「有没有坏」，这个查「有没有变差」。

## 十四、验收

1. **手动跑一次**：建会话 → 整理 → 检查写回的事实（数量、audience、reason）。
2. **无 memd**：停 memd，桌宠回复正常、无记忆注入、无报错。
3. **审计**：`audit.jsonl` 能看到整理会话的 write 记录与来源。
4. **回滚**：整理产出带 `source: sleep` 标记，可整批 forget。
5. **pet 自包含**：把 `qq-bridge/` 临时改名，pet 仍能启动并完成一次对话。
6. **secret 边界**：主会话写入一条 secret → main 读得到；群令牌、pet 令牌读不到。
7. **ID 迁移**：迁移前后条数、tombstone 数一致；随机抽 10 条校验 `supersedes` 引用未断。
8. **基线**：`verify-recall --baseline` 能输出「保持/上升/下降」对比。

## 为什么推倒上一版

1. 依赖方向反了：memd 的夜间任务去调 pet-llm 的私有 token，底层依赖上层。
2. 整理者人格错位：用 pet-chat preset 跑系统任务，产出带桌宠口吻。
3. 编排太脆：7 个场景串行、失败整轮跳过、无断点续跑。
4. 产出无缓冲：模型写完直接进长期库。
