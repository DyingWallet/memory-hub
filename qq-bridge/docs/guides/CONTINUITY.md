# 人际连续性：跨群认人、人物记忆、入群感知、跨群协作（v0.3.0）

> 代码：`src/social/people.js`（人物库）· `src/social/memory-policy.js`（可见性过滤）·
> `src/social/group-events.js`（成员事件）· `src/social/cross-group.js`（跨群查询）·
> 接线在 `src/bridge-extensions.js` 与 `src/bridge.js`。离线测试：`scripts/test-continuity.mjs`、`scripts/test-integration-v030.mjs`。

## 1. 一个 QQ 号可以同时在多个群

原版机制保持不变：`allow.groups` 里列多少个群，机器人就在多少个群里工作；**每个群仍然是独立的 DSH 会话**，
上下文、二代未读/唤醒状态都按群隔离。v0.3.0 只是在这些会话之外加了一份**按 QQ 号组织的人物库**，
它不会把不同群的消息合并成一个会话。

## 2. 身份只认 QQ 号

- 人物库的主键是 QQ 号（OneBot 的 `user_id`）。群名片、昵称只是附带字段，按群分别记录，并保留最近 10 次变更历史。
- **同名不同号 = 两个人**；**同号不同名 = 同一个人**。按名字查找只返回候选列表（`findByName`），不会替你挑一个。
- 「我是 X 的小号」只能由管理员用 `/person <QQ> alias <小号QQ>` 标注；标注不会合并两份档案。
- SnowLuma 无法解析的 UID 会给出 `user_id = 0`，这类事件一律丢弃，不建档。
- 名片里的换行、零宽字符、双向控制符会被清理成单行文本（防止用名片在提示词里伪造段落）。

## 3. 数据结构（`state/social/people.json`）

```jsonc
{
  "version": 1,
  "people": {
    "<QQ号>": {
      "qq": "...",
      "firstSeenAt": 0, "lastSeenAt": 0, "firstSeenIn": "group:<群号>",
      "nickname": "QQ 昵称", "nicknameHistory": [{ "value": "...", "at": 0 }],
      "acquaintance": "listed | observed | talked | familiar",   // 认识程度
      "acquaintanceSetBy": null | "admin",                       // 管理员设定后不再自动变化
      "preferredName": { "value": "跨群称呼", "setBy": "admin", "at": 0 } | null,
      "preferences": { "teasing": "ok|avoid", "proactiveChat": "...", "poke": "...", "recallPast": "..." },
      "groups": {
        "<群号>": { "status": "member | left", "card": "本群名片", "cardHistory": [], "firstSeenAt": 0, "lastSeenAt": 0,
                   "joinedAt": 0, "leftAt": null, "joinCount": 0, "messageCount": 0, "source": "message|join|baseline|reconcile" }
      },
      "private": { "firstSeenAt": 0, "lastSeenAt": 0, "messageCount": 0 } | null,
      "notes": [ {
        "id": "n12", "text": "≤120 字", "scope": "group:<群号> | private:<QQ> | global",
        "visibility": "group:<群号> | private:<QQ> | public", "shareStatus": "local | pending | approved",
        "source": "witnessed | backread | hearsay | inferred", "certainty": "explicit | impression",
        "origin": "ai | admin | migration", "pinned": false, "reportedBy": "<QQ>|null", "createdAt": 0, "updatedAt": 0
      } ],
      "aliases": ["<管理员标注的小号>"], "talkCount": 0
    }
  },
  "groups": { "<群号>": { "baselineAt": 0, "lastReconcileAt": 0 } },
  "legacyReview": [ /* 旧版记忆迁移时映射不上的条目，待人工确认 */ ],
  "migrations": { "memberImpressions": { "<会话key>": 0 } }
}
```

**认识程度**：首次部署对账时已在群里的人 = `listed`；看过 TA 说话 = `observed`；私聊、@机器人、引用机器人 = `talked`；
`familiar` 只能由管理员设定（「经常发言」不会自动升级为熟人）。

## 4. 两层记忆与共享策略

| 作用域 | 写入方 | 默认可见范围 |
| --- | --- | --- |
| `group:<群号>` | AI（`qq_note_person`）、管理员 | 只在该群 |
| `private:<QQ>` | AI（只能在与本人的私聊里写）、管理员 | 只在与本人的私聊 —— **任何策略下都不外流** |
| `global` | 只有管理员（`/note <QQ> <内容>`） | `shared` 策略下所有群 |

`continuity.sharePolicy`（默认 **`identity`**）：

| 策略 | 在 B 群里关于「也在 A 群的人」能看到什么 |
| --- | --- |
| `none` | 只有 B 群自己的记录；连「在别的群见过」都不提 |
| `identity`（默认） | + 「是同一个 QQ 号」「在另外 N 个群见过」（群有 `label` 时显示标签）、管理员设定的跨群称呼、认识程度、互动偏好。**不带任何别处的记忆内容** |
| `shared` | + `visibility=public` 且已批准的记忆：管理员写的 global 记忆、AI 申请共享并经管理员 `/share approve` 批准的群内记忆 |

群级覆盖：`continuity.groups.<群号>.sharePolicy` 只能把某个群调**更严**；两个群之间生效的是两边较严的一档。
`recordable: false` 的群不写人物库、不出现在其他群的视图里，其记录即使被批准过也不外流。

**可见性在注入时由程序执行**：所有给模型的人物信息都经过 `memory-policy.js` 的 `noteVisibleIn()` / `buildPersonView()`；
唤醒提示词的【在场人物】小节只包含本轮消息里出现的发言者（最多 8 人 / 1500 字，可配置）。

**冲突处理**：本群名片 > 管理员设定的跨群称呼 > QQ 昵称；本群记录排在跨群记录之前并告诉模型「本群记录为准」；
置顶（含被纠正过的条目）优先于普通印象，`explicit` 优先于 `impression`；文字相同的条目只保留一条。

**删除是真删除**：`/person <QQ> forget`（或控制台 `POST /api/people/delete`）删除此人全部作用域的记录；
`/note-del <QQ> <编号>` 删一条。

## 5. 新成员入群 / 退群 / 改名片 / 撤回

SnowLuma 1.14.22 实际发出的通知（对照其源码 `packages/onebot/src/event-converter/to-notice.ts`，ID 都是 number）：

| 通知 | 字段 | 桥接处理 |
| --- | --- | --- |
| `group_increase`（sub_type `approve` / `invite`） | group_id, user_id, operator_id | 查人物库分类 → 二代消息流插入 `[入群]` 事件 → 按配置唤醒 |
| `group_decrease`（`leave` / `kick` / `kick_me` / `disband`） | group_id, user_id, operator_id | 记录离开；默认不唤醒、不追问原因 |
| `group_card` | group_id, user_id, card_new, card_old | 更新名片历史。**注意**：SnowLuma 是在「该成员下一次发言」时对比缓存派生出这个事件的，不是实时推送 |
| `group_recall` | group_id, user_id, operator_id, message_id | 只记录，不回应、不复述 |

入群分类：`stranger`（第一次认识）/ `knownElsewhere`（在别的允许记录的群或私聊认识）/ `returning`（以前在本群、退群后回来）/
`alreadyMember`（记录里本来就在，多为补发事件）/ `duplicate`（重复投递）。默认对前三类唤醒（`continuity.joinEvents.wakeOn`）。
AI 收到的唤醒提示只描述行为规则（不强制欢迎），具体人物信息来自已过滤的【在场人物】。

可靠性处理：
- **重复投递**：事件指纹（群+人+time）去重 + 「10 分钟内已记为刚入群」逻辑去重；
- **断线期间丢事件**：SnowLuma 不重放离线事件。桥接在每次连上 SnowLuma 后（每群最多 10 分钟一次）拉成员名单对账：
  首次 = 全部标 `listed`（**不当新人**）；之后补记漏掉的入群（`source=reconcile`）和退群，**只记录、不唤醒**；
- **QQ 接口失败**：查新成员名片失败按「无名片」处理，不中断；拉名单失败下次连接重试；
- 机器人自己进群/被踢不当作「有人入群」。

## 6. 熟人加入新群

账号 A 在群 1 认识 X → X 加入群 2：群 2 的事件流里是 `[入群] <群2名片>（QQ x）… 在别处认识的人`，
【在场人物】显示「在另外 1 个群见过」（群 1 有 `label` 时显示标签）+ 管理员设定的称呼。
默认 `identity` 策略下，群 1 里的聊天内容与记忆**不会**出现在群 2 的提示词里。

## 7. 跨群协作（默认关闭）

`crossGroup.enabled=true` 并配置**有向**链接后，群会话可用 `qq_cross_group_query`：

```json
"crossGroup": { "enabled": true, "links": [ { "from": "<群A>", "to": "<群B>", "allow": ["presence", "activity"] } ] }
```

- `presence`：某个 QQ 号是否是目标群成员（只对人物库认识的人回答）；
- `activity`：目标群最近 1 小时 / 24 小时消息数、活跃人数、距上一条消息多久——**没有任何内容或名字**；
- 两端都必须在 `allow.groups`；目标群 `recordable=false` 时拒绝；私聊会话不能发起；每次查询写审计。

**跨群发送**：二代 AI 的会话令牌只对它自己所在的会话有效（`/api/send/*` 用目标会话校验令牌，原版即如此，v0.3.0 有回归测试），
所以 AI 不能往别的群发消息。owner 代发用管理通道 `/say <群号> <内容>`（白名单校验 + 在该群二代记忆里标注「受管理员之托」）。

## 8. 旧数据迁移

上游 v0.2.0 的二代记忆 `memberImpressions` 是「按群友名字、按会话」存的。v0.3.0 首次启动时：
同一会话最近消息里该名字**唯一**对应一个 QQ 号 → 导入为该会话作用域的记忆（`origin=migration`）；
找不到或同名多号 → 进入 `legacyReview`，管理通道 `/review` 或控制台 `GET /api/people` 查看，**不猜**。
旧字段原样保留（可回滚），每个会话只迁移一次。

## 9. 存储可靠性

- 原子写入：临时文件 → fsync → rename（Windows 上目标被占用时退避重试）；消息高峰时合并为最多每 2 秒写一次；
- 损坏恢复：读到坏文件 → 改名为 `.corrupt-<时间>` 留证 → 从 `state/social/backups/` 最近备份恢复；
- 滚动备份：每 6 小时最多一份，保留 7 份；结构迁移前自动备份 `pre-migrate-v<N>`；
- 版本保护：文件结构版本高于程序支持时拒绝加载（防止回滚后的旧程序把新字段写丢）；
- 保留策略（默认关）：`continuity.pruneListedAfterDays` > 0 时定期删除长期未出现、无记忆、未被管理员设定过的 `listed` 记录。

## 10. 已知限制

- `group_card` 依赖 SnowLuma 的消息派生，改名片后对方不说话就感知不到（下一次成员对账会补上）。
- 成员对账依赖 `get_group_member_list`；超大群首次对账可能较慢（15 秒超时，失败下次重试）。
- 熟悉度、偏好等「怎么相处」的判断最终由模型完成；程序只保证**身份确定**与**可见范围**。
- 离线整理会话、衰减、关系线（Thread）、群档案等设计文档里的后续阶段**未在 v0.3.0 实现**。
