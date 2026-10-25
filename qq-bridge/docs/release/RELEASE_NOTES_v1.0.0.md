# qq-bridge-enhanced v1.0.0

第一个正式版本。在 v0.4.2 的基础上：支持 **Windows 与 macOS**，新增**接口平台**，控制中心统一管理桥接、接口平台与 QQ 后端，
兼容 DSH 0.2.1，并增量合入上游 Derpyu520/qq-bridge v0.2.0-r4 的修复（本仓库的增强功能全部保留）。
逐条改动见 [CHANGELOG.md](../../CHANGELOG.md)。

## 主要新功能

- **macOS 支持**：QQ 经 **NapCat** 接入（用 NapCat Mac 安装器装进 Mac 版 QQ）。`npm run mac-app` 在本机生成
  「QQ Bridge 控制中心.app」：双击无窗口启动，没有 Dock 图标；再次双击重新打开页面；页面上退出后 App 随之退出。
- **接口平台**（仓库内 `interface-platform/`）：桥接和 QQ 后端之间的统一接入层。按后端目录自动发现账号；SnowLuma（Windows）与
  NapCat（macOS / Windows）可以同时接入、互不干扰；账号目录读不了（例如 macOS 隐私保护）时保留现有连接，不当成账号消失。
  为以后接入微信 / Discord / KOOK 预留了统一接口。
- **控制中心**：
  - 顶部「桥接」「接口平台」两个大标签；接口平台页有概览（后端开启卡）、接入实例、账号、日志、设置；
  - 「接入桥接」一键让桥接经接口平台收发（原配置自动备份，可「恢复直连」）；
  - **NapCat 管理**：版本显示（NapCat 自报）、检查更新（只提示不下载）、QQ.app / 启动文件 / NapCat 目录设置、系统原生「浏览…」窗口（macOS / Windows）；
  - **NapCat 扫码登录**：需要扫码时开启卡直接提示，程序区显示二维码，NapCat 日志里也插入可扫的小图（旧码标「已过期」）；
  - 「打开桥接控制台」自动带令牌；状态栏的 DSH 以桥接的就绪状态为准，「接入后端」按真实连接显示。
- **DSH 0.2.1**：preset 去掉 `{{cwd}}`（同时兼容 0.2.0-rc.2）；桌面版 0.2.1 的随机端口自动识别（Windows / macOS），DSH 重启后桥接自动跟上。
- **管理员私聊跨群查看与群长期规则**（默认关闭，`socialV2.tools.ownerGroupAccess`）：管理员私聊的 AI 可只读查看白名单群，并给群设长期说话规则。
- **表情**：单张大小上限可配（`socialV2.sticker.maxBytes`，默认 10MB）；NapCat 下 AI 收藏表情可用。
- **上游 r4**：联网搜索（`src/web-search.js`）、长轮询与超时稳定性、多处体检修复，以及对应的回归测试。
- **桥接控制台黑话库**：候选词拆成「待研究」「已研究」两栏。
- **版本号统一**：接口平台的版本号与项目一致（1.0.0）。英文 README（README.en.md）同步更新为本版内容。
- **日志**：经接口平台时写「QQ 后端（经接口平台 · NapCat <版本>）已连接」，不再一律写 SnowLuma。

## 下载

| 文件 | 说明 |
| --- | --- |
| `qq-bridge-enhanced-v1.0.0.zip` | 完整源码（含接口平台）+ 文档 + 测试 + 配置模板（不含 node_modules、SnowLuma、NapCat、QQ、DSH、真实配置或数据） |
| `qq-bridge-enhanced-v1.0.0.zip.sha256` | SHA-256 校验值 |

部署（Windows / macOS，无窗口启动）：见 [README.md](../../README.md)「部署（无窗口版）」；给 DSH agent 的逐步说明：[docs/DSH_DEPLOYMENT.md](../DSH_DEPLOYMENT.md)。

## 从 v0.4.2 升级

1. 退出控制中心；备份 `config.json` 与 `state/`。
2. 解压到新目录，把旧目录的 `config.json`、`state/`（以及 `audio/`、自定义 `roles/*.md`，如有）复制过去。
3. `npm ci` → `npm run test:audit` → **`node scripts/setup-dsh.mjs` 并重启 DSH**（preset 有变化）。macOS 再 `npm run mac-app`。
4. 启动控制中心。想经接口平台收发：接口平台 → 开启后端 →「设置 → 接入桥接」→ 启动桥接。不接入时桥接照旧直连 SnowLuma，行为与 v0.4.2 一致。

以后更新 / 备份时，把 `interface-platform/state/`（接口平台的实例配置与令牌）一起带上。

## 测试

- `npm run test:audit`：53 个离线回归脚本；macOS 上 **52/53**（`test-console-encoding.mjs` 只适用于 Windows 控制台，Mac 上是已知失败）。
  接口平台自身 26 项测试全部通过。本版新增的离线测试包括：接口平台（`test-platform`）、NapCat 管理与扫码（`test-napcat-manage`）、
  macOS 启动 App（`test-mac-app`，Mac 上实际生成并校验签名）、日志用词（`test-qq-backend-label`）、黑话分栏（`test-slang-tabs`）、
  群长期规则、表情上限、NapCat 收藏表情、DSH 端口识别等，以及移植的上游 r4 回归。
- **macOS 实机验证**：NapCat 4.18.38 + Mac 版 QQ 7.0.2 → 接口平台 → 桥接 → DSH 0.2.1 桌面版：群聊 / 私聊收发、记忆导入、
  表情收藏、DSH 重启后自动重连、NapCat 自动登录、无窗口 App 启动与「访问其他 App 的数据」授权。
- **未在真实环境验证**：
  - **Windows 上的新链路**（SnowLuma / NapCat 经接口平台、DSH 0.2.1 随机端口识别、无窗口入口下的新页面功能）——离线测试覆盖了逻辑，但没有 Windows 实机回归；
  - NapCat 登录二维码在页面上的实际显示（验证时 NapCat 一直自动登录成功，没有出现需要扫码的情况）；
  - 浏览器 UI 自动化测试（`test-console-ui`，需要 Playwright）。
