# qq-bridge-enhanced v0.4.1

根据第一次真实部署（DSH 桌面版 + SnowLuma + 新 QQ 号）的报告修复，并给控制台加了人格快捷选择。

## 修复

- **SnowLuma 握手被拒后一直连不上**：有的 SnowLuma 版本拒绝 WebSocket 握手时只报 `error`、不报 `close`，
  旧版的自动重连和 token 自愈都等不到触发。现在出错时也会自愈，并有**连接看门狗**每 10～60 秒重试一次，连上即停。
- **AI 出错时看不到原因**：缺模型凭据（`MISSING_CREDENTIAL`）等错误现在会写进日志（错误码 + 脱敏详情），
  QQ 上显示错误码；配置类错误会私聊提醒管理员（30 分钟最多一次）。群聊里不显示错误原文。

## 改进

- **DSH 桌面版开箱即用**：自动识别端口（桌面版 19387 / 命令行版 3080）和 profile（desktop / web），
  `dsh` 不在 PATH 时自动使用桌面版自带的 `dsh.cmd`。`config.json` 的 `dsh.baseUrl` 留空即可。
- 启动器找不到 Node.js 时会提示，不再静默失败。
- 控制台「切换当前启用的人格」：点进输入框就列出已有人格，输入时按开头过滤（不区分大小写），点击或 ↑↓ + 回车填入；仍可手动输入新名字。
- 部署指南：新增「配置 DSH 模型凭据」（API Key → `deepseek-official`，账号登录 → `deepseek-account`），
  补充桌面版端口与 profile、装好 Node 后重跑 setup、DSH 沙箱限制、`reasoningEffort` 快慢取舍等说明。

## 下载

| 文件 | 说明 |
| --- | --- |
| `qq-bridge-enhanced-v0.4.1.zip` | 完整源码 + 文档 + 测试 + 配置模板（不含 node_modules、SnowLuma、DSH、真实配置或数据） |
| `qq-bridge-enhanced-v0.4.1.zip.sha256` | SHA-256 校验值 |

## 从 v0.4.0 升级

替换代码，沿用 `config.json` 与 `state/`，执行 `npm ci`，重启桥接即可。
- 已在 `config.json` 里写了 `dsh.baseUrl`（例如 `http://127.0.0.1:19387`）的可以不动；改成 `""` 则自动识别。
- 用桌面版 DSH 的，建议再跑一次 `node scripts/setup-dsh.mjs`（会自动选 desktop profile 并用桌面版的 `dsh.cmd` 安装 bundle），然后重启 DSH。

## 测试

- `npm run test:audit`：**40/40** 通过。新增：
  - `test-snowluma-reconnect.mjs`：用真实 `@snowluma/sdk` + 假 WebSocket 复现「只报 error 不重连」，验证看门狗能恢复、退避有上限、正常 close 路径不受影响；
  - `test-agent-errors.mjs`：错误码识别、凭据 / 令牌 / 本机路径被抹掉、群聊不显示原文；
  - `test-dsh-endpoint.mjs`：显式地址照用、桌面版优先 19387、端口探测；
  - `test-console-static.mjs` 增加人格过滤（AAA/BBB/CCC/ABB 示例）断言。
- 启动器：在去掉 Node 的 PATH 下运行 `control-center.bat`，确认提示并暂停。控制台下拉菜单在离线预览里实际点按检查过。
- **未在真实环境验证**：看门狗对真实 SnowLuma 的恢复、owner 错误提醒的实际投递、桌面版上 `dsh.cmd plugin install`。
