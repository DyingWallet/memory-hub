# 夜间整理重构：执行记录与待办（2026-10-27 静默执行）

> 依据 `docs/SLEEP-CONSOLIDATION.md`。主人睡觉期间静默执行；需要鉴权/不可逆/需要拍板的项目列在下面。

## 已完成

| 项 | 提交 |
|---|---|
| MCP 三件套：`memory_forget`、`memory_write.supersedes`、privacy 枚举（含 sensitive/secret，work/financial 保留为旧别名） | `ac61d8e` |
| `secret` 通道：root / `secret:read` / `secret:write` 才可见，audience 钉在 `secretAudiences`（默认 main）；群、第三人私聊、pet 读不到 | `ac61d8e` |
| ID 规则统一：文档 `doc-<pathHash8>`，事实 `<source>-<scene>-<time36>-<rand4>` | `88895d8` |
| `scripts/migrate-ids.mjs`：确定性映射、默认 dry-run、apply 前要求 memd 停机并备份、同步改写 supersedes | `88895d8` |
| `/v1/recall` 的 `format: "block"`：服务端渲染提示词片段（标题/时间/截断/owner 标记），5 项单测 | `4804b2a` |
| pet 去跨仓库依赖：`src/dsh/{client,endpoint}.mjs` vendored，package.json 声明依赖 | `e2a1165` |
| pet `selectModel` 失败显式报错；日志按 10MB 轮转 | `bd24df0` |
| pet `/health` 拆成纯探针 + 需鉴权的 `/status` | `b2ddef7` |
| pet 会话恢复改判 RPC 错误码（`session/not-found`），删掉文案正则 | `5737e01` |
| `/v1/models` 每个 id 附 `x_dsh` 映射；`/status` 暴露 DSH 真实模型目录 | `ae83482` |
| **pet 去掉记忆卡**：删 `memory-card.mjs`、`bootstrapText`、bootstrapped 状态、`/admin/memory/refresh`；recallK 3→5、maxChars 800→1500；preset prompt 改为「记忆由服务每轮注入」 | `559cfcf` |
| `preset/sleep-consolidator.patch.yml` + `scripts/install-sleep-preset.ps1` + `scripts/sleep-consolidate.mjs`（dry-run 实测今天 66 条记录） | `eb9ef7b` |
| **ID 迁移已执行**（1669 行重写、0 冲突、索引重建、`doc-<hash8>` 生效） | 数据操作，无提交 |
| 运行时重启验证：新 ID 生成、`block` 输出、secret 通道、pet 去卡全部生效 | 2026-10-27 20:0x |

测试：memory-hub **190 项**、pet **29 项**，全过。

## 需要你执行或决策

1. ~~装整理 preset~~ **已完成**（2026-10-27 20:10）：`~/.dsh/profiles/desktop/cordis.patch.yml` 第 211–266 行有完整块，DSH 的 preset 列表里已能看到 `sleep-consolidator`。
2. ~~回退留下的 10 条 `source='sleep'` 记忆~~ **已处置**（2026-10-27 20:07，见下表末尾「处置」）。
3. **夜间整理还没接定时**（仍未做）：`supervisor.mjs` 的 tick 与 `config.ts` 都还没有 `sleep` 段，目前只能手动跑。

## 2026-10-27 19:xx：ID 迁移已执行

- 停 memd → `node scripts/migrate-ids.mjs --apply` → 看护任务拉起。
- **1669 行全部重写，0 冲突，0 条断裂 supersedes**；备份在 `memory-hub/backups/ids-before-2026-10-27T12-03-38-352Z/`。
- 索引重建：docs 49 / facts 367 / chunks 835。
- 验证：旧 `f_` 前缀 **0**、`chat:` 前缀 **0**、新 `fact-` **1662**（其余 7 条是 `import-`）；文档 id 变成 `doc-<hash8>`。
- 运行时另已重启 memd / pet，新代码（新 id 生成、block 输出、secret 通道、pet 去卡）实测生效。

## 10 条遗留（迁移后的新 id）

| 新 id | 场景 | kind | 内容 |
|---|---|---|---|
| `fact-main-tnj07l-a00c` | main | decision | 记忆对账的定时时刻放在下午 17:30 |
| `fact-main-tnj07l-1f6a` | main | decision | 「离机加密」暂不做，等有需求再设计 |
| `fact-main-tnj07l-32bb` | main | decision | 记忆整理应当调用模型来做 |
| `fact-qq-owner-tnj07l-704c` | qq:owner | promise | 明早 8 点 20 前叫他起床 |
| `fact-qq-owner-tnj07l-406b` | qq:owner | note | 新的一周开始时先写周报 |
| `fact-qq-owner-tnj07l-3cba` | qq:owner | note | 早上出门时天还没亮 |
| `fact-qq-private-2791166082-tnj07l-91c2` | qq:private:2791166082 | person | 沐沐拿金融/Oracle 问题来问 |
| `fact-qq-private-2791166082-tnj07l-056e` | qq:private:2791166082 | person | 沐沐叫我「大肥鱼」并挤兑我 |
| `fact-qq-group-650866701-tnj07l-c3fa` | qq:group:650866701 | note | 群里添了称呼「鱼摆摆」 |
| `fact-qq-group-650866701-tnj07l-97c6` | qq:group:650866701 | note | 群友对我发言不设限 |

**处置（2026-10-27 20:07）**：`fact-qq-group-650866701-tnj07l-97c6`（群友不设限）与 `fact-qq-owner-tnj07l-704c`（叫起床，已过期）已 forget，索引已移除；其余 8 条保留。

## 未完成

| 项 | 说明 |
|---|---|
| 无 memd 降级实测 | 方案第十四节第 2 条：停 memd 看桌宠是否正常回复、无报错 |
| pet 自包含实测 | 方案第十四节第 5 条：`qq-bridge/` 改名后 pet 能否独立跑 |
| 观察：短 chat 噪声 | **决定先不过滤**（2026-10-28）。10-27 的 498 条里 260 条是 10 字以内碎片（占条目 52%、字符 7%）。先全量整理跑几天，看噪声是否真影响产出质量；若影响明显再按 kind 过滤 |
| 查重参照里 `qq-topic` 偏多 | 每天整理产出约 10 条，而桥接的群/私聊摘要每半小时写一条，所以「最近长期记忆」里九成是摘要。是否要按 kind 排除 `qq-topic`，等观察几天再定 |

## 2026-10-28 01:55：周期性提炼（周/月/年）

日整理管「今天发生了什么」，管不了「这周的主线是什么」——后者要跨文档看因果，单条记忆里没有。

同一个脚本加 `--period`：

| period | 输入 | 触发 |
|---|---|---|
| `daily`（默认） | 当天记忆 | 每天 |
| `weekly` | 最近 7 天决策文档 + 长期记忆 | 周一 |
| `monthly` | 最近 31 天 | 1 号 |
| `yearly` | 最近 366 天 | 1 月 1 日 |

- 综合提炼只看长期记忆（短期对主线没贡献）。
- 四个周期各有独立 state 键与会话，互不干扰。
- `supervisor.mjs` 第五步改成循环四个周期，串行跑。
- dry-run 实测：`weekly rows=137 docs=15`、`monthly rows=137 docs=18`、`yearly rows=137 docs=18`（数据只到 10 月，月/年暂时一样）。

同时给日整理补了两条纪律：**已进 docs/40-decisions 的不重复记正文**（只留一句索引）、**不设数量上限**。

已完成（本节早先列过、现已收口）：定时接入（22:14）、整理产出 `source`（22:53）、检索基线（23:30）、`idem:*` meta 重映射（23:55）。

## 已知偏差（纠正之前的判断）

- **body 大小上限其实早就有了**：`server.mjs` 的 `BODY_LIMIT = 2MB`，不用做。
- 配置校验一直是有的（`config.mjs` 十几处 `throw`），只是手写而非 schema。
- 整理脚本 import 的是 `../../qq-bridge`（部署目录，含 node_modules），不是 memory-hub 里的源码副本——这是 ops 工具，可接受。

## 2026-10-27 21:20：重启后核对与修复

全链路重启完成后逐项验收，修掉四处、留一处待定。

| 项 | 处理 |
|---|---|
| `sleep-consolidate.mjs` 的墓碑过滤只覆盖「同一天」 | **已修**：删除行是后追加的、时间与原文不同天，所以先把全库墓碑 id 扫成集合，再筛今天的记录。修前 dry-run 里还留着 20:07 忘掉的 `704c`（叫起床）与 `97c6`（群友不设限），修后为 0。 |
| pet 的 `recallK` / `recallMaxChars` 仍是 3 / 800 | **已修**：`config.json` 与 `config.example.json` 改成 5 / 1500，重启 pet（新 pid 37632）生效。代码默认值早就改了，是配置覆盖导致的「改名不生效」。 |
| pet 配置里的 `cardFile` / `injectCard` / `refreshMs` | **已删**：代码只读 `memory.root`，这几项是记忆卡时代的残留。`maxChars` 保留——`config.mjs` 会用它做默认填充。 |
| pet 场景混进 6 条 `{"facts":[...]}` 原文 | **已 forget**：`fact-pet-tnj07r-8f0d`、`tnj07v-ead7`、`tnj07w-15a2`、`tnj080-3341`、`tnj086-daed`、`tnj08a-2765`。上一版回退方案把整理结果当聊天 ingest 留下的。 |
| `policy.ts` 第 11 行注释 | **已改**：原文写「secret 永不可读写」，与 2026-10-27 的放开相矛盾，改成 scope + audience 的实际规则。 |
| 短期聊天 id 仍是 `chat:<scene>:<hash16>` | **待定**：`routes.ts:1007-1009` 用 message_id 派生是为了幂等，换成 `newFactId` 会破掉重放去重。正解是把幂等键改成 `source_message_id` 唯一约束。 |

核对时的确定性结论：190 + 29 项测试全过；`format:"block"` 生效；`sleep-consolidator` 已在 preset 列表；`f_` 与迁移前的 `chat:` 前缀为 0；secret 的默认 audience 是 `['main']`。

## 2026-10-27 22:14：定时整理接入 + preset 验证

### 定时接入

- `config.ts` 新增 `SleepConfig`：`enabled`（默认 false，只有写 `true` 才开）、`at`（`HH:mm`，非法回退 `03:00`）、`retryMinutes`（夹 5–1440）。
- `supervisor.mjs` 加第 5 步：开关开着 + 过了今天的 `at` + 今天没成功跑过才跑；`sleepStartedAt` 20 分钟内视为进行中；失败按 `retryMinutes` 退避；**memd 不在就跳过**（整理者要用 MCP 写回）。
- 本机 `config.json` 已开：`{ "enabled": true, "at": "03:00", "retryMinutes": 30 }`。
- 验证：`sleep=skip(already ran today)`。

### preset 验证（真跑）

`2026-10-27T14:12:46Z done ms=99412 chars=1100`，写 10 条长期记忆。id 全是统一格式，audience 判断正确（群的事给群、私聊的事给私聊、跨场景写两个）。

### 同轮修掉的三个 bug

| # | 位置 | 现象 | 根因 | 修复 |
|---|---|---|---|---|
| 1 | `sleep-consolidate.mjs:132` | 首次跑 `(content ?? []).filter is not a function` | 传了 `event.data.message`，而 `blocksToText` 要的是 `ContentBlock[]` | 传 `event.data?.message?.content` |
| 2 | `bridge.js:9007`、`sleep-consolidate.mjs:162` | 桥接对同一个 key 反复重建（21:41 / 21:47 / 22:11 三次） | `session/list` 返回 `{ items }`，代码读 `{ sessions }` → 永远是空集合 → 每轮判「已归档」 | `listed?.items ?? listed?.sessions ?? []` |
| 3 | `bridge.js:13260` | 修完 #2 后又不再重建（归档会话照样在 `items` 里，DSH 不暴露归档状态） | 只能从行为上认 | 连续 3 个空回合 → 退役重建；有文本就清零 |

### 重复整理与去重

第一次跑崩在 #1，但 prompt 已发进 DSH，agent 继续写完 6 条；第二次重跑又写 10 条，5 对内容重叠。已 forget 简版（`tnkksi-684a`、`tnkksm-c9b4`、`tnkksm-a97d`、`tnkksm-befe`、`tnkks8-f289`），保留详细版。

根因修复：`catch` 里加 `api.stopSessionWork(sessionId)`——脚本放弃等结果时必须停掉 DSH 的在途回合，否则下一次重试就是两份。

## 2026-10-27 22:55：P0 两条补完

| 项 | 处理 |
|---|---|
| 整理输入只有当天清单 | **已补两段参照**：`/v1/recent`（k=10）的最近长期记忆 + `40-decisions` 最近 5 条（标题 + 200 字）。**没用 `/v1/search`**——没有可靠的当日实体抽取，硬搜出来是噪声。dry-run 实测 `today rows=404 longRefs=10 decisions=5`。 |
| 整理产出没有来源标记 | **已加 `source`**：`SOURCE_VALUES` 增加 `sleep`，`/v1/write` 只认 root 传的 `source`（非 root 传了会被忽略），MCP `memory_write` 暴露该参数，整理 prompt 要求每条都带。实测 root 写 `source=sleep` 落盘为 `sleep`，pet 令牌传 `sleep` 落盘仍是 `qq`。 |

测试仍 190/190。这两个改动同时把方案第十四节验收第 4 条（整批回滚）从不成立变成成立。

## 2026-10-27 23:22：P1 三条收口

| 项 | 处理 |
|---|---|
| 桥接仍自拼 `【长期记忆】`/`【相关记忆】` | **已改**：`adapter-qq/src/memory-client.ts` 请求加 `format:'block'`，原样用服务端渲染的 `block`；身份那一句（`/v1/bootstrap`）单列成 `【身份】`，不属于记忆块。 |
| 桥接仍推 `【记忆回顾】` | **已撤**：与「夜间整理是主路径」冲突。`payload.review` 还在响应里，只是不再注入 prompt。 |
| pet 缺 `/v1/recent` | **已补**：三路取数齐了（recall + live + recent），`recent.k` 默认 5，`"recent": false` 可关。recall 和 recent 并发发出。 |

顺手清掉两处残留：`pet/README.md:208` 的「除记忆卡之外」；`pet/src/config.mjs` 的 `memory.maxChars`。

关联的测试断言跟着改：`qq-memory-client.test.ts` 的 mock 补 `block` 字段、断言改成「不再注入 review hint」「用服务端 block」；`memory.test.mjs` 改成按 url 找请求（recall/recent 并发，顺序不保证）。

测试：memory-hub 190/190、pet 29/29。

## 2026-10-27 23:30：检索基线

`scripts/verify-recall.mjs` 加 `--baseline`：

- 12 条固定查询（中文短语 ×4 / 长口语 ×3 / 时间线类 ×2 / 跨场景 ×1 / 近期 ×2）。
- 基线记 **top-3 锚点 id**，存 `data/recall-baseline.json`；`--update` 重写。
- 判定看**主锚点**（原 top-1）的排名变化——平均法会把「1↔3 互换」判成持平。主锚点没动但辅助锚点全掉出 top-10 也算下降。
- 只报告不阻塞，退出码 0；没有基线文件时才返回 1。

负向测试三种都判对：

```text
未命中  q01「记忆对账」  1→出局            ← 锚点 id 写成不存在的
下降  q02「桌宠」  1→3 2→2 3→1            ← 锚点顺序反转
下降  q03「QQ 桥接」  1→1 2→出局 3→出局    ← 主锚点没动、辅助全掉
12 查询：9 保持，0 上升，2 下降，1 未命中
```

基线已恢复成正常状态（12 保持）。

## 2026-10-27 23:55：去重键收口（idem / dedupe）

问题：`migrate-ids.mjs` 是「删掉 index.db 重建」，meta 表里的去重键跟着一起没。之前方案只写了「校验 idem 重映射」，脚本实际没做。

**现状核查**：迁移后新写入的 24 个 `dedupe:*` 和 11 个 `idem:*` 都指向新 id，**是有效的**、不需要改；真正丢的是**迁移那一刻之前**建立的键，它们随索引重建消失了。

处理：

| 项 | 做法 |
|---|---|
| `idem:*`（idempotency_key → id） | 重建索引**前**先导出，重建后按 id 映射写回；旧 id 不在映射里说明那条记忆已经没了，丢弃。key 本身是客户端传的，JSONL 里没有，所以只能这样保。 |
| `dedupe:*`（内容 → id） | 从 JSONL 重算。新增 `indexer.ts` 的 `rebuildDedupeKeys(db, config)`，按 `scene + kind + 正文 + audience + privacy + subject` 算键，跳过墓碑和短期记忆。 |
| 存量修复 | `migrate-ids.mjs --sync-meta`：不迁移 id，只重建 dedupe 键（要求 memd 停着）。 |

对现有库跑了一次：

```
{"mode":"sync-meta","dedupeRestored":149,"dedupeTotal":173,"idemTotal":11}
```

验证去重真的生效（把今天整理写的 `fact-main-tnkks8-90fc` 原样再写一遍）：

```
rewrite same content -> 200 {"id":"fact-main-tnkks8-90fc","indexed":false,"duplicate":true}
fresh content        -> 200 {"id":"fact-main-tnkodx-d270","indexed":true,"duplicate":false}
```

测试 190/190。

## 2026-10-27 23:50：整栈重启踩到管道继承

跑 `restart-stack.ps1` 时卡了 5 分钟以上（`starting stack` 之后再无输出），但三个服务其实都起来了。

**根因**：`start-stack.ps1` 的 memd 段这么写的——

```powershell
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $memoryStart *>&1 |
    ForEach-Object { Write-Log ("memd: " + $_) }
```

`start.ps1` 用 `Start-Process` 起 memd，memd **继承了父进程的管道句柄**；于是 `start.ps1` 明明已经 exit 0，管道却一直开着等 memd 结束——整栈启动就僵在那里。

**修法**：改成 `Start-Process -Wait -RedirectStandardOutput/-RedirectStandardError` 到文件，再 `Get-Content` 回读。子进程拿不到管道，`-Wait` 只等 `start.ps1` 本身。

改完重跑：`restart-stack → exit 0`，`--- stack done ---`，pet / bridge / backup / 收尾状态全部按顺序走完。

顺带记一条环境事实：**从带沙箱的 shell 里跑整栈重启，起的常驻进程会被回收**——这次 memd 就在 `start.ps1` 退出后没了，由 `memd-watchdog` 在 23:39:03 补上。生产路径（登录任务 / 计划任务）不受影响，但手工重启时要知道这一点。

## 2026-10-28 01:10：架构收口四项

| 项 | 处理 |
|---|---|
| 整理脚本指向部署目录的 qq-bridge | **改成仓库内嵌副本** `../qq-bridge/src/...`；`memory-hub/package.json` 补声明 `js-yaml` / `@deepseek-ai/dsh-host-apiproxy`（它们原本只在部署目录和 pet 里有）。本机靠 `memory-hub/qq-bridge/node_modules` 的 junction 指向部署依赖树先跑通——第三方 `pnpm install` 会真装。 |
| `source` 把桌宠算成 qq | **已修**：`sourceForScene()` 按 scene 前缀判，pet 场景落 `pet`；`SOURCE_VALUES` 加 `pet`。存量 92 条里 91 条是短期、1 条是测试，没动。 |
| `/v1/recent` 还是客户端渲染 | **已改**：加 `format:"block"`，服务端用 `renderMemoryBlock` 渲染「【最近记下的】（按时间倒序，不是「相关」）」。桌宠直接取 `block`。三端至此全部服务端渲染。 |
| 测试盲区 | 新增 `tests/integration/source-and-block.test.ts` 三项：source 的 root-only、`rebuildDedupeKeys` 幂等、recent 的 block。**193/193**；pet **29/29**。 |

## 2026-10-28 04:25：review 链完全移除

决策 `2026-10-27-0016` 第 4 条当时写的是「不再是主路径」，这次按「完全替代」执行到底。

**删掉的**

| 层 | 内容 |
|---|---|
| 服务端 | `/v1/review`、`/v1/persist` 两条路由；`review.ts` 整个文件；`app.ts` 的 review 定时器；`recall` 响应里的 `review` 字段 |
| 协议 | `TReviewRequest/Response`、`TPersistRequest/Response`；config schema 里三个 `review*` 字段；openapi 的对应路径 |
| MCP | `memory_review`、`memory_persist` 两个工具 + instructions 里那句「看到【记忆回顾】用 memory_review」 |
| SDK | `review()`、`persist()` 两个方法 |
| 配置 | `shortTerm.reviewLookbackHours / reviewLimit / reviewIntervalHours`（接口、DEFAULTS、normalize 三处） |
| 测试 | 删 `review-scheduler.test.ts`、`persist-jsonl.test.ts`；`shortterm` 删 3 个 review/persist 用例；`tools.test` 工具清单去掉两项；`config-update` 删 reviewInterval 断言 |
| 文档 | README 接口表两行 + 回顾段 + 工具数（11→9）；AGENTS 第六节的回顾约定 |

**验证**

- `POST /v1/review` → 404、`POST /v1/persist` → 404
- memory-hub **185/185**（原 193，删掉 8 个 review/persist 用例）
- pet **29/29**
- openapi.json 重新生成：20 → 18 条路径
- MCP 工具从 11 个减到 9 个

**影响**：短期记忆转长期现在**只剩夜间整理一条路**。没有手动提升通道，也没有「到期提醒」。这是「完全替代」的直接后果，接受它。

**遗留**：`review:pending:*` 的 5 个 meta 键还在索引里（没人写了）。它们不影响任何逻辑，下次重建索引时会自然消失。

### 两条没动的结论

- **两套 `ensureSession` 不合并**。桥接那份要管 preset 选择、休眠恢复、会话代际、策略校验；整理脚本只要「建/复用固定 preset 会话」。职责范围差得远，共同点只剩「会话是否还活着」这一句——抽出来收益小于维护成本。当时那个 `session/list` 字段错误两边都踩，是因为各自复制了同一段代码，不是同构设计的问题。
- **review 不是死代码**。`/v1/review`、`/v1/persist`、`memory_review` / `memory_persist` 两个 MCP 工具都还在用；桥接只是不再下发 `【记忆回顾】` 提示。它现在是「手动回顾工具」，`review:pending:*` 每 20 小时才更新一次。要删得先确认 MCP 工具也下线。
