# 接口平台里程碑与现状盘点

依据：`接口平台-完整设计与实施交接.md`（2026-10-18）。本文记录 M0 盘点结论、M1 的精确范围和仍待项目组决定的事项。

## M0 现状盘点（2026-10-18，基于 qq-bridge v0.4.2）

### 桥接与 SnowLuma 的耦合点（已核实）

| 位置 | 耦合 | M1 处理 |
| --- | --- | --- |
| `src/bridge.js` | `@snowluma/sdk` 的 `SnowLumaWebSocketClient` 连 `snowluma.wsUrl`；7 处直接 `fetch(httpUrl/<action>)` | 不改代码，改配置指向平台的 OneBot 兼容入口 |
| `src/bridge.js` `applyHealedTokens` | token 自愈会把 wsUrl 改回发现到的真实 SnowLuma 端点，绕过平台 | 新增 `snowluma.viaPlatform`：为 true 时不跟随端点、不扫描 SnowLuma 目录 |
| `src/snowluma-conn.js` | 从 `<SnowLuma>/config/onebot_<QQ>.json` 发现 token | 平台的 SnowLuma 连接器各自实现一份；桥接侧在 viaPlatform 时跳过 |
| `src/mcp-snowluma-safe.js` | 读 `config.json` 的 `httpUrl + accessToken` 调 OneBot HTTP | 自动随配置走平台，无需改代码 |
| `src/core/session-router.mjs` | 会话键只接受 `private:<数字>` / `group:<数字>` | M2 |
| `src/social/people.js`、owner 权限 | QQ 号身份假设 | M2；按交接 §8.6 不跨平台合并身份 |
| `src/launcher/control-center.mjs`、`public/control-center.html` | SnowLuma 专属卡片 | M1 改为顶部大标签；SnowLuma 卡片移入「接口平台 → 接入实例」 |

### 桥接实际使用的 OneBot 面

- 事件：私聊/群消息、`notify`（拍一拍）、`group_increase/decrease/card/recall`、`meta_event/heartbeat`（`status.good/online`）、`bot_status`。
- 动作：经 WS（SDK）和 HTTP 两条路都会调用，包括 `get_login_info`、`get_status`、`send_*_msg`、`get_msg`、`fetch_ptt_text`、表情/成员/历史等。
- 兼容入口必须同时提供 WS 和 HTTP，且 HTTP 与 WS 使用同一个平台令牌（SnowLuma 原本两者令牌不同，平台对桥接统一为一个）。

### 完整功能矩阵

SnowLuma 1.14.22 的完整动作/事件清单需要从 `jiaoliu/jiaoliu` 源码逐项导出后再冻结（交接 §9）。M1 通过 OneBot 透传，**不删除**任何既有能力；统一接口（§7.1）只覆盖文本/引用/提及/媒体引用的发送和全部事件的接收。矩阵在 M2 开始前补齐到 `docs/FEATURE_MATRIX.md`。

## M1 范围（本轮实现）

1. **核心框架**（`src/core/`）：实例/账号注册表、事件总线（内存重放窗口 + 游标）、请求状态机与去重、每账号有上限队列、结构化日志（脱敏）、配置与令牌。
2. **SnowLuma 连接器**（`src/connectors/qq-snowluma/`）：外部运行模式；连上游 WS，自动从 SnowLuma 目录发现 WS 令牌；心跳健康；echo 改写；重连退避；断开时冻结发送。
3. **公共接口**：§7.1 数据接口、§7.2 管理接口、§8 OneBot 兼容入口（WS + HTTP）。
4. **控制中心顶部大标签**：「桥接」「接口平台」两个标签，切换只改变显示；接口平台页含概览/接入实例/账号/日志/设置；启停接口平台进程；一键把桥接接到平台（会备份原配置，可还原）。
5. **离线测试**：假 SnowLuma 上游 + 真实 `@snowluma/sdk` 客户端走兼容入口；接入 `npm run test:audit`。

M1 **不是**最终交付。以下明确不在 M1：Mac QQ 原生接入（M3）、多后端同账号切换、媒体上传句柄、持久化游标、Windows 实机验收（需要 Windows 设备，见待决事项 5）。

### M1 验收

| 项 | 方法 | 本机能否完成 |
| --- | --- | --- |
| 桥接经平台收发 | 离线：假上游 + SDK 客户端 + HTTP 透传 | ✅ 离线 |
| Windows 原有 QQ 链路经过平台仍工作 | 实机：SnowLuma + 桥接 + 平台 | ❌ 需 Windows 实机 |
| 标签切换不影响运行 | 页面只切显示；测试断言切换不发请求 | ✅ |
| 延迟/资源基线 | `npm run bench`（假上游，直连 vs 经平台） | ⚠️ 只能给假上游的相对开销，真实预算需实机 |

## 待项目组决定（未决定前采用的默认值）

| # | 事项 | 当前默认 |
| --- | --- | --- |
| 1 | 完整功能基线的 SnowLuma 版本 | 1.14.22（本地已有源码） |
| 2 | 独立仓库还是现仓库子目录 | 与桥接平行的目录 `dsh-qq/interface-platform/`，零依赖、可独立运行；与桥接只经 API 通信（不互相导入模块、不读对方数据目录） |
| 3 | Mac 第一版 QQ 后端 | 先用 NapCat 连接器（外部运行，连接用户自己安装的 NapCat）；自研 Mac 原生接入仍标「尚未提供」。NapCat 的许可由使用者自行遵守，平台不分发、不安装、不修改它 |
| 4 | 是否首期支持 Intel Mac | 未定；只有 ARM64 有实验证据 |
| 5 | Windows 实机测试/CI 由谁负责 | 未定；Mac 上的离线测试不能替代 |
