# 夜间整理重构：执行记录与待办（2026-10-27 静默执行）

> 依据 `docs/SLEEP-CONSOLIDATION.md`。主人睡觉期间静默执行，需要鉴权/不可逆/需要拍板的项目列在下面。

## 已完成

| 项 | 提交 |
|---|---|
| MCP 三件套：`memory_forget`、`memory_write.supersedes`、privacy 枚举（含 sensitive/secret，work/financial 保留为旧别名） | `ac61d8e` |
| `secret` 通道：root / `secret:read` / `secret:write` 才可见，audience 钉在 `secretAudiences`（默认 main）；群、第三人私聊、pet 读不到 | `ac61d8e` |
| ID 规则统一：文档 `doc-<pathHash8>`，事实 `<source>-<scene>-<time36>-<rand4>` | `88895d8` |
| `scripts/migrate-ids.mjs`：确定性映射、默认 dry-run、apply 前要求 memd 停机并备份、同步改写 supersedes | `88895d8` |
| `/v1/recall` 的 `format: "block"`：服务端渲染提示词片段（标题/时间/截断/owner 标记），5 项单测 | `4804b2a` |
| pet 去跨仓库依赖：`src/dsh/{client,endpoint}.mjs` vendored，package.json 声明依赖 | `e2a1165` |
| pet `selectModel` 失败显式报错（不再静默落回 DSH 默认模型） | 见本轮 |
| pet 日志按大小轮转（10 MB × 1 份） | 见本轮 |

测试：memory-hub 190 项、pet 34 项，全过。

## 需要你执行或决策

1. **执行 ID 迁移**（不可逆，我留着没跑）：
   ```powershell
   # 先停 memd，然后
   node scripts/migrate-ids.mjs --apply
   ```
   dry-run 结果：1520 行 / 1287 个 id / 0 冲突 / 0 条 supersedes 引用。apply 会自动备份到 `backups/ids-before-<时间>/`。
2. **回退留下的 10 条 `source='sleep'` 记忆**：留还是 forget，你定。
3. **`sleep-consolidator` preset**：要写 `~/.dsh` profile 并重启 DSH，沙箱身份做不到。

## 未完成（下一批）

| 项 | 说明 |
|---|---|
| `/health` 拆分 | 收窄成 `{ok, service, version}`，详情搬到需鉴权的 `/status` |
| 错误码改造 | `unwrap` 抛出带 `code` 的 Error，`promptOnce` 把 code 透传到重试判断，`sessionNotFound` 改判 code |
| `/v1/models` 从 DSH 取 | 调 `session.modelCatalog`（回退 `session/models`），`/v1/models` 保持可请求 id + `x_dsh` 映射 |
| 去卡 + 删 bootstrap | pet 删 `memory-card.mjs`、`bootstrapText`、bootstrapped 状态；改 preset prompt |
| 整理脚本 | `scripts/sleep-consolidate.mjs`：发现 DSH、建会话、拼上下文、发 prompt、审计 |
| 定时接入 | 按「一个项目只保留一个定时任务」，并进现有看护 tick |
| 检索基线 | `verify-recall` 的 `--baseline` 对比模式 |

## 已知偏差（纠正之前的判断）

- **body 大小上限其实早就有了**：`server.mjs` 的 `BODY_LIMIT = 2MB`。这条不用做。
- **`unwrap` 抛出的错误只有字符串**，没有 `code`——错误码改造必须先改它，否则「按 code 判断」无从谈起。
- 配置校验一直是有的（`config.mjs` 十几处 `throw`），只是手写而非 schema。
