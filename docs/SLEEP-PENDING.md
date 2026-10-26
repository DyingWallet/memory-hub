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

测试：memory-hub **190 项**、pet **29 项**，全过。

## 需要你执行或决策

1. **装整理 preset**（改 `~/.dsh`，沙箱写不了）：
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\install-sleep-preset.ps1
   # 然后重启 DSH，再验证：
   node scripts\sleep-consolidate.mjs --dry-run
   node scripts\sleep-consolidate.mjs
   ```
2. **执行 ID 迁移**（不可逆，我留着没跑）：
   ```powershell
   # 先停 memd
   node scripts\migrate-ids.mjs --apply
   ```
   dry-run：1520 行 / 1287 个 id / 0 冲突 / 0 条 supersedes 引用；apply 自动备份到 `backups/ids-before-<时间>/`。
3. **回退留下的 10 条 `source='sleep'` 记忆**：留还是 forget，你定。

## 未完成（等上面第 1 条做完再继续）

| 项 | 说明 |
|---|---|
| 定时接入 | 按「一个项目只保留一个定时任务」，把整理并进 `supervisor.mjs` 的 tick（`config.sleep.enabled` 默认关，装好 preset 再开） |
| 检索基线 | `verify-recall` 的 `--baseline` 对比模式 |

## 已知偏差（纠正之前的判断）

- **body 大小上限其实早就有了**：`server.mjs` 的 `BODY_LIMIT = 2MB`，不用做。
- 配置校验一直是有的（`config.mjs` 十几处 `throw`），只是手写而非 schema。
- 整理脚本 import 的是 `../../qq-bridge`（部署目录，含 node_modules），不是 memory-hub 里的源码副本——这是 ops 工具，可接受。
