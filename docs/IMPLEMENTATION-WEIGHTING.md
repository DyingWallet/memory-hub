# 实现计划：记忆加权模型

> 依据 [`MEMORY-WEIGHTING.md`](MEMORY-WEIGHTING.md)（定稿）。
> 本文是可执行清单：改哪些文件、按什么顺序、怎么验证、怎么回滚。
> 状态：**已执行**（2026-10-29）。四步全部落地，197 项测试通过；运行中的 memd 需重启才加载新代码。

---

## 一、现状盘点

| 已有 | 位置 | 说明 |
|---|---|---|
| `docs` 主表 | `packages/server/src/db.ts:18` | 存文档与事实 |
| `recall_count` 列 | `db.ts:113`（迁移里加的） | **已存在**，但只在 `stage='short'` 召回时 +1（`routes.ts:960-967`） |
| `migrateColumns()` | `db.ts:112` | 幂等加列，新字段走这里 |
| JS re-score | `search.ts:114-145` | 加乘数的天然位置 |
| `TFactRecord` | `packages/protocol/src/schemas.ts:555` | 已有 `recall_count`，缺 `importance` |
| facts JSONL | `memories/facts/*.jsonl` | append-only，索引可重建 |

**结论：不需要新建 `touches` 表，也不需要 `last_recalled_at`。** `recall_count` 已经在维护，直接拿它放大 `tau`（见 §3.1），改动面比原设想小一半。

---

## 二、数据模型

### 2.1 `docs` 表新增四列

| 列 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `importance` | `INTEGER NOT NULL DEFAULT 1` | 1 | 0–3，写入时标注 |
| `open_loop` | `INTEGER NOT NULL DEFAULT 0` | 0 | 0/1，话没说完 |
| `closed_at` | `INTEGER` | NULL | 收尾时间（ms），算第三条痕迹 |

### 2.2 `TFactRecord` 新增三个可选字段

```ts
importance: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
open_loop: Type.Optional(Type.Integer({ minimum: 0, maximum: 1 })),
closed_at: Type.Optional(Type.String({ maxLength: 40 })),   // ISO
```

**全部 Optional**：旧 JSONL 记录没有这些字段，读出来按默认值处理（importance=1、open_loop=0、closed_at=null）。这样**不需要数据迁移脚本**。

---

## 三、算法

### 3.1 strength

```ts
const DAY = 86_400_000;

function strengthOf(doc, now) {
  const baseTau = doc.importance >= 3 ? 18250 : 14 * (1 + doc.importance);
  // 用得多 → 沉得慢。log 放大，边际递减：n=10 约 2.2 倍，n=100 约 3.3 倍。
  const tau = baseTau * (1 + 0.5 * Math.log(1 + (doc.recall_count || 0)));
  const created = doc.created_at || now;

  let s = Math.exp(-(now - created) / DAY / tau);
  if (doc.closed_at) s += Math.exp(-(now - doc.closed_at) / DAY / tau);
  return s;
}
```

**为什么不用「每次召回叠一道痕迹」**：那需要每次召回的时间戳；只用 `recall_count` 近似会系统性高估（把一年前衰减掉的痕迹当成昨天刚发生的）。改成放大 `tau` 之后语义变成「用得多 → 沉得慢」，不需要时间戳，也没有分布偏差；`log` 天然封顶：n=10 约 2.2 倍，n=100 约 3.3 倍。

### 3.2 检索分

```ts
const BETA = 0.30, K = 3, DELTA = 0.30;

const strength = strengthOf(row, now);
const weighted = baseScore
  * (1 + BETA * Math.tanh(strength / K))
  * (1 + DELTA * row.open_loop);
```

**放在哪**：`search.ts` 的 `scored = rows.map(...)` 内部，`return` 之前。`baseScore` 是现有那一段算出来的 `score`。

**门槛**：现有逻辑里 `rows` 已经过了 FTS 匹配，所以「不相关的一律不动」这条天然成立——乘数只作用于已经命中的行。

---

## 四、改动清单

| # | 文件 | 改动 | 风险 |
|---|---|---|---|
| 1 | `packages/protocol/src/schemas.ts` | `TFactRecord` + 3 个 Optional 字段；`TSearchHit` 加 `explain?` 对象 | 低 |
| 2 | `packages/server/src/db.ts` | `migrateColumns` 加 4 个 `add(...)`；`upsertDoc` 的 INSERT/UPDATE 加 4 列 | 中（SQL 要同步） |
| 3 | `packages/server/src/indexer.ts` | 写 fact 时落 `importance` / `open_loop` / `closed_at`；reindex 从 JSONL 读 | 中 |
| 4 | `packages/server/src/search.ts` | re-score 段算 strength + 两个乘数；explain 填分量 | **高**（影响所有检索） |
| 5 | `packages/server/src/routes.ts` | `/v1/search` 支持 `explain=1`；`recall_count` 的 +1 从 short 扩展到所有 stage | 中 |
| 6 | `memory-hub/scripts/sleep-consolidate.mjs` | prompt 加 `importance` 两问 + `open_loop` 判定 | 低 |
| 7 | `memory-hub/docs/MEMORY-WEIGHTING.md` | 把「未实现」改成「已实现」，补一行 recall_count 的简化说明 | 低 |

---

## 五、测试

| 层 | 用例 |
|---|---|
| unit | `strengthOf`：四档 tau 的衰减曲线、recall_count=0/1/10 的差异、closed_at 的加成 |
| unit | 加权：BETA=0 时 results 与改动前逐项相同（**回归基线**） |
| integration | `/v1/search?explain=1` 返回 `strength` / `importance` / `openLoop` / `finalScore` |
| integration | 写一条 `importance=3` 的 fact → reindex → 它的 strength 在 1 年后仍 > 0.9 |
| integration | `recall_count` 更新：召回一条 long 记忆后 +1，其 `tau` 随之放大 |
| contract | `TFactRecord` 缺字段的旧记录能正常索引（默认值生效） |

**回归基线**：改完前后各跑一次 `scripts/verify-recall.mjs --baseline`，BETA=0 时 12 条查询结果必须逐条一致。

---

## 六、执行顺序

分四步，**每步可独立验证、可独立回滚**：

### 第 1 步：schema 与迁移
改 #1 #2。跑 `npm run build`，确认 `memd` 起来后 `PRAGMA table_info(docs)` 有四个新列。
**此时行为完全不变**（没人读这些列）。

### 第 2 步：写入路径
改 #3。写一条带 `importance` 的 fact，确认 JSONL 和 `docs` 表里都有值。
**此时行为仍然不变**。

### 第 3 步：检索加权（系数为 0）
改 #4 #5，但把 `BETA` / `DELTA` 先设成 **0**。
跑回归基线，结果必须与改动前完全一致。
再把系数调到 0.30 / 0.30，观察排序变化。

### 第 4 步：标注与动态
改 #6（整理会话标注）+ #5 的 `recall_count` 扩展。
跑一夜整理，看新写入的 fact 有没有 `importance`。

---

## 七、风险与回滚

| 风险 | 影响 | 回滚 |
|---|---|---|
| 加权后排序偏移过大 | 老查询结果变化 | `BETA = DELTA = 0`，一行改回 |
| SQL 列不同步 | 写入失败 | 四个 `add()` 是幂等的，可反复跑 |
| `recall_count` 扩展后短期记忆 TTL 逻辑被破坏 | 短期记忆不过期 | 扩展用 `AND stage='long'` 分流，不复用原分支 |
| 整理会话不按 prompt 标 importance | 全是默认值 1，等于没做 | 看 facts JSONL 的字段分布；没标说明 prompt 要改 |
| 索引重建后数值不一致 | 破坏「可重建」承诺 | `strength` 不落盘，本来就每次现算，天然一致 |

**最坏情况**：把 `BETA` 和 `DELTA` 设 0，系统回到改动前的行为，数据层四列留着无害。

---

## 八、不做的事

- 不新建 `touches` 表，也不加 `last_recalled_at`（`recall_count` 只用来放大 `tau`）
- 不改 FTS / 向量检索本身
- 不做主动驱动（加权只影响排序）
- 不做 `deadline` / `urgency` / `readiness`（已在模型文档里否掉）
- 不删除任何数据
