# 接口平台公共契约（v1 草案）

> 状态：M1 实现所依据的草案。命名可以在 M2 前调整；调整时同步改 `src/core/model.mjs` 和测试。
> 本文只描述**已实现**或**本轮明确要实现**的部分，未实现的标注「未提供」。

## 1. 术语与 ID

| 概念 | ID 形式 | 说明 |
| --- | --- | --- |
| 平台 platform | `qq` / `discord` / `kook` / `wechat` | 当前只实现 `qq` |
| 提供方 provider | `snowluma` / `napcat` / `qq-mac-native` … | 接入实现；当前实现 `snowluma`、`napcat`（两者共用 OneBot v11 连接器公共实现） |
| 接入实例 instance | 配置里的 `id`（如 `snowluma-main`） | 一份后端或一组连接配置，可以提供多个账号 |
| 账号 account | `<platform>:<平台原始账号>`（如 `qq:10001`） | 逻辑账号，**与实例 ID、提供方 ID 不混用**；换后端不换账号 ID |
| 会话 conversation | `{ type, id }`，type ∈ `private` / `group` / `temp` | `id` 是平台原始 ID 的**字符串** |
| 事件 event | `evt_<单调序号>` | 平台内唯一，作为订阅游标 |
| 请求 request | `req_<随机>` | 一次发送/动作的追踪号 |

所有平台原始 ID（QQ 号、群号、消息 ID）一律按**不透明字符串**处理，解析上游 JSON 时用源文本取值，避免超过 2^53 的整数被 `Number()` 截断。

## 2. 统一事件

```jsonc
{
  "v": 1,                       // 事件结构版本
  "id": "evt_42",               // 平台内序号（游标）
  "time": 1760000000000,        // 平台收到的时间（毫秒）
  "occurredAt": 1760000000000,  // 后端报告的发生时间（毫秒，可能缺失）
  "platform": "qq",
  "instance": "snowluma-main",
  "account": "qq:10001",
  "kind": "message",            // message / notice / request / meta
  "type": "message.group",      // 细分类型，见下
  "conversation": { "type": "group", "id": "20001" },
  "sender": { "id": "30001", "name": "群名片或昵称" },
  "message": {
    "id": "123456",             // 平台原始消息 ID（字符串）
    "segments": [ /* 见 §3 */ ],
    "text": "拼好的纯文本（便于检索，不作为权威内容）"
  },
  "ext": { "qq": { /* 平台扩展：notice_type、sub_type 等原样保留 */ } }
}
```

`type` 取值（QQ 连接器当前产出）：`message.private`、`message.group`、`message.temp`、`notice.<notice_type>`、`request.<request_type>`、`meta.heartbeat`、`meta.lifecycle`、`account.status`。
无法识别的上游事件不丢弃：`kind: "notice"`、`type: "unknown"`，原文放进 `ext.qq.raw`。

## 3. 消息段

| type | 字段 | QQ（OneBot v11）对应 |
| --- | --- | --- |
| `text` | `text` | `text` |
| `mention` | `target`（账号原始 ID 或 `all`） | `at` |
| `reply` | `messageId` | `reply` |
| `image` | `file` / `url` / `name` | `image` |
| `voice` | `file` / `url` | `record` |
| `video` | `file` / `url` | `video` |
| `file` | `file` / `name` | `file` |
| `ext` | `platform`、`kind`、`data` | 其余所有段（`face`、`mface`、`forward`、`json`、`poke` …）原样保留 |

发送时遇到连接器不支持的段：**整条请求失败**（`unsupported_segment`），不静默丢段。

## 4. 能力声明

```jsonc
{
  "message.send.text":    { "declared": true,  "verified": false, "since": null, "requires": ["account.ready"] },
  "message.send.image":   { "declared": true,  "verified": false },
  "message.history":      { "declared": false, "reason": "M1 未接入统一接口，可经 qq.onebot 扩展调用" },
  "ext.qq.onebot":        { "declared": true,  "verified": false, "note": "过渡兼容层：OneBot v11 动作透传" }
}
```

- `declared`：连接器宣称支持；`verified`：经过真实验收（由验收记录写入，代码里默认 `false`）。
- 「账号已登录」「当前允许发送」「后端宣称支持」「真实验收通过」分开记录，不混成一个布尔值。
- 未声明的能力被调用时返回 `capability_unsupported`，不伪造成功。

## 5. 健康阶梯

每个账号的状态按顺序回答：

```
core.running → backend.reachable → account.loggedIn → io.ready → bridge.enabled
```

另有原因字段 `reason`：`connecting`、`reconnecting`、`auth_failed`、`network_down`、`awaiting_login`、
`receive_unhealthy`、`version_unsupported`、`manual_required`、`disconnected_by_user`。
`io.ready` 取自 SnowLuma 心跳的 `status.good`（接收链路自评），不由「WebSocket 已连接」推断。

## 6. 发送语义

请求状态：

| 状态 | 含义 |
| --- | --- |
| `accepted` | 平台已收下请求，尚未交给后端 |
| `submitted` | 已写入后端连接，等待后端回执 |
| `confirmed` | 后端返回成功（retcode 0），带回平台消息 ID。**不代表对端已读或已送达** |
| `failed` | 后端明确返回失败，或平台在提交前拒绝（权限、能力、参数、账号未就绪） |
| `unknown` | 已提交但超时 / 连接中断，结果不可知。**平台不会自动重发** |

- 同一 `clientRequestId` 在去重窗口（默认 10 分钟）内只执行一次，重复提交返回原请求。
- 每个账号一个有上限的发送队列（默认 200），按账号内 FIFO；队列满返回 `queue_full`。
- 实例断开、切换后端期间，该实例的发送冻结：新请求直接 `failed`（`instance_unavailable`），在途请求标为 `unknown`。
- 不承诺跨外部系统的「恰好一次」。

## 7. 接口

### 7.1 数据接口（桥接用，`Authorization: Bearer <数据令牌>`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/accounts` | 账号与健康阶梯 |
| GET | `/v1/capabilities?account=` | 能力声明 |
| GET | `/v1/events?after=<evt>&account=` | SSE 事件流；带 `after` 时先重放缓冲区（默认 2000 条），超出窗口返回 `cursor_expired` 事件 |
| POST | `/v1/messages` | 发送：`{ account, conversation, segments, clientRequestId? }` → 请求对象 |
| GET | `/v1/requests/<id>` | 查询请求状态 |
| POST | `/v1/ext/qq/<action>` | QQ 平台扩展：OneBot v11 动作（`account` 放 query）。过渡层，见 §8 |

### 7.2 管理接口（控制中心用，`x-platform-admin-token`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/admin/overview` | 核心状态、实例、账号、计数、最近收发时间、支持范围 |
| GET | `/v1/admin/providers` | 已知提供方；未实现的标「尚未提供」 |
| POST | `/v1/admin/instances` | 新增实例 |
| POST | `/v1/admin/instances/<id>` | 修改实例配置 |
| POST | `/v1/admin/instances/<id>/connect` / `disconnect` | 连接/断开（只影响该实例） |
| POST | `/v1/admin/accounts/<account>/bridge` | `{ enabled }`：停用后账号可在线，但事件不再推给桥接 |
| GET | `/v1/admin/logs?after=&level=&scope=` | 结构化日志 |
| GET | `/v1/admin/bridge-link` | 桥接接入凭据：数据令牌 + 兼容入口地址（管理方据此改桥接配置，不读平台文件） |
| POST | `/v1/admin/shutdown` | 优雅退出 |

两种令牌分离：数据令牌不能调管理接口，管理令牌也不能当数据令牌用。
启动方可以经环境变量 `INTERFACE_PLATFORM_ADMIN_TOKEN`（≥32 字符）交来它自己保管的管理令牌，平台额外接受它。

## 8. OneBot v11 兼容入口（过渡层）

为了让 M1 的桥接**只改配置**就能经过平台：

- WebSocket：`ws://127.0.0.1:<port>/onebot/v11/ws`（`?access_token=` 或 `Authorization: Bearer`）
- HTTP：`http://127.0.0.1:<port>/onebot/v11/<action>`

行为：事件把上游原文**不重新编码**直接转发；动作改写 `echo` 后经上游连接发出，回执再改回原 `echo`，多个客户端互不串号。
这是兼容面，不是内部模型；M2 起桥接逐步改用 §7.1。

## 9. 不在 v1 范围

跨平台转发、身份合并、远端进程管理、媒体上传句柄（M4）、可恢复订阅的持久化游标（当前只有内存重放窗口）。
