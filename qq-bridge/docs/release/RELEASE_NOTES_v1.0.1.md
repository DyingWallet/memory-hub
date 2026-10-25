# qq-bridge-enhanced v1.0.1

在 v1.0.0 的基础上**增加 Linux 支持**——现在支持 **Windows、macOS、Linux** 三个系统；Windows、macOS 原有的行为不变。
同时适配 SnowLuma 2.x、让 DSH 探活更稳，并让 macOS 第一次运行时自动生成无窗口启动 App。逐条改动见 [CHANGELOG.md](../../CHANGELOG.md)。

## 新功能与改进

- **Linux 支持**（x64 / arm64，桌面或无图形界面的服务器）：
  - QQ 后端：SnowLuma 2.x（`launcher.sh`，完整版自带 `./node`）或 NapCat（启动文件可选 `.sh` 脚本或可执行文件）；
  - 无窗口启动：`npm run linux-service -- --enable` 生成 systemd 用户服务（后台常驻、登录自动启动、崩溃自动重启），有桌面时另有启动项；
  - 「浏览…」在有 zenity / kdialog 时弹出系统选择窗口，服务器上手动填路径；服务器上用 `ssh -L 3099:127.0.0.1:3099` 访问控制中心。
- **SnowLuma 2.x 适配**（Windows 与 Linux）：识别两种发行包布局；读 `engines.node` 与 `release.json`，Lite 版本机 Node 不够（2.x 需要 24+）、或发行包与本机平台 / 架构不符时不启动并写明原因；
  检查更新按本机系统与架构推荐完整版（`win-x64.zip` / `linux-x64.tar.gz` / `linux-arm64.tar.gz`）。账号配置格式与 1.14 相同，账号发现与令牌自愈不需要改。
- **DSH 探活更稳**：连续 2 次（约 10 秒）失败才判定「DSH 不可用」，偶发失败只在恢复时记一笔；日志写明失败原因（超时 / 连接被拒 / 连接被中断 / 鉴权失败等）。端口重新识别仍在第一次失败时开始。
- **macOS**：第一次双击 `control-center.command` 会自动生成「QQ Bridge 控制中心.app」并在访达里选中它，以后双击 App 即可（不再需要手动 `npm run mac-app`）。
- 接口平台、控制中心、README 等处的系统说明统一为 Windows / macOS / Linux。

## 下载

| 文件 | 说明 |
| --- | --- |
| `qq-bridge-enhanced-v1.0.1.zip` | 完整源码（含接口平台）+ 文档 + 测试 + 配置模板（不含 node_modules、SnowLuma、NapCat、QQ、DSH、真实配置或数据） |
| `qq-bridge-enhanced-v1.0.1.zip.sha256` | SHA-256 校验值 |

部署见 [README.md](../../README.md)「部署（无窗口版）」与 [docs/DSH_DEPLOYMENT.md](../DSH_DEPLOYMENT.md)（含 Linux 的 4.1b、4.3b、10.1 节）。

## 从 v1.0.0 升级

1. 退出控制中心；备份 `config.json`、`state/`、`interface-platform/state/`。
2. 解压到新目录，把上面三样复制过去（以及 `audio/`、自定义 `roles/*.md`，如有）。
3. `npm ci` → `npm run test:audit`；macOS 删掉旧的「QQ Bridge 控制中心.app」后双击一次 `control-center.command`（或 `npm run mac-app`）；Linux 运行 `npm run linux-service -- --enable`。
4. 启动控制中心 → 开启后端 → 启动桥接。preset 没有变化，不需要重跑 `setup-dsh.mjs`。

## 测试

- `npm run test:audit`：55 个离线回归脚本，macOS 与 Linux 上都是 **54/55**（`test-console-encoding.mjs` 检查的是 Windows 控制台的 `chcp`，只在 Windows 上通过）。
  接口平台自身 26 项全部通过。新增 `test-linux-support.mjs`（同时断言 Windows / macOS 原有行为不变）、`test-dsh-health.mjs`。
- **Linux 验证**：在 Linux arm64 容器（Node 22）里从零 `npm ci`、跑完整离线测试，并实际启动控制中心与接口平台、检查后端声明与「浏览…」在无图形界面时的行为。
- SnowLuma 2.0.3 的 Windows / Linux 发行包：核对了目录布局、启动脚本、Node 要求与账号配置格式（未运行）。
- **未在真实环境验证**：Linux 上的 QQ（Linux 版 QQ + SnowLuma / NapCat）扫码登录与收发、systemd 服务实际运行、桌面选择窗口；SnowLuma 2.x 的实际收发（Windows 与 Linux）。
