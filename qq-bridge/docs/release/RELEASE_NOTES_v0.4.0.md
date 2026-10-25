# qq-bridge-enhanced v0.4.0

在 v0.3.0 的基础上新增**控制中心**：一个本地网页把「桥接终端」和「SnowLuma」合在一起，屏幕上只需要 QQ、DSH 和这个页面。

## 新增

- **控制中心**（`control-center.bat`，或无窗口的 `control-center-hidden.vbs`）：左侧桥接日志 + 固定命令（status / mode / panic / audit …），
  右侧 SnowLuma，底部整体状态栏（含当前登录的机器人账号、模式与权限级别、各组件版本）。打开它不会自动启动任何东西。
- **SnowLuma 面板**：选择你自己解压的目录（不放进项目）、显示版本与完整版/Lite 版、由你点击启动/停止、打开它的 WebUI、
  检查更新、**更新助手**（备份并迁移账号与数据到新版本目录，旧目录保留）。
- 部署指南补充桌面版 DSH 的说明。

## 不做的事（SnowLuma 用户协议 v1.1 §5.4）

不自动启动 SnowLuma、不下载/解压/替换它的程序文件；SnowLuma 不进仓库，也不进本 Release 包。

## 下载

| 文件 | 说明 |
| --- | --- |
| `qq-bridge-enhanced-v0.4.0.zip` | 完整源码 + 文档 + 测试 + 配置模板（不含 node_modules、SnowLuma、DSH、真实配置或数据） |
| `qq-bridge-enhanced-v0.4.0.zip.sha256` | SHA-256 校验值 |

## 从 v0.3.0 升级

直接替换代码即可（`state/`、`config.json` 沿用）；不需要重跑 `setup-dsh.mjs`（preset 与 MCP 没有变化），重启桥接即可。

## 测试

- `npm run test:audit`：**37/37** 通过（新增 `test-control-center.mjs` 15 项：目录识别、版本比较、数据迁移只搬 config/data 且先备份、
  拒绝降级、更新检查、子进程管理与自动重启、HTTP 鉴权/Host/跨站/非 JSON、固定命令集不能执行任意程序、选择目录不启动 SnowLuma、L6 合规断言）。
- 在开发机上实际打开控制中心页面检查了布局、令牌、命令行、目录识别和「检查更新」（真实请求 GitHub API）。
- **未在真实环境验证**：从控制中心启动真实 SnowLuma 与真实桥接、停止 SnowLuma 时它的数据安全、更新助手对真实 SnowLuma 数据目录的迁移、
  桌面版 DSH 的端口与 bundle 安装（见 docs/DSH_DEPLOYMENT.md 第 3、8 节）。v0.3.0 的「需要部署后验证」清单仍然有效。
