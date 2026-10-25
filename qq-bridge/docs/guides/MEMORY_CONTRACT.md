# QQ 记忆工具契约

> 2026-10-25 定稿。这份文件回答一件事：QQ 侧每个记忆工具读写什么、参数是什么、返回什么字段。
> 改工具或加工具时先改这里，再改代码。

## 为什么有两层存储

| 层 | 存在哪 | 内容 | 生命周期 |
|---|---|---|---|
| 轻量记忆 | 桥接 `state/social-v2.json` | `activeTopics` / `pendingThoughts` / `memberImpressions` | 无 TTL，手动删；注入时各取最近 10 条 |
| 长期记忆 | memd `index.db` | 文档、事实、决策、短期 chat | 长期永久；短期 TTL 24h、召回延长 |

两层不合并：轻量记忆是「我主动提炼的当前关注」，memd 是「自动收录的原文流 + 共享库」。合并会丢掉 memd 不可用时的 fail-soft，也会让「话题结束」这种生命周期没有归宿。

写入时轻量记忆会镜像一份到 memd（`qq-topic` / `qq-impression`），读取仍各走各的。

## 工具清单

| 工具 | 存储 | 参数 | 返回 |
|---|---|---|---|
| `qq_memory_append` | 轻量 | `category` / `content` / `extra` | 更新后的轻量记忆块 |
| `qq_memory_query` | 轻量 | `category?` | 轻量记忆块 |
| `qq_memory_remove` | 轻量 | `category` / `content` 或 `target` | 是否删除 |
| `qq_memory_clear` | 轻量 | `category?` | 清空结果 |
| `qq_memory_search` | memd | `query` / `k` / `kinds?` / `subject?` | `{ id, title, kind, text, stage, expires_at?, score }` |
| `qq_memory_get` | memd | `id` | 同上（单条） |
| `qq_memory_recent` | memd | `k` | 同上（列表） |
| `qq_memory_timeline` | memd | `from?` / `to?` / `limit?` | `{ from, to, total, returned, next_before?, months[{ month, count, items[] }] }` |

所有 memd 工具都走会话令牌 + 场景校验：群只能看本群，他人私聊只能看自己，主人私聊与主会话读范围一致。

## 与主会话的对应

| QQ 工具 | 主会话 MCP 工具 | 备注 |
|---|---|---|
| `qq_memory_search` | `memory_search` | 字段已对齐：`stage` / `expires_at` / `score` 都透传 |
| `qq_memory_get` | `memory_get` | |
| `qq_memory_recent` | `memory_recent` | |
| `qq_memory_timeline` | `memory_timeline` | 描述口径一致：问「那阵子 / 上个月」用它 |
| — | `memory_recall` / `memory_bootstrap` / `memory_write` / `memory_review` / `memory_persist` / `memory_call` | QQ 侧刻意不开放（写入走 `append` 镜像，回顾由桥接唤醒提示引导） |

## 不合并成一个工具的理由

- 轻量与长期是两层存储，失败语义不同（本地永远可用，memd 可能挂）；
- 一个 `action` 参数工具的错误组合比四个语义清晰的工具更难防；
- 预设提示词按名字引用这些工具，改名要同步提示词、白名单和测试。

以后要加工具（比如 `qq_memory_write`），按 `memory_call` 的做法加一个兜底入口，**不替换**现有工具。
