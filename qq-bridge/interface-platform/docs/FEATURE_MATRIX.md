# SnowLuma 1.14.22 完整能力矩阵（M2 前冻结基线）

> 状态：冻结草案，2026-10-18。依据交接文档 §9「M2 前冻结固定版本 SnowLuma 的完整能力清单」。
> 基线源码：`jiaoliu/jiaoliu`（`package.json` 版本 1.14.22）。下文的「源码位置」都相对于该目录，只记文件与行号，不摘抄源码。
> M1 范围依据：本目录 [CONTRACT.md](CONTRACT.md) 与 `src/connectors/qq-snowluma/index.mjs` 的 `capabilities()`、`mapping.mjs`、`src/core/platform.mjs` 的 `callOneBot`。

## 0. 怎么读这张表

**归属**（目标形态，回答「这项能力最终由谁承担」）：

| 标签 | 含义 |
| --- | --- |
| 统一接口 | 跨平台通用语义（收发消息、历史、撤回、联系人、请求处理、媒体、已读、回应、输入状态等），应由接口平台 `/v1/*` 统一模型承担；SnowLuma 连接器只做映射 |
| 连接器 | QQ 特有的能力（群管理细项、群文件、群相册、QQ 空间、收藏表情、精华、群待办、闪传、Ark 卡片等），由 SnowLuma 连接器作为 `ext.qq.*` 平台扩展提供，带参数校验与能力声明 |
| 仅透传 | 只为 OneBot / NapCat 兼容而存在的名字或占位实现（未实现、mock、错拼兼容名、OneBot 专有的快速操作），不进统一模型，只保留在 OneBot 兼容入口 |
| 独立管理入口 | 进程控制、账号资料、凭据/密钥、原始协议包、本机缓存清理。**不应由数据令牌调用**，应放到受管理令牌保护、需要人工确认的入口 |

**M1 状态**（当前代码实际情况）：

| 标签 | 含义 |
| --- | --- |
| 已通过统一接口 | `/v1/*` 已有对应语义并由连接器实际调用 |
| 仅透传 | 只能经 `/onebot/v11/<动作>`、`/onebot/v11/ws` 或 `POST /v1/ext/qq/<动作>` 原样调用；参数和返回不做统一建模 |
| 未覆盖 | 经平台**调用不了或结果不完整** |

M1 透传面的两条硬限制（决定了「未覆盖」的判定，见 `src/core/platform.mjs` 的 `callOneBot` 与 `src/connectors/qq-snowluma/index.mjs` 的 `call`）：

1. **动作名校验** `^[a-z_][a-z0-9_.]{0,63}$`：以 `.` 开头的名字一律被拒（`.get_word_slices`、`.ocr_image`、`.send_packet`、`.handle_quick_operation`、`.handle_quick_operation_async`）。
2. **一请求一回执**：连接器按 echo 收到第一帧就结束请求。SnowLuma 的 Stream 下载动作会用同一个 echo 连发多帧（`packages/onebot/src/streaming.ts:58` 起；WS 侧 `packages/onebot/src/network/ws-server-connections.ts:225` 起），经平台只能拿到首帧，后续帧被丢弃。

## 1. 总量与核对方法

| 类别 | 数量 | 权威来源 |
| --- | --- | --- |
| 可执行动作（规范名） | 198 | `packages/onebot/src/actions/index.ts:250`（`ACTION_GROUPS`，12 个分类）；生成目录 `packages/mcp/src/generated/catalog.json` |
| 动作别名 | 6（分属 5 个动作） | 同上；`defineAction({ name: [...] })` 的数组形式 |
| 保留原始动作 | 2（`.handle_quick_operation`、`.handle_quick_operation_async`） | `packages/onebot/src/actions/index.ts:266`–`271` |
| 上报事件 | 消息 3 种上游类型 → 4 种 OneBot 形态；通知 21 种转换器；请求 2 种；元事件 2 种；另有 `bot_status` 通知 | `packages/onebot/src/event-converter/index.ts`（`CONVERTERS`）、`packages/onebot/src/instance.ts:645`–`700` |
| 消息元素（收发同名段） | 16 | `packages/protocol/src/element-manifest.ts:131`（`ELEMENT_MANIFEST`） |
| 仅发送的输入糖段 | 9 | `packages/protocol/src/element-manifest.ts:618`（`INPUT_SUGAR_SEGMENTS`）；`packages/onebot/src/message-parser.ts:268`–`423` |
| 网络适配器 | 4 种 | `packages/onebot/src/config.ts:46` 起（`httpServers` / `httpClients` / `wsServers` / `wsClients`） |
| WebUI 管理 API | 55 条路由 | `packages/core/src/webui/server.ts`、`storage-routes.ts` |
| MCP 工具 | 6 个 + 1 个资源 | `packages/mcp/src/tools.ts`、`packages/mcp/src/server.ts` |

核对方法：以 `catalog.json` 为清单，逐项在 `packages/onebot/src/actions/*.ts` 中找到 `name:` 定义行；反向把源码中全部 `name: '<字面量>'` 与目录比对，二者一致（198 个规范名 + 6 个别名，无遗漏、无多余）。`catalog.json` 由 CI 校验与源码同步（`tools/check-action-catalog.mjs`）。

**动作归属 × M1 状态汇总**

| 归属 \ M1 状态 | 已通过统一接口 | 仅透传 | 未覆盖 | 合计 |
| --- | --- | --- | --- | --- |
| 统一接口 | 3 | 37 | 3 | 43 |
| 连接器 | 0 | 128 | 0 | 128 |
| 仅透传 | 0 | 8 | 2 | 10 |
| 独立管理入口 | 0 | 17 | 0 | 17 |
| **合计** | **3** | **190** | **5** | **198** |

另：别名 `.ocr_image`、`.send_packet` 与 2 个保留原始动作也属「未覆盖」（见 §2.13）。「独立管理入口」的 17 项目前**全部能被数据令牌透传调用**，是 M2 要收紧的安全缺口（§9）。

## 2. OneBot 动作（198 个规范名）

各节按源码文件内的定义顺序排列。「桥接已在用」来自对 `qq-bridge-enhanced/src` 的静态扫描，动态拼接的动作名可能漏计。

### 2.1 信息（5 个，`packages/onebot/src/actions/info.ts`）

| 动作 | 说明 | 读/写 | 源码位置 | 归属 | M1 状态 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| `get_login_info` | 获取登录号信息（源码无摘要，按名称释义） | 读 | `info.ts:9` | 统一接口 | 已通过统一接口 | 连接器连上后自动调用，结果进入 `/v1/accounts`（账号 ID、昵称）；客户端直接调用仍走透传 |
| `get_status` | 获取运行状态（源码无摘要，按名称释义） | 读 | `info.ts:28` | 统一接口 | 仅透传 | 统一健康阶梯取自心跳 `status`，未调用本动作；客户端调用走透传 |
| `get_version_info` | 获取版本信息（源码无摘要，按名称释义） | 读 | `info.ts:48` | 统一接口 | 仅透传 |  |
| `can_send_image` | 能否发送图片（源码无摘要，按名称释义） | 读 | `info.ts:71` | 统一接口 | 仅透传 |  |
| `can_send_record` | 能否发送语音（源码无摘要，按名称释义） | 读 | `info.ts:86` | 统一接口 | 仅透传 |  |

### 2.2 消息（6 个，`packages/onebot/src/actions/message.ts`）

| 动作 | 说明 | 读/写 | 源码位置 | 归属 | M1 状态 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| `send_custom_face` | 发送账号收藏表情（emoji_id 或 MD5），保留表情显示样式 | 写 | `message.ts:52` | 连接器 | 仅透传 |  |
| `send_msg` | 发送消息（按 message_type/群号 自动路由群聊或私聊） | 写 | `message.ts:82` | 统一接口 | 仅透传 | 统一发送已按会话类型选 send_private_msg / send_group_msg，本动作本身只透传 |
| `send_private_msg` | 发送私聊消息 | 写 | `message.ts:109` | 统一接口 | 已通过统一接口 | 统一 `POST /v1/messages`（conversation.type=private）由它承接；带 `group_id` 的临时会话发送只能透传 |
| `send_group_msg` | 发送群消息 | 写 | `message.ts:130` | 统一接口 | 已通过统一接口 | 统一 `POST /v1/messages`（conversation.type=group）由它承接 |
| `get_msg` | 获取消息 | 读 | `message.ts:141` | 统一接口 | 仅透传 | 桥接已在用 |
| `delete_msg` | 撤回消息 | 写 | `message.ts:162` | 统一接口 | 仅透传 |  |

### 2.3 好友（3 个，`packages/onebot/src/actions/friend.ts`）

| 动作 | 说明 | 读/写 | 源码位置 | 归属 | M1 状态 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| `get_friend_list` | 获取好友列表 | 读 | `friend.ts:6` | 统一接口 | 仅透传 |  |
| `get_stranger_info` | 获取陌生人信息 | 读 | `friend.ts:32` | 统一接口 | 仅透传 |  |
| `delete_friend` | 删除好友 | 写 | `friend.ts:83` | 连接器 | 仅透传 |  |

### 2.4 群信息（6 个，`packages/onebot/src/actions/group-info.ts`）

| 动作 | 说明 | 读/写 | 源码位置 | 归属 | M1 状态 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| `get_group_list` | 获取群列表 | 读 | `group-info.ts:27` | 统一接口 | 仅透传 | 桥接已在用 |
| `get_group_info` | 获取群信息 | 读 | `group-info.ts:64` | 统一接口 | 仅透传 |  |
| `get_group_member_list` | 获取群成员列表 | 读 | `group-info.ts:94` | 统一接口 | 仅透传 | 桥接已在用 |
| `get_group_member_info` | 获取群成员信息 | 读 | `group-info.ts:141` | 统一接口 | 仅透传 |  |
| `get_group_honor_info` | 获取群荣誉信息 | 读 | `group-info.ts:200` | 连接器 | 仅透传 |  |
| `get_group_system_msg` | 获取群系统消息 | 读 | `group-info.ts:223` | 连接器 | 仅透传 |  |

### 2.5 群管理（21 个，`packages/onebot/src/actions/group-admin.ts`）

| 动作 | 说明 | 读/写 | 源码位置 | 归属 | M1 状态 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| `set_group_kick` | 踢出群成员 | 写 | `group-admin.ts:6` | 连接器 | 仅透传 |  |
| `set_group_kick_members` | 批量踢出群成员 | 写 | `group-admin.ts:16` | 连接器 | 仅透传 |  |
| `set_group_ban` | 禁言群成员（duration=0 解除） | 写 | `group-admin.ts:26` | 连接器 | 仅透传 |  |
| `set_group_whole_ban` | 全员禁言开关 | 写 | `group-admin.ts:36` | 连接器 | 仅透传 |  |
| `set_group_add_option` | 设置加群选项 | 写 | `group-admin.ts:46` | 连接器 | 仅透传 |  |
| `set_group_search` | 设置群被搜索方式（群指纹 / 群号搜索开关） | 写 | `group-admin.ts:62` | 连接器 | 仅透传 |  |
| `set_group_member_invite_policy` | 设置群成员邀请策略 | 写 | `group-admin.ts:75` | 连接器 | 仅透传 |  |
| `set_group_new_member_history_visibility` | 设置新成员是否可查看历史消息 | 写 | `group-admin.ts:92` | 连接器 | 仅透传 |  |
| `set_group_member_permissions` | 设置群成员权限（仅群主可改） | 写 | `group-admin.ts:102` | 连接器 | 仅透传 |  |
| `get_group_admin_settings` | 获取群管理设置的当前值 | 读 | `group-admin.ts:125` | 连接器 | 仅透传 |  |
| `get_group_tags` | 读取某个群分类下的资料标签 | 读 | `group-admin.ts:170` | 连接器 | 仅透传 |  |
| `add_group_tag` | 向某个群分类添加资料标签 | 写 | `group-admin.ts:198` | 连接器 | 仅透传 |  |
| `delete_group_tag` | 从某个群分类移除资料标签 | 写 | `group-admin.ts:211` | 连接器 | 仅透传 |  |
| `set_group_admin` | 设置/取消管理员 | 写 | `group-admin.ts:224` | 连接器 | 仅透传 |  |
| `set_group_card` | 设置群名片（空字符串清除） | 写 | `group-admin.ts:234` | 连接器 | 仅透传 |  |
| `set_group_name` | 设置群名 | 写 | `group-admin.ts:244` | 连接器 | 仅透传 |  |
| `set_group_leave` | 退群 | 写 | `group-admin.ts:254` | 连接器 | 仅透传 |  |
| `set_group_special_title` | 设置群头衔 | 写 | `group-admin.ts:263` | 连接器 | 仅透传 |  |
| `set_group_anonymous` | 匿名开关（未实现，返回 ok） | 写 | `group-admin.ts:273` | 仅透传 | 仅透传 | SnowLuma 未实现，直接返回 ok |
| `set_group_anonymous_ban` | 匿名禁言（未实现，返回 ok） | 写 | `group-admin.ts:274` | 仅透传 | 仅透传 | SnowLuma 未实现，直接返回 ok |
| `set_group_portrait` | 设置群头像 | 写 | `group-admin.ts:277` | 连接器 | 仅透传 |  |

### 2.6 群文件（12 个，`packages/onebot/src/actions/group-file.ts`）

| 动作 | 说明 | 读/写 | 源码位置 | 归属 | M1 状态 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| `upload_group_file` | 上传群文件 | 写 | `group-file.ts:21` | 统一接口 | 仅透传 | 统一接口的 `file` 段发送需经它（或 file 段直发）实现；M4 媒体句柄 |
| `upload_private_file` | 上传私聊文件 | 写 | `group-file.ts:42` | 统一接口 | 仅透传 | 同上 |
| `get_group_file_url` | 获取群文件下载链接 | 读 | `group-file.ts:81` | 统一接口 | 仅透传 |  |
| `get_group_root_files` | 获取群根目录文件列表 | 读 | `group-file.ts:99` | 连接器 | 仅透传 |  |
| `get_group_files_by_folder` | 获取群子目录文件列表 | 读 | `group-file.ts:154` | 连接器 | 仅透传 |  |
| `delete_group_file` | 删除群文件 | 写 | `group-file.ts:212` | 连接器 | 仅透传 |  |
| `move_group_file` | 移动群文件 | 写 | `group-file.ts:222` | 连接器 | 仅透传 |  |
| `rename_group_file` | 重命名群文件 | 写 | `group-file.ts:238` | 连接器 | 仅透传 |  |
| `create_group_file_folder` | 创建群文件夹 | 写 | `group-file.ts:254` | 连接器 | 仅透传 |  |
| `delete_group_file_folder` | 删除群文件夹 | 写 | `group-file.ts:270` | 连接器 | 仅透传 |  |
| `rename_group_file_folder` | 重命名群文件夹 | 写 | `group-file.ts:280` | 连接器 | 仅透传 |  |
| `get_private_file_url` | 获取私聊文件下载链接 | 读 | `group-file.ts:296` | 统一接口 | 仅透传 |  |

### 2.7 请求（2 个，`packages/onebot/src/actions/request.ts`）

| 动作 | 说明 | 读/写 | 源码位置 | 归属 | M1 状态 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| `set_friend_add_request` | 处理好友添加请求 | 写 | `request.ts:6` | 统一接口 | 仅透传 | 统一事件已有 `request.friend`，但没有统一的处理接口 |
| `set_group_add_request` | 处理加群请求 | 写 | `request.ts:19` | 统一接口 | 仅透传 | 统一事件已有 `request.group`，但没有统一的处理接口 |

### 2.8 扩展（115 个，`packages/onebot/src/actions/extended.ts`）

| 动作 | 说明 | 读/写 | 源码位置 | 归属 | M1 状态 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| `fetch_ptt_text`<br>别名 `get_ptt_text`、`get_record_text` | 获取语音转文字结果 | 读 | `extended.ts:862` | 统一接口 | 仅透传 | 别名 `get_ptt_text`、`get_record_text` 可透传 |
| `get_rkey`<br>别名 `nc_get_rkey` | 获取下载 rkey | 读 | `extended.ts:2337` | 独立管理入口 | 仅透传 | 别名 `nc_get_rkey` 可透传；rkey 是媒体下载凭据 |
| `ocr_image`<br>别名 `.ocr_image` | OCR 图片（服务端，需图片 URL 或已缓存的图片 file_id） | 读 | `extended.ts:2396` | 连接器 | 仅透传 | **别名 `.ocr_image` 被平台动作名校验拒绝**；主名可透传 |
| `send_packet`<br>别名 `.send_packet` | 发送原始 SSO 包（cmd + hex data） | 写 | `extended.ts:2697` | 独立管理入口 | 仅透传 | 原始 SSO 发包；**别名 `.send_packet` 被平台动作名校验拒绝** |
| `set_group_sign`<br>别名 `send_group_sign` | 群签到 | 写 | `extended.ts:2688` | 连接器 | 仅透传 | 别名 `send_group_sign` 可透传 |
| `send_like` | 点赞 | 写 | `extended.ts:420` | 连接器 | 仅透传 |  |
| `friend_poke` | 好友拍一拍 | 写 | `extended.ts:434` | 连接器 | 仅透传 |  |
| `group_poke` | 群拍一拍 | 写 | `extended.ts:447` | 连接器 | 仅透传 | 桥接已在用 |
| `send_poke` | 拍一拍（群聊/私聊自动路由） | 写 | `extended.ts:456` | 统一接口 | 仅透传 | 桥接已在用（拍一拍回应） |
| `set_essence_msg` | 设置精华消息 | 写 | `extended.ts:474` | 连接器 | 仅透传 |  |
| `delete_essence_msg` | 移除精华消息 | 写 | `extended.ts:484` | 连接器 | 仅透传 |  |
| `get_essence_msg_list` | 获取精华消息列表 | 读 | `extended.ts:494` | 连接器 | 仅透传 |  |
| `set_group_reaction` | 群聊表情回应 | 写 | `extended.ts:520` | 连接器 | 仅透传 |  |
| `delete_custom_face` | 删除收藏表情 | 写 | `extended.ts:549` | 连接器 | 仅透传 |  |
| `add_custom_face` | 添加收藏表情 | 写 | `extended.ts:560` | 连接器 | 仅透传 | 桥接已在用 |
| `modify_custom_face` | 修改收藏表情备注 | 写 | `extended.ts:571` | 连接器 | 仅透传 | 桥接已在用 |
| `move_custom_face_to_front` | 收藏表情移到最前 | 写 | `extended.ts:589` | 连接器 | 仅透传 |  |
| `get_group_msg_history` | 获取群消息历史 | 读 | `extended.ts:600` | 统一接口 | 仅透传 | 桥接已在用 |
| `get_friend_msg_history` | 获取好友消息历史（无锚点时从服务器获取最新双向记录） | 读 | `extended.ts:628` | 统一接口 | 仅透传 |  |
| `mark_group_msg_as_read` | 标记群消息已读 | 写 | `extended.ts:654` | 统一接口 | 仅透传 |  |
| `mark_private_msg_as_read` | 标记私聊消息已读 | 写 | `extended.ts:676` | 统一接口 | 仅透传 |  |
| `mark_msg_as_read` | 标记消息已读（群聊/私聊自动路由） | 写 | `extended.ts:698` | 统一接口 | 仅透传 |  |
| `_send_group_notice` | 发送群公告（支持置顶、弹窗、新成员、群昵称引导与确认） | 写 | `extended.ts:723` | 连接器 | 仅透传 |  |
| `_get_group_notice` | 获取群公告 | 读 | `extended.ts:759` | 连接器 | 仅透传 |  |
| `upload_forward_msg` | 上传转发消息 | 写 | `extended.ts:771` | 连接器 | 仅透传 |  |
| `upload_foward_msg` | 上传转发消息（别名拼写） | 写 | `extended.ts:795` | 仅透传 | 仅透传 | `upload_forward_msg` 的错拼兼容名（源码里是独立登记的名字） |
| `get_image` | 获取图片信息 | 读 | `extended.ts:813` | 统一接口 | 仅透传 |  |
| `get_record` | 获取语音信息；传 out_format 则服务端转码并附带 base64 | 读 | `extended.ts:830` | 统一接口 | 仅透传 |  |
| `get_cookies` | 获取 Cookies | 读 | `extended.ts:883` | 独立管理入口 | 仅透传 | 凭据外泄风险 |
| `get_csrf_token` | 获取 CSRF 令牌 | 读 | `extended.ts:902` | 独立管理入口 | 仅透传 | 凭据外泄风险 |
| `get_credentials` | 获取凭证 | 读 | `extended.ts:921` | 独立管理入口 | 仅透传 | 返回 cookies + csrf token |
| `set_restart` | 重启（不支持） | 写 | `extended.ts:943` | 独立管理入口 | 仅透传 | SnowLuma 侧返回「不支持」 |
| `clean_cache` | 清理缓存 | 写 | `extended.ts:952` | 独立管理入口 | 仅透传 |  |
| `set_friend_remark` | 设置好友备注 | 写 | `extended.ts:962` | 连接器 | 仅透传 |  |
| `set_group_remark` | 设置群备注 | 写 | `extended.ts:975` | 连接器 | 仅透传 |  |
| `set_msg_emoji_like` | 设置消息表情回应 | 写 | `extended.ts:988` | 统一接口 | 仅透传 |  |
| `_mark_all_as_read` | 标记全部已读 | 写 | `extended.ts:1002` | 连接器 | 仅透传 |  |
| `get_group_file_system_info` | 获取群文件系统信息 | 读 | `extended.ts:1013` | 连接器 | 仅透传 |  |
| `check_url_safely` | 检查链接安全性 | 读 | `extended.ts:1043` | 连接器 | 仅透传 |  |
| `set_qq_profile` | 设置 QQ 资料 | 写 | `extended.ts:1061` | 独立管理入口 | 仅透传 |  |
| `set_online_status` | 设置在线状态 | 写 | `extended.ts:1075` | 独立管理入口 | 仅透传 |  |
| `set_diy_online_status` | 设置自定义在线状态 | 写 | `extended.ts:1093` | 独立管理入口 | 仅透传 |  |
| `get_group_ignored_notifies` | 获取被过滤的入群请求 | 读 | `extended.ts:1108` | 连接器 | 仅透传 |  |
| `get_group_ignore_add_request` | 获取被忽略的入群请求（NapCat） | 读 | `extended.ts:1155` | 连接器 | 仅透传 |  |
| `get_group_shut_list` | 获取群禁言列表 | 读 | `extended.ts:1201` | 连接器 | 仅透传 |  |
| `get_group_signed_list` | 获取群今日打卡列表 | 读 | `extended.ts:1231` | 连接器 | 仅透传 |  |
| `forward_friend_single_msg` | 转发单条消息给好友 | 写 | `extended.ts:1241` | 连接器 | 仅透传 |  |
| `forward_group_single_msg` | 转发单条消息到群 | 写 | `extended.ts:1254` | 连接器 | 仅透传 |  |
| `get_profile_like` | 获取资料点赞 | 读 | `extended.ts:1267` | 连接器 | 仅透传 |  |
| `fetch_custom_face` | 获取自定义表情 | 读 | `extended.ts:1321` | 连接器 | 仅透传 |  |
| `fetch_custom_face_detail` | 获取自定义表情详情 | 读 | `extended.ts:1344` | 连接器 | 仅透传 | 桥接已在用 |
| `get_emoji_likes` | 获取表情回应用户 | 读 | `extended.ts:1378` | 连接器 | 仅透传 |  |
| `fetch_emoji_like` | 获取表情回应用户（NapCat 分页） | 读 | `extended.ts:1413` | 连接器 | 仅透传 |  |
| `get_msg_emoji_likes` | 获取一条消息的全部表情回应 | 读 | `extended.ts:1464` | 连接器 | 仅透传 |  |
| `get_friends_with_category` | 获取分组好友列表 | 读 | `extended.ts:1499` | 连接器 | 仅透传 |  |
| `set_friends_category` | 移动好友到指定分组 | 写 | `extended.ts:1546` | 连接器 | 仅透传 |  |
| `get_recent_contact` | 获取最近会话（占位） | 读 | `extended.ts:1571` | 仅透传 | 仅透传 | SnowLuma 占位实现 |
| `get_online_clients` | 获取在线客户端 | 读 | `extended.ts:1585` | 连接器 | 仅透传 |  |
| `_get_model_show` | 获取机型展示（兼容 mock） | 读 | `extended.ts:1647` | 仅透传 | 仅透传 | 兼容 mock |
| `_set_model_show` | 设置机型展示（占位） | 写 | `extended.ts:1678` | 仅透传 | 仅透传 | 占位 |
| `get_group_at_all_remain` | 获取群 @全体成员 剩余次数 | 读 | `extended.ts:1687` | 连接器 | 仅透传 |  |
| `get_unidirectional_friend_list` | 获取单向好友列表 | 读 | `extended.ts:1707` | 连接器 | 仅透传 |  |
| `get_clientkey` | 获取 clientkey | 读 | `extended.ts:1718` | 独立管理入口 | 仅透传 | 凭据外泄风险 |
| `share_peer` | 分享用户/群 Ark 卡片 | 读 | `extended.ts:1750` | 连接器 | 仅透传 |  |
| `send_ark_share` | 分享用户/群 Ark 卡片（NapCat 标准名） | 读 | `extended.ts:1777` | 连接器 | 仅透传 |  |
| `send_tuwen_ark` | 发送图文 Ark 卡片（私聊/群聊） | 写 | `extended.ts:1810` | 连接器 | 仅透传 |  |
| `share_group_ex` | 分享群 Ark 卡片 | 读 | `extended.ts:1858` | 连接器 | 仅透传 |  |
| `send_group_ark_share` | 分享群 Ark 卡片（NapCat 标准名） | 读 | `extended.ts:1869` | 连接器 | 仅透传 |  |
| `get_doubt_friends_add_request` | 获取可疑好友申请 | 读 | `extended.ts:1883` | 连接器 | 仅透传 |  |
| `set_doubt_friends_add_request` | 处理可疑好友申请 | 写 | `extended.ts:1913` | 连接器 | 仅透传 |  |
| `set_group_robot_add_option` | 设置群机器人加群选项 | 写 | `extended.ts:1932` | 连接器 | 仅透传 |  |
| `get_collection_list` | 获取收藏列表 | 读 | `extended.ts:1947` | 连接器 | 仅透传 |  |
| `create_collection` | 创建收藏（未实现） | 写 | `extended.ts:2048` | 仅透传 | 仅透传 | SnowLuma 未实现 |
| `.get_word_slices` | 分词（未实现） | 读 | `extended.ts:2057` | 仅透传 | 未覆盖 | **名字以 `.` 开头，被平台动作名校验拒绝**；SnowLuma 侧也未实现 |
| `set_qq_avatar` | 设置 QQ 头像 | 写 | `extended.ts:2067` | 独立管理入口 | 仅透传 |  |
| `set_input_status` | 设置输入状态 | 写 | `extended.ts:2077` | 统一接口 | 仅透传 |  |
| `get_group_info_ex` | 获取群信息（扩展） | 读 | `extended.ts:2091` | 连接器 | 仅透传 |  |
| `get_group_detail_info` | 获取群详细信息 | 读 | `extended.ts:2108` | 连接器 | 仅透传 |  |
| `trans_group_file` | 转存群文件 | 写 | `extended.ts:2125` | 连接器 | 仅透传 |  |
| `get_file` | 获取文件信息（仅图片/语音缓存；群文件请用 get_group_file_url） | 读 | `extended.ts:2149` | 统一接口 | 仅透传 |  |
| `bot_exit` | 退出机器人 | 写 | `extended.ts:2173` | 独立管理入口 | 仅透传 | 退出 SnowLuma 机器人进程——属于进程管理，不应由数据令牌触发 |
| `nc_get_packet_status` | 获取 packet 状态（占位） | 读 | `extended.ts:2183` | 仅透传 | 仅透传 | NapCat 兼容占位 |
| `delete_group_folder` | 删除群文件夹 | 写 | `extended.ts:2198` | 连接器 | 仅透传 |  |
| `nc_get_user_status` | 获取用户在线/扩展状态 | 读 | `extended.ts:2209` | 连接器 | 仅透传 |  |
| `get_ai_characters` | 获取 AI 语音角色 | 读 | `extended.ts:2231` | 连接器 | 仅透传 |  |
| `get_ai_record` | 生成 AI 语音 | 写 | `extended.ts:2273` | 连接器 | 仅透传 |  |
| `send_group_ai_record` | 发送 AI 语音到群 | 写 | `extended.ts:2288` | 连接器 | 仅透传 |  |
| `request_decrypt_key` | 请求数据库解密密钥 | 写 | `extended.ts:2310` | 独立管理入口 | 仅透传 | 返回 QQ 本地数据库解密密钥 |
| `get_rkey_server` | 获取 rkey 服务器信息 | 读 | `extended.ts:2350` | 独立管理入口 | 仅透传 |  |
| `_del_group_notice` | 删除群公告（fid 或 notice_id 二选一） | 写 | `extended.ts:2457` | 连接器 | 仅透传 |  |
| `send_forward_msg` | 发送合并转发（按 message_type/群号自动路由） | 写 | `extended.ts:2469` | 统一接口 | 仅透传 |  |
| `send_group_forward_msg` | 发送群合并转发 | 写 | `extended.ts:2505` | 统一接口 | 仅透传 |  |
| `send_private_forward_msg` | 发送私聊合并转发 | 写 | `extended.ts:2522` | 统一接口 | 仅透传 |  |
| `get_forward_msg` | 获取合并转发消息（id 或 message_id） | 读 | `extended.ts:2540` | 统一接口 | 仅透传 | 桥接已在用 |
| `download_file` | 下载文件（url 或 base64）到 data/downloads | 写 | `extended.ts:2579` | 统一接口 | 仅透传 |  |
| `translate_en2zh` | 英译中 | 读 | `extended.ts:2612` | 连接器 | 仅透传 |  |
| `set_self_longnick` | 设置个性签名（longNick/long_nick，严格 string） | 写 | `extended.ts:2631` | 独立管理入口 | 仅透传 |  |
| `get_mini_app_ark` | 获取小程序卡片 ark | 读 | `extended.ts:2643` | 连接器 | 仅透传 |  |
| `click_inline_keyboard_button` | 点击内联键盘按钮 | 写 | `extended.ts:2667` | 连接器 | 仅透传 |  |
| `get_group_todo_list` | 获取群待办列表 | 读 | `extended.ts:2714` | 连接器 | 仅透传 |  |
| `set_group_todo` | 设置群待办 | 写 | `extended.ts:2760` | 连接器 | 仅透传 |  |
| `complete_group_todo` | 完成群待办 | 写 | `extended.ts:2767` | 连接器 | 仅透传 |  |
| `cancel_group_todo` | 取消群待办 | 写 | `extended.ts:2774` | 连接器 | 仅透传 |  |
| `create_flash_task` | 创建闪传任务 | 写 | `extended.ts:2783` | 连接器 | 仅透传 |  |
| `get_fileset_info` | 获取文件集信息 | 写 | `extended.ts:2800` | 连接器 | 仅透传 |  |
| `get_flash_file_list` | 获取闪传文件列表 | 写 | `extended.ts:2810` | 连接器 | 仅透传 |  |
| `list_filesets` | 列出当前账号的所有闪传文件集 | 写 | `extended.ts:2820` | 连接器 | 仅透传 |  |
| `get_flash_file_url` | 获取闪传文件链接 | 写 | `extended.ts:2830` | 连接器 | 仅透传 |  |
| `get_share_link` | 获取文件分享链接 | 写 | `extended.ts:2844` | 连接器 | 仅透传 |  |
| `delete_flash_file` | 删除闪传文件 | 写 | `extended.ts:2854` | 连接器 | 仅透传 |  |
| `rename_flash_file` | 重命名闪传文件 | 写 | `extended.ts:2864` | 连接器 | 仅透传 |  |
| `download_fileset` | 解析闪传文件下载直链（不下载，由调用方实现下载） | 写 | `extended.ts:2877` | 连接器 | 仅透传 |  |
| `send_flash_msg` | 发送闪传消息（私聊或群聊，引用 fileset_id 让对端下载） | 写 | `extended.ts:2899` | 连接器 | 仅透传 |  |
| `get_fileset_id` | 从 QQ 闪传分享码或官方分享链接获取 fileset_id | 读 | `extended.ts:2921` | 连接器 | 仅透传 |  |
| `_get_friend_dress` | 获取指定 QQ 号正在使用的个性装扮（挂件/名片/来电/输入状态等） | 读 | `extended.ts:2944` | 连接器 | 仅透传 |  |

### 2.9 群相册（9 个，`packages/onebot/src/actions/group-album.ts`）

| 动作 | 说明 | 读/写 | 源码位置 | 归属 | M1 状态 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| `get_group_album_list` | 获取群相册列表（源码无摘要，按名称释义） | 读 | `group-album.ts:51` | 连接器 | 仅透传 |  |
| `get_qun_album_list` | 获取群相册列表（旧名）（源码无摘要，按名称释义） | 读 | `group-album.ts:89` | 连接器 | 仅透传 |  |
| `upload_image_to_qun_album` | 上传图片到群相册（源码无摘要，按名称释义） | 写 | `group-album.ts:146` | 连接器 | 仅透传 |  |
| `upload_video_to_qun_album` | 上传视频到群相册 | 写 | `group-album.ts:159` | 连接器 | 仅透传 |  |
| `get_group_album_media_list` | 获取群相册媒体列表（源码无摘要，按名称释义） | 读 | `group-album.ts:181` | 连接器 | 仅透传 |  |
| `do_group_album_comment` | 评论群相册媒体（源码无摘要，按名称释义） | 写 | `group-album.ts:207` | 连接器 | 仅透传 |  |
| `set_group_album_media_like` | 点赞群相册媒体（源码无摘要，按名称释义） | 写 | `group-album.ts:220` | 连接器 | 仅透传 |  |
| `cancel_group_album_media_like` | 取消群相册媒体点赞（源码无摘要，按名称释义） | 写 | `group-album.ts:234` | 连接器 | 仅透传 |  |
| `del_group_album_media` | 删除群相册图片或视频 | 写 | `group-album.ts:247` | 连接器 | 仅透传 |  |

### 2.10 空间（9 个，`packages/onebot/src/actions/qzone.ts`）

| 动作 | 说明 | 读/写 | 源码位置 | 归属 | M1 状态 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| `get_qzone_msg_list` | 获取 QQ 空间说说列表（默认机器人自己的空间） | 读 | `qzone.ts:31` | 连接器 | 仅透传 |  |
| `get_qzone_feeds` | 获取 QQ 空间好友动态（feed）；page_num 仅首页可靠，深翻页需时间游标（暂未实现） | 读 | `qzone.ts:72` | 连接器 | 仅透传 |  |
| `send_qzone_msg` | 发表说说（QQ 空间，支持纯文字或带图；传 images 自动上传；可设置查看权限） | 写 | `qzone.ts:114` | 连接器 | 仅透传 |  |
| `delete_qzone_msg` | 删除一条说说（QQ 空间，按 tid） | 写 | `qzone.ts:139` | 连接器 | 仅透传 |  |
| `set_qzone_msg_right` | 修改一条已发说说的查看权限（QQ 空间，按 tid） | 写 | `qzone.ts:153` | 连接器 | 仅透传 |  |
| `like_qzone` | 给一条说说点赞（QQ 空间） | 写 | `qzone.ts:182` | 连接器 | 仅透传 |  |
| `unlike_qzone` | 取消对一条说说的点赞（QQ 空间；取消赞端点待真机核实） | 写 | `qzone.ts:198` | 连接器 | 仅透传 |  |
| `comment_qzone` | 评论一条说说（QQ 空间，支持纯文字或带图；传 images 自动上传） | 写 | `qzone.ts:215` | 连接器 | 仅透传 |  |
| `set_qzone_ban` | 拉黑或解除拉黑某人（修改机器人自身 QQ 空间黑名单；enable=true 拉黑，false 解除） | 写 | `qzone.ts:237` | 连接器 | 仅透传 |  |

### 2.11 系统表情（4 个，`packages/onebot/src/actions/system-face.ts`）

| 动作 | 说明 | 读/写 | 源码位置 | 归属 | M1 状态 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| `fetch_sys_faces` | 获取 QQ 系统表情目录 | 读 | `system-face.ts:52` | 连接器 | 仅透传 |  |
| `fetch_face_entity` | 按编号查询 QQ 系统表情 | 读 | `system-face.ts:86` | 连接器 | 仅透传 |  |
| `search_sys_faces` | 搜索 QQ 系统表情 | 读 | `system-face.ts:102` | 连接器 | 仅透传 |  |
| `fetch_super_face_id` | 判断 QQ 系统表情是否使用超级表情格式 | 读 | `system-face.ts:120` | 连接器 | 仅透传 |  |

### 2.12 流式接口（6 个，`packages/onebot/src/actions/stream-file.ts / stream-download.ts`）

| 动作 | 说明 | 读/写 | 源码位置 | 归属 | M1 状态 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| `download_file_stream` | 以流式方式下载文件(stream 目录本地文件 / URL / 缓存媒体) | 写 | `stream-download.ts:360` | 统一接口 | 未覆盖 | Stream 动作：上游一次请求回多帧（同一 echo），M1 连接器收到首帧即结束，**后续帧丢失** |
| `download_file_image_stream` | 以流式方式下载图片(缓存图片 id / URL / stream 目录本地文件) | 写 | `stream-download.ts:368` | 统一接口 | 未覆盖 | Stream 动作：上游一次请求回多帧（同一 echo），M1 连接器收到首帧即结束，**后续帧丢失** |
| `download_file_record_stream` | 以流式方式下载语音(缓存语音 id / URL / stream 目录本地文件) | 写 | `stream-download.ts:376` | 统一接口 | 未覆盖 | Stream 动作：上游一次请求回多帧（同一 echo），M1 连接器收到首帧即结束，**后续帧丢失** |
| `test_download_stream` | 测试下载流(推送 10 个数据帧,验证流式传输,不触达 QQ) | 写 | `stream-download.ts:384` | 仅透传 | 未覆盖 | Stream 动作：上游一次请求回多帧（同一 echo），M1 连接器收到首帧即结束，**后续帧丢失** |
| `upload_file_stream` | 以流式分块方式上传文件到机器人本地(返回可用于发送的本地路径) | 写 | `stream-file.ts:348` | 统一接口 | 仅透传 | Stream 类动作，但每个分块请求只回一个终帧，透传可用；返回的是 SnowLuma 本机路径 |
| `clean_stream_temp_file` | 清理流式传输临时文件(仅清理 stream 上传/下载目录) | 写 | `stream-file.ts:373` | 独立管理入口 | 仅透传 | 清理 SnowLuma 本机流式临时目录 |

### 2.13 别名与保留原始动作

| 名字 | 指向 | 源码位置 | 归属 | M1 状态 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `get_ptt_text`、`get_record_text` | `fetch_ptt_text` | `packages/onebot/src/actions/extended.ts:862` | 同主名 | 仅透传 | |
| `nc_get_rkey` | `get_rkey` | `packages/onebot/src/actions/extended.ts:2337` | 同主名 | 仅透传 | |
| `send_group_sign` | `set_group_sign` | `packages/onebot/src/actions/extended.ts:2688` | 同主名 | 仅透传 | |
| `.ocr_image` | `ocr_image` | `packages/onebot/src/actions/extended.ts:2396` | 仅透传 | 未覆盖 | 以 `.` 开头被拒 |
| `.send_packet` | `send_packet` | `packages/onebot/src/actions/extended.ts:2697` | 独立管理入口 | 未覆盖 | 以 `.` 开头被拒（这是好事，但应是有意为之而非副作用） |
| `.handle_quick_operation` | 快速操作（OneBot v11 隐藏动作） | `packages/onebot/src/actions/index.ts:266`；实现 `packages/onebot/src/network/quick-operation.ts:4` | 仅透传 | 未覆盖 | 以 `.` 开头被拒；对事件做「快速回复/撤回/踢人/禁言/同意请求」 |
| `.handle_quick_operation_async` | 同上（NoneBot 1 别名） | `packages/onebot/src/actions/index.ts:267` | 仅透传 | 未覆盖 | 同上 |

## 3. 事件

M1 对所有事件的处理是一致的：**兼容入口把上游原文逐字转发**（不重新编码），同时 `mapping.mjs` 的 `toUnifiedEvent` 生成统一事件进 `/v1/events`。通知、请求类事件在统一侧只有通用外壳 `notice.<notice_type>` / `request.<request_type>`，细节字段全部在 `ext.qq` 里，没有逐类型建模。下表「M1 状态」据此填写。

### 3.1 消息事件

| OneBot 形态 | 上游类型 | 源码位置 | 归属 | M1 状态 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `message` / `private` / `friend` | `friend_message` | `packages/onebot/src/event-converter/to-message.ts:78` | 统一接口 | 已通过统一接口 | → `message.private` |
| `message` / `private` / `group`（群临时会话，带 `sender.group_id`） | `temp_message` | `packages/onebot/src/event-converter/to-message.ts:82` | 统一接口 | 已通过统一接口 | → `message.temp`；但统一侧**不能回发**（`message.send.temp` 未声明） |
| `message` / `group` / `normal` | `group_message` | `packages/onebot/src/event-converter/to-message.ts:86` | 统一接口 | 已通过统一接口 | `anonymous` 恒为 null |
| `message_sent`（自己发出的消息，私聊/群） | 同上三种中发送者为自己 | `packages/onebot/src/event-converter/to-message.ts:86`–`89`；开关 `reportSelfMessage`（`packages/onebot/src/config.ts:55`） | 统一接口 | 已通过统一接口（有缺陷） | 统一 `type` 与他人消息相同，只能从 `ext.qq.post_type` 区分；私聊自发消息的 `target_id` 没有映射到 `conversation` |

### 3.2 通知事件（`CONVERTERS`：`packages/onebot/src/event-converter/index.ts:78`）

| notice_type / sub_type | 上游类型 | 源码位置 | 归属 | M1 状态 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `group_increase` / `approve`·`invite` | `group_member_join` | `packages/onebot/src/event-converter/to-notice.ts:27` | 统一接口 | 已通过统一接口（通用外壳） | 成员加入 |
| `group_decrease` / `leave`·`kick`·`kick_me`·`disband` | `group_member_leave` | `to-notice.ts:40` | 统一接口 | 已通过统一接口（通用外壳） | |
| `group_ban` / `ban`·`lift_ban` | `group_mute` | `to-notice.ts:61` | 连接器 | 已通过统一接口（通用外壳） | 全员禁言时 user_id 为 0 |
| `group_admin` / `set`·`unset` | `group_admin` | `to-notice.ts:72` | 连接器 | 已通过统一接口（通用外壳） | |
| `friend_recall` | `friend_recall` | `to-notice.ts:81` | 统一接口 | 已通过统一接口（通用外壳） | 应建模为统一「消息撤回」 |
| `group_recall` | `group_recall` | `to-notice.ts:97` | 统一接口 | 已通过统一接口（通用外壳） | 同上 |
| `notify` / `poke`（私聊） | `friend_poke` | `to-notice.ts:110` | 连接器 | 已通过统一接口（通用外壳） | 桥接在用；`conversation` 取 user_id |
| `notify` / `poke`（群） | `group_poke` | `to-notice.ts:123` | 连接器 | 已通过统一接口（通用外壳） | 桥接在用 |
| `essence` / `add`·`delete` | `group_essence` | `to-notice.ts:136` | 连接器 | 已通过统一接口（通用外壳） | |
| `group_upload` | `group_file_upload` | `to-notice.ts:153` | 统一接口 | 已通过统一接口（通用外壳） | 文件到达；应与 `file` 段统一 |
| `friend_add` | `friend_add` | `to-notice.ts:167` | 统一接口 | 已通过统一接口（通用外壳） | 联系人变化 |
| `group_card` | `group_card_change` | `to-notice.ts:174` | 连接器 | 已通过统一接口（通用外壳） | 桥接在用（群档案） |
| `bot_offline` | `bot_offline` | `to-notice.ts:186` | 统一接口 | 已通过统一接口（通用外壳） | **没有接入健康阶梯**，只有 `bot_status` 会改 `online` |
| `notify` / `profile_like` | `friend_profile_like` | `to-notice.ts:197` | 连接器 | 已通过统一接口（通用外壳） | |
| `notify` / `title` | `group_title_change` | `to-notice.ts:209` | 连接器 | 已通过统一接口（通用外壳） | 群头衔变化 |
| `notify` / `group_name` | `group_name_change` | `to-notice.ts:221` | 连接器 | 已通过统一接口（通用外壳） | |
| `notify` / `input_status` | `friend_input_status` | `to-notice.ts:233` | 统一接口 | 已通过统一接口（通用外壳） | 应建模为统一「正在输入」 |
| `group_msg_emoji_like` / `add`·`remove` | `group_msg_emoji_like` | `to-notice.ts:245` | 统一接口 | 已通过统一接口（通用外壳） | 应建模为统一「消息回应」 |
| `bot_status` / `online`·`offline` | 账号会话上下线（非 CONVERTERS，实例直接派发） | `packages/onebot/src/instance.ts:688`（构造）、`:212`（派发） | 统一接口 | 已通过统一接口 | → `account.status`，并驱动健康阶梯 `online` |
| （内部，不上报）`ptt_trans_result` | 语音转写异步结果 | `event-converter/index.ts:103` | — | 不适用 | 只用于配对 `fetch_ptt_text`，SnowLuma 本身不发给客户端 |
| （内部，不上报）`online_devices_changed` | 在线设备缓存 | `event-converter/index.ts:105` | — | 不适用 | 供 `get_online_clients` |
| （内部，不上报）`friend_remark_changed` | 其他终端改备注同步 | `event-converter/index.ts:107` | — | 不适用 | |

> `notify` 有 5 个 sub_type 共用一个 notice_type。M1 统一类型只到 `notice.notify`，订阅方必须看 `ext.qq.sub_type` 才能区分拍一拍、点赞、头衔、群名、输入状态。

### 3.3 请求事件

| request_type / sub_type | 上游类型 | 源码位置 | 归属 | M1 状态 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `friend` | `friend_request` | `packages/onebot/src/event-converter/to-request.ts:9` | 统一接口 | 已通过统一接口（通用外壳） | 处理动作 `set_friend_add_request` 仅透传 |
| `group` / `add`·`invite`（可带 `invited_id`） | `group_invite`（推送）+ 系统通知轮询补发 | `to-request.ts:18`；轮询 `packages/onebot/src/group-request-poller.ts:149` | 统一接口 | 已通过统一接口（通用外壳） | 处理动作 `set_group_add_request` 仅透传 |

### 3.4 元事件

| meta_event_type / sub_type | 源码位置 | 归属 | M1 状态 | 备注 |
| --- | --- | --- | --- | --- |
| `heartbeat`（每 30 秒，带 `status.online/good`、`interval`） | `packages/onebot/src/instance.ts:91`、`:667` | 统一接口 | 已通过统一接口 | → `meta.heartbeat`；`status.good` 驱动 `io.ready` |
| `lifecycle` / `connect`·`enable`·`disable` | `packages/onebot/src/instance.ts:645`；发送时机 `packages/onebot/src/network/adapter.ts:124`、`ws-server-connections.ts:197` | 统一接口 | 已通过统一接口（有缺陷） | → `meta.lifecycle`；平台自己连上游时会收到，但**平台给兼容客户端的连接不会再合成 lifecycle**，客户端看到的是上游那次 |

## 4. 消息段

依据 `packages/protocol/src/element-manifest.ts:131` 的四向表（D 协议解码 / S 转 OneBot 上报 / P OneBot 解析发送 / W 打包上线）与 `packages/onebot/src/event-converter/element-codecs.ts` 的编解码表。M1 收侧映射在 `mapping.mjs` 的 `fromOneBotSegments`，发侧在 `toOneBotSegments`。

### 4.1 收发同名的规范元素（16 种）

| 段 | SnowLuma 收 / 发 | 源码位置（codec） | 统一段 | 归属 | M1 状态 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| `text` | 收 ✔ / 发 ✔ | `element-codecs.ts:141` | `text` | 统一接口 | 已通过统一接口 | |
| `at` | 收 ✔ / 发 ✔ | `element-codecs.ts:187` | `mention` | 统一接口 | 已通过统一接口 | `qq=all` → `target:"all"`；`name` 字段在统一侧丢失 |
| `reply` | 收 ✔ / 发 ✔ | `element-codecs.ts:214` | `reply` | 统一接口 | 已通过统一接口 | |
| `image` | 收 ✔ / 发 ✔ | `element-codecs.ts:288` | `image` | 统一接口 | 已通过统一接口 | 发送限 `base64://`、`http(s)://`；`sub_type`（表情包标记）、文件大小等在统一侧丢失 |
| `record` | 收 ✔ / 发 ✔ | `element-codecs.ts:331` | `voice` | 统一接口 | 已通过统一接口 | 同上 |
| `video` | 收 ✔ / 发 ✔ | `element-codecs.ts:354` | `video` | 统一接口 | 已通过统一接口 | 同上 |
| `file` | 收 ✔ / 发 ✔（发送时由 OneBot 层拆出走上传管线） | `element-codecs.ts:421`；清单说明 `element-manifest.ts:191` | `file` | 统一接口 | 收：已通过统一接口；**发：未覆盖** | `capabilities()` 写「发文件走 upload_*_file」，但 1.14.22 已支持 `file` 段直发，说法需更正 |
| `face` | 收 ✔ / 发 ✔ | `element-codecs.ts:151` | `ext(qq/face)` | 连接器 | 收：已通过统一接口（ext）；发：经 ext 段可发（未声明） | |
| `mface`（商城表情） | 收 ✔（上报成带 `emoji_id` 的 `image` 段）/ 发 ✔ | `element-codecs.ts:469`；三角映射说明 `element-manifest.ts:185` | `image` | 连接器 | 收：已通过统一接口（**丢失 emoji_id/key，无法原样回发**）；发：经 ext 段可发（未声明） | |
| `json`（Ark 卡片） | 收 ✔ / 发 ✔ | `element-codecs.ts:378` | `ext(qq/json)` | 连接器 | 同 `face` | |
| `xml` | 收 ✔ / 发 ✔ | `element-codecs.ts:402` | `ext(qq/xml)` | 连接器 | 同 `face` | |
| `forward`（合并转发引用） | 收 ✔ / 发 ✔ | `element-codecs.ts:542` | `ext(qq/forward)` | 统一接口 | 同 `face` | 展开需 `get_forward_msg`（仅透传） |
| `poke`（窗口抖动） | 收 ✔ / 发 ✔（仅普通好友私聊） | `element-codecs.ts:507`；`element-manifest.ts:197` | `ext(qq/poke)` | 连接器 | 同 `face` | 与 `send_poke` 动作（拍一拍）不是一回事 |
| `markdown` | 收 ✔ / 发 ✔ | `element-codecs.ts:557` | `ext(qq/markdown)` | 连接器 | 同 `face` | |
| `inline_keyboard`（机器人按钮） | 收 ✔ / 发 ✘ | `element-codecs.ts:572`；`element-manifest.ts:208` | `ext(qq/inline_keyboard)` | 连接器 | 收：已通过统一接口（ext） | 点击用 `click_inline_keyboard_button` |
| `flash_file`（闪传） | 收 ✔ / 发 ✘（按设计，改用 `send_flash_msg`） | `element-codecs.ts:528`；`element-manifest.ts:214` | `ext(qq/flash_file)` | 连接器 | 收：已通过统一接口（ext） | |

### 4.2 仅发送的输入糖段（9 种，`packages/onebot/src/message-parser.ts`）

| 段 | 行为 | 源码位置 | 归属 | M1 状态 |
| --- | --- | --- | --- | --- |
| `node` | 只能整条消息都是 node，作为合并转发节点 | `message-parser.ts:268` | 统一接口（随合并转发） | 发：经 ext 段可发（未声明） |
| `share` | 链接分享 → `json` | `message-parser.ts:277` | 连接器 | 同上 |
| `music` | 音乐分享 → `json`（需 `musicSignUrl`） | `message-parser.ts:291` | 连接器 | 同上 |
| `location` | 位置 → `json` | `message-parser.ts:361` | 连接器 | 同上 |
| `contact` | 推荐好友/群 → `json` | `message-parser.ts:375` | 连接器 | 同上 |
| `rps` | 猜拳 → `face` 359 | `message-parser.ts:410` | 连接器 | 同上 |
| `dice` | 骰子 → `face` 358 | `message-parser.ts:414` | 连接器 | 同上 |
| `shake` | 窗口抖动 → `poke` | `message-parser.ts:418` | 仅透传 | 同上 |
| `anonymous` | 明确拒绝（无发送语义） | `message-parser.ts:423` | 仅透传 | 不适用 |

> **发送侧 ext 段是一个未声明的旁路**：`toOneBotSegments` 对 `{type:'ext', platform:'qq', kind, data}` 原样拼成 OneBot 段，既绕过 `capabilities()`，也绕过 `mediaSource()` 的来源限制——`{kind:'image', data:{file:'<本地路径>'}}` 或 `{kind:'file', ...}` 都会直接交给 SnowLuma。M2 必须二选一：把 ext 段纳入能力声明并对媒体类 kind 复用同一来源校验，或在统一发送里拒绝媒体类 ext 段。

### 4.3 消息格式

SnowLuma 每个网络适配器可选 `messageFormat: array | string`（`packages/onebot/src/config.ts:54`）。M1 兼容入口逐字转发，两种都能用；但统一映射 `fromOneBotSegments` 遇到字符串格式只当成一整段 `text`，**不解析 CQ 码**，在统一侧会把 `[CQ:at,qq=…]` 当正文。平台接入的上游端点应要求 `array`，或在连接器里补 CQ 解析。

## 5. 网络接入方式（SnowLuma 对外的 OneBot 通道）

| 适配器 | 说明 | 源码位置 | 归属 | M1 状态 |
| --- | --- | --- | --- | --- |
| `wsServers`（正向 WS，角色 `Universal` / `Api` / `Event`） | 默认 `127.0.0.1:3001`，带 `accessToken` | `packages/onebot/src/network/ws-server-adapter.ts`、`ws-server-connections.ts` | 连接器（上游链路） | 已通过统一接口：连接器只用它连上游；兼容入口对客户端只提供 Universal 等价物，不区分 Api/Event 角色 |
| `httpServers`（HTTP 动作，可选 `enableWebSocket`） | 默认 `127.0.0.1:3000`；Stream 动作在 HTTP 下用分块响应 | `packages/onebot/src/network/http-server-adapter.ts:395` | 仅透传 | 平台兼容入口提供 `/onebot/v11/<动作>`（一请求一 JSON，不支持分块 Stream） |
| `httpClients`（HTTP POST 上报 + 快速操作响应） | 事件 POST 到客户端，客户端在响应体里返回快速操作 | `packages/onebot/src/network/http-post-adapter.ts`、`quick-operation.ts:4` | 仅透传 | 未覆盖：平台不向客户端做 HTTP POST 上报 |
| `wsClients`（反向 WS） | SnowLuma 主动连客户端 | `packages/onebot/src/network/ws-client-adapter.ts` | 仅透传 | 未覆盖：平台不主动连客户端 |
| 每适配器 `reportSelfMessage` | 是否上报 `message_sent` | `packages/onebot/src/config.ts:55` | 连接器 | 取决于上游配置，平台无法按客户端区分 |
| 每适配器 `accessToken` | HTTP 与 WS 各自独立令牌 | `packages/onebot/src/config.ts:53`、`:64` | 连接器 | 已覆盖：连接器从 `config/onebot_<QQ>.json` 发现 WS 令牌；平台对客户端统一为一个数据令牌 |

## 6. 对外 SDK 与 MCP

### 6.1 `@snowluma/sdk`（`packages/sdk/src/index.ts`）

| 能力 | 源码位置 | 归属 | M1 状态 | 备注 |
| --- | --- | --- | --- | --- |
| `SnowLumaWebSocketClient` / `createWebSocketClient`（重连、echo、事件） | `packages/sdk/src/client/websocket-client.ts` | 仅透传 | 已兼容：桥接用它连 `/onebot/v11/ws`，离线测试覆盖 | 平台的 SDK 应是 `/v1` 客户端；这是兼容面 |
| `SnowLumaHttpClient` / `createHttpClient` | `packages/sdk/src/client/http-client.ts` | 仅透传 | 已兼容（指向 `/onebot/v11/`） | |
| `SnowLumaApiClient`（类型化动作封装） | `packages/sdk/src/client/api-client.ts` | 仅透传 | 已兼容 | 其中以 `.` 开头的动作经平台失败 |
| 事件守卫 / 上下文 / 命令匹配 / 中间件（`isMessageEvent`、`matchCommand` 等） | `packages/sdk/src/events/` | 仅透传 | 已兼容（事件原文不变） | |
| 消息构造（`text`、`at`、`image`、`forward`、`node`、`music` 等）与 CQ 码互转 | `packages/sdk/src/messages/` | 仅透传 | 已兼容 | 统一段构造器 M2 起由平台 SDK 提供 |
| 错误类型（`SnowLumaApiError`、`SnowLumaTimeoutError` 等） | `packages/sdk/src/errors.ts` | 仅透传 | 已兼容 | 平台超时/断开会以 OneBot 失败回执返回，SDK 看到的是 API 错误而不是传输错误 |

### 6.2 `@snowluma/mcp`（`packages/mcp/src/server.ts`、`tools.ts`）

| 工具 / 资源 | 说明 | 源码位置 | 归属 | M1 状态 |
| --- | --- | --- | --- | --- |
| `list_actions`、`get_action`、`search_actions`、`list_categories` | 动作目录检索（离线，读 catalog） | `packages/mcp/src/tools.ts:38`–`70` | 连接器（能力目录） | 未覆盖：平台没有自己的能力目录 API，只有 `/v1/capabilities` 的 13 项 |
| `query_action`（只读动作） / `invoke_action`（写动作，仅 write 模式） | 经 OneBot HTTP 调用 | `packages/mcp/src/tools.ts:100`、`:109` | 仅透传 | 仅透传：把 `SNOWLUMA_MCP_ENDPOINT` 指向平台 `/onebot/v11/` 可用；Stream 下载经平台不完整 |
| 资源「SnowLuma OneBot action catalog」 | 完整目录 JSON | `packages/mcp/src/server.ts:88` | 连接器 | 未覆盖 |
| 模式 `docs` / `read` / `write`，上传根目录、流目录、大小上限等环境变量 | | `packages/mcp/src/server.ts:7`–`52` | — | 不适用（运行在 MCP 主机） |

> 桥接自己的 `src/mcp-snowluma-safe.js` 是另一套白名单 MCP，与 `@snowluma/mcp` 无关，不在本表。

## 7. 管理能力（SnowLuma WebUI，`packages/core/src/webui/`）

接口平台 M1 不代理 SnowLuma WebUI；用户继续直接打开 SnowLuma 自己的 WebUI。下表全部为「需要独立管理入口」，M1 状态全部「未覆盖」，区别在于平台将来要不要接管：

| 路由 | 用途 | 源码位置 | 平台的处理建议 |
| --- | --- | --- | --- |
| `POST /api/login`、`/api/logout`；`GET /api/auth/state`；`POST /api/auth/check-strength`、`/api/auth/change-password`；`/api/auth/totp*`（5 条） | WebUI 登录、密码、两步验证 | `server.ts:669`–`904` | 不代理，SnowLuma 自有 |
| `GET /api/agreements`、`POST /api/agreements/record-consent` | 用户协议确认 | `server.ts:944`、`:946` | 不代理 |
| `GET /api/status`、`GET /api/system`、`GET /api/update/check` | 运行状态、系统信息、更新检查 | `server.ts:1026`、`:1067`、`:1039` | 只读摘要可接入平台概览（版本、在线状态） |
| `GET/POST /api/system/settings`；`POST/DELETE /api/system/tls/cert`；`GET /api/system/backup/export`、`POST /api/system/backup/import` | 系统设置、TLS、备份恢复 | `server.ts:1118`–`1254` | 不代理 |
| `GET /api/system/storage`、`POST /api/system/storage/settings`、`/api/system/storage/cleanup` | 消息库/媒体缓存占用与清理 | `storage-routes.ts:80`、`:93`、`:152` | 平台概览可显示占用；清理留在 SnowLuma |
| `GET /api/qq-list`、`GET /api/connections`、`GET /api/state/stream` | 账号列表、OneBot 连接快照、状态推送 | `server.ts:1363`、`:1371`、`:1386` | **连接器应接入**（替代目录扫描发现账号、显示上游连接数） |
| `GET /api/processes`；`POST /api/processes/:pid/load`·`unload`·`refresh`；`GET /api/processes/:pid/probe-login` | 枚举 QQ 进程、注入/卸载 hook、探测登录 | `server.ts:1464`–`1496`；实现 `packages/bridge/src/hook-manager.ts`、`injector.ts` | 只能用户在控制中心亲手操作（与 `PROVIDER.note` 一致），平台不提供接口 |
| `GET/POST /api/config/:uin`、`GET/POST /api/global-config` | 每账号 OneBot 网络配置、全局配置（rkey 备用服务器、`musicSignUrl`） | `server.ts:1511`、`:1521`、`:1672`、`:1674`；字段 `packages/onebot/src/global-config.ts:19`、`:22` | 连接器只读（发现端点与令牌）；写入留在 SnowLuma |
| `GET/POST /api/notifications/config`、`GET /api/notifications/recent`、`POST /api/notifications/test` | 掉线通知（webhook / 邮件） | `server.ts:1619`–`1648`；渠道 `packages/core/src/notifications/config.ts:43` | 平台应有自己的告警（基于健康阶梯），不复用 |
| `GET /api/logs`、`/api/logs/stream`、`/api/logs/export/trace`、`GET/POST /api/logs/level` | 日志查看、导出、级别 | `server.ts:1424`–`1459` | 不代理；平台日志与之分开 |
| `GET /api/debug/actions`、`POST /api/debug/invoke`、`/api/debug/invoke-stream`、`/api/debug/upload`、`GET /api/debug/stream` | 动作调试台 | `server.ts:1288`–`1347` | 平台控制中心可做自己的调试台（管理令牌） |
| `GET/POST /api/ui`、`GET /api/ui/public`、`POST/DELETE /api/ui/background` | WebUI 外观 | `server.ts:1698`–`1763` | 不代理 |

### 7.1 其他内建功能（非动作、非路由）

| 功能 | 源码位置 | 归属 | M1 状态 | 备注 |
| --- | --- | --- | --- | --- |
| 聊天内状态指令（默认 `#sl`，可吞掉消息、冷却 5 秒） | `packages/onebot/src/modules/status-command.ts`；默认值 `:30`–`33` | 连接器 | 透传（SnowLuma 侧生效） | 若 `swallow=true`，该消息不会到达平台 |
| 消息库与历史持久化、历史同步（`historySync`） | `packages/onebot/src/message-store.ts`、`history-persistence.ts`、`history-sync.ts`；开关 `config.ts:71` | 连接器 | 仅透传（`get_*_msg_history` / `get_msg`） | 平台目前只有内存重放窗口 |
| 媒体缓存与 URL 解析、rkey 管理 | `packages/onebot/src/media-store.ts`、`media-url-resolver.ts`、`instance-rkey.ts` | 连接器 | 仅透传 | 统一事件里的媒体 `url` 依赖它；平台不缓存 |
| 入群请求轮询（补齐没有实时推送的邀请） | `packages/onebot/src/group-request-poller.ts` | 连接器 | 已通过统一接口（结果作为 `request.group` 到达） | |
| 临时会话来源群记录 | `packages/onebot/src/temp-session-store.ts` | 连接器 | 仅透传 | 统一侧回发临时会话需要它（M2） |
| 表情回应存储 | `packages/onebot/src/reaction-store.ts` | 连接器 | 仅透传 | |
| 事件过滤 | `packages/onebot/src/event-filter.ts` | 连接器 | 取决于上游配置 | 被过滤的事件平台收不到 |
| QQ 版本兼容清单 | `compat/qq.json` | 独立管理入口 | 未覆盖 | 健康阶梯 `version_unsupported` 可据此判定 |
| QQ 进程注入与 hook 运行时 | `packages/bridge/src/`、`packages/runtime/` | 独立管理入口 | 未覆盖（按设计不经平台） | 仅 Windows |

## 8. 小结：M1 实际覆盖面

- **统一接口真正承接的**：文本/提及/引用/图片/语音/视频段的私聊和群聊发送（`send_private_msg`、`send_group_msg`），全部事件的接收（消息有结构化建模，通知/请求只有通用外壳），账号识别（`get_login_info`）与健康（心跳、`bot_status`）。
- **只靠透传保住的**：190 个动作，以及 SDK、MCP 的全部调用面。没有删除任何既有能力。
- **经平台用不了或不完整的**：5 个规范名动作（`.get_word_slices` + 4 个 Stream 下载）、别名 `.ocr_image`/`.send_packet`、快速操作（动作和 HTTP POST 响应两种形式）、反向 WS 与 HTTP POST 上报、`file` 段统一发送、临时会话统一发送。

## 9. M2 / M4 需要补的缺口

### M2（桥接改用 `/v1`、统一模型补齐）

1. **收紧透传权限**：§0 中「独立管理入口」的 17 个动作（`bot_exit`、`set_restart`、`clean_cache`、`clean_stream_temp_file`、`set_qq_avatar`、`set_qq_profile`、`set_self_longnick`、`set_online_status`、`set_diy_online_status`、`get_cookies`、`get_csrf_token`、`get_credentials`、`get_clientkey`、`request_decrypt_key`、`send_packet`、`get_rkey`、`get_rkey_server`）目前数据令牌即可透传调用。改为管理令牌 + 人工确认，或在兼容入口默认拒绝、按配置放行。
2. **修正 ext 段旁路**（§4.2 末）：统一发送的 `ext` 段要么进能力声明并复用媒体来源校验，要么拒绝媒体类 kind。
3. **动作名校验**：决定 `.` 开头名字的去留。建议放行 `.handle_quick_operation(_async)`、`.ocr_image`、`.get_word_slices` 以保持兼容，`.send_packet` 归入第 1 条的管理入口；改动要显式列名单，不靠正则副作用。
4. **统一模型补齐**（「统一接口」归属中 37 个仅透传项）：消息查询与历史（`get_msg`、`get_*_msg_history`、`get_forward_msg`）、撤回（`delete_msg` + `friend_recall`/`group_recall` 事件）、合并转发发送、联系人与群成员查询（`get_friend_list`、`get_group_list`、`get_group_info`、`get_group_member_*`、`get_stranger_info`）、请求处理（`set_friend_add_request`、`set_group_add_request`）、已读（`mark_*_as_read`）、回应（`set_msg_emoji_like` + `group_msg_emoji_like` 事件）、输入状态、拍一拍（`send_poke`）、语音转文字（`fetch_ptt_text`）、`can_send_*`/`get_version_info`/`get_status`。桥接已在用的（§2 备注「桥接已在用」）优先。
5. **临时会话回发**：`message.send.temp` 经 `send_private_msg` + `group_id` 实现，依赖来源群（`temp-session-store`）。
6. **事件细化**：`notice.notify` 按 sub_type 拆分；`message_sent` 给独立类型或 `self: true` 标记并把 `target_id` 映射进 `conversation`；`bot_offline` 接入健康阶梯原因字段；`mface` 保留 `emoji_id`/`key` 以便原样回发；`at` 保留 `name`。
7. **CQ 码字符串格式**：连接器解析 CQ 码，或要求上游端点 `messageFormat=array` 并在健康检查里报告不符。
8. **连接器类能力的类型化**：128 个「连接器」动作从裸透传升级为 `ext.qq.<动作>` 能力声明（至少声明存在与只读/写属性；参数 schema 可直接以 `catalog.json` 为来源），并提供能力目录接口，替代 `@snowluma/mcp` 的离线目录。
9. **账号发现**：用 SnowLuma `GET /api/qq-list`、`/api/connections` 补充或替代目录扫描（需要 WebUI 令牌，按管理通道处理）。
10. **兼容入口补全**：HTTP POST 上报与快速操作响应、反向 WS（老客户端若依赖这两种方式就无法迁到平台）；按客户端的 `reportSelfMessage` 过滤。

### M4（媒体与文件）

1. **Stream 下载**：连接器支持同一 echo 的多帧回执（按 `stream` 标记聚合或逐帧转发），兼容入口 HTTP 侧用分块响应；涉及 `download_file_stream`、`download_file_image_stream`、`download_file_record_stream`、`test_download_stream`。
2. **媒体上传句柄**：本地文件经平台受控引用上传（`upload_file_stream` 分块 → SnowLuma 本机路径），统一 `image`/`voice`/`video` 段放开本地来源。
3. **`file` 段统一发送**（`message.segment.file`）：走 `file` 段直发或 `upload_group_file`/`upload_private_file`；同时更正 `capabilities()` 中「发文件走 upload_*_file」的说法。
4. **媒体获取统一化**：`get_image`、`get_record`（含 `out_format` 转码）、`get_file`、`get_group_file_url`、`get_private_file_url`、`download_file` 归并为统一的「取媒体」接口；rkey 过期由连接器处理，不把 rkey 暴露给数据客户端。
5. **连接器类文件能力**：群文件（12 个）、群相册（9 个）、闪传（`send_flash_msg`、`get_flash_file_*` 等）、QQ 空间带图发布，依赖 M4 的上传句柄后再做类型化。
