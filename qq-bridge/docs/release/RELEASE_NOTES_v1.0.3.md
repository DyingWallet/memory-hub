# qq-bridge-enhanced v1.0.3

在 v1.0.2 的基础上的修复版本：**切换 agent 等级不再失忆**；**引用一条合并转发时，AI 能看到并打开里面的内容**，这条消息也不再卡 30 秒；普通图片不再被误当成表情。
支持系统不变：**Windows、macOS、Linux**。逐条改动见 [CHANGELOG.md](../../CHANGELOG.md)。

## 修复：切换 agent 等级 / 自动回落后 AI「失忆」

以前切到 agent L1~L3、或者从 agent 回落，桥接会把**所有** QQ 会话归档再新建：私聊里刚聊的事、每个群里的上下文全都没了。现在：

- **群和私聊原来的聊天会话会「休眠」而不是归档**，回落后原样接着用，AI 记得之前在聊什么；群会话恢复后会被告知「刚才休眠了多久、这段时间的群消息没收到」。
- **agent 会话能接上私聊的话题**：切到 agent 时，新会话第一条消息带上你们最近在私聊里的往来；回落后，私聊会话会收到 agent 期间的往来。
  交接只含 owner 私聊（路径和凭据打码），不含任何群聊内容；确认码、TOTP、管理命令不会被记下。
- 恢复的会话按正常原因唤醒，不会再收到一遍「首次接入」的引导。
- 安全不变：agent 会话回落、`/panic`、L1→L2 时照常停掉并归档。
- 休眠超过 24 小时（`admin.dormantMaxMs`）、回到的模式不同、手动重置会话时，旧会话归档、不复用。
- 想要旧行为：`admin.hibernateChatSessions: false`、`admin.handover: false`。觉得回落太勤可以调大 `admin.idleTimeoutMs` / `admin.maxElevatedMs`。

## 修复：引用合并转发

- **引用一条合并转发时，AI 只看到「[引用消息]」，整条消息还卡住 30 秒**：实测 macOS 上的 NapCat 读一条较早的合并转发要七十多秒，而桥接和接口平台都只等 30 秒。现在：
  - 收消息时解析引用最多等 4 秒，等不到先放「[引用消息 id=…（原消息加载较慢…）]」占位，消息照常进未读；原消息在后台继续取（最长 2 分钟），取到后缓存；
  - AI 用 `qq_get_message_detail` 查这个 id：还在取时明确说「稍后再查」，取到后返回内容和里面的合并转发 id；
  - **引用里的合并转发 id 登记为本会话可见**（只在确认被引用消息属于本群 / 本私聊之后），AI 能直接用 `qq_get_forward_msg` 打开，哪怕原转发早已滚出最近消息；
  - 读合并转发改为长超时并缓存 30 分钟，同一个转发只取一次；嵌套转发的预览改为并行读取；
  - 接口平台只给 `get_msg` / `get_forward_msg` 两个只读动作放宽到 120 秒（`limits.slowReadTimeoutMs`），发送类动作仍按 30 秒。
- 合并转发本身（包括转发里的转发）原来就能看：二代仿真模式下 AI 用 `qq_get_forward_msg` 打开，嵌套的会附前几条预览，也能用嵌套 id 继续打开。

## 修复：普通图片被误当成表情

- 普通 QQ 图片的文件名本身就是 32 位哈希，以前会被误认成表情：先去拼一个必然 404 的表情地址，日志里也写成「表情获取失败」。现在只有 mface 市场表情、带 `emoji_id`、`sub_type=1` 或「两位前缀-32 位 hex」文件名的才按表情处理。
- 说明：这只修正了分类和多余的一次请求。这次实测里那张图之所以没取到，是 QQ 那边的问题——转发里的图片链接已经失效（HTTP 400），NapCat 自己下载也失败（`downloadRichMedia` 超时），桥接这边无法补救。

## 下载

| 文件 | 说明 |
| --- | --- |
| `qq-bridge-enhanced-v1.0.3.zip` | 完整源码（含接口平台）+ 文档 + 测试 + 配置模板（不含 node_modules、SnowLuma、NapCat、QQ、DSH、真实配置或数据） |
| `qq-bridge-enhanced-v1.0.3.zip.sha256` | SHA-256 校验值 |

部署见 [README.md](../../README.md)「部署（无窗口版）」与 [docs/DSH_DEPLOYMENT.md](../DSH_DEPLOYMENT.md)。

## 从 v1.0.2 升级

1. 退出控制中心；备份 `config.json`、`state/`、`interface-platform/state/`。
2. 解压到新目录，把上面三样复制过去（以及 `audio/`、自定义 `roles/*.md`，如有）。
3. `npm ci` → `npm run test:audit`；macOS 删掉旧的「QQ Bridge 控制中心.app」后双击一次 `control-center.command`；Linux 运行 `npm run linux-service -- --enable`。
4. 启动控制中心，再启动接口平台和桥接。没有数据格式变化，不需要重跑 `setup-dsh.mjs`。
5. 如果换了程序目录，按部署文档第 13 节「换了程序目录之后」的清单检查一遍（先在控制台重置会话，再删旧目录）。

## 测试

- `npm run test:audit`：60 个离线回归脚本，macOS 与 Linux 上都是 **59/60**（`test-console-encoding.mjs` 只在 Windows 上通过）；接口平台 26 项全部通过。
- `test-media-search.mjs` 新增：哈希文件名的普通图片按图片处理、不拼表情 CDN；真表情仍先走 CDN。
- 新增 `test-mode-handover.mjs`：二代 → agent L2 → 回落的端到端（聊天会话休眠复用、交接注入、高权限会话归档）、各种作废情况、确认码不进交接记录。
- 新增 `test-quote-forward.mjs`：引用合并转发的短等待、后台补齐、转发 id 登记与跨群隔离、读合并转发的缓存与长超时、接口平台的分动作超时、发送引用时「加载中」不算确认归属。
- **真实环境（切换不失忆）**：macOS + NapCat 4.18.38 + DSH 桌面版上实测：二代仿真 → agent L1 时私聊会话休眠未归档；agent 能答出切换前私聊聊过的内容；`/panic` 回落后复用原会话（未新建），并知道 agent 期间的请求；交接记录里没有确认码，文件权限 600。群会话：切到 agent 时休眠、回落后被 @ 时原样恢复（未新建、唤醒原因不是首次引导），AI 记得切换前群里交代的事。
- **真实环境（引用合并转发）**：在 macOS + NapCat 4.18.38 上复现过原问题（读那条被引用的合并转发 `get_msg` 约 76 秒、`get_forward_msg` 约 76 秒）；修复后的代码尚未在真实 QQ 群里验证（需要重启桥接和接口平台，并等有人引用合并转发）。
