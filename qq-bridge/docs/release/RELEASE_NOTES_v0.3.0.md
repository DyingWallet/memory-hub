# qq-bridge-enhanced v0.3.0

基于 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) v0.2.0-r3。适配 DSH `0.2.0-rc.2`、SnowLuma ≥ 1.14.20、Node.js ≥ 22.13、Windows x64。

## 亮点

- **按 QQ 号跨群认人**：同一个人在不同群用不同群名片，也会被认成同一个人；同名不同号绝不合并。
- **分层人物记忆**：群内 / 私聊 / 全局三个作用域，默认只跨群共享「这是同一个人」与管理员设定的称呼；
  可见范围在注入时由程序过滤，私聊内容任何情况下都不会被带到群里。
- **入群感知**：新成员、在别处认识的熟人、退群后回来的人分别识别，写进二代消息流并唤醒 AI，由人格自然决定是否打招呼。
  首次部署不会把老成员当成新人；断线期间漏掉的入退群会在重连后对账补记。
- **owner 私聊管理通道**：`/mode agent L1|L2|L3` 申请 → 桥接发确认码 → 回复「确认 XXXX」才切换；L3 还要手机验证器的 TOTP 动态码。
  降级与 `/panic` 一步完成；高权限闲置 30 分钟自动回落；所有变更私聊通知并写入哈希链审计。
- **权限分级落到 DSH**：L1 只读工具白名单 preset；L2/L3 桥接自带的运维 preset + 审批闸门（执行命令 / 除只读外的一切操作都要 owner 在 QQ 审批）——
  因为 rc.2 的审批只在越过沙箱时触发，光靠权限预设做不到「每次审批」；**任何入口都不能开启免审批的完全访问**。
- **审批增强**：编号 `#n`、展示实际命令和参数、并发互不覆盖、旧编号作废、超时自动拒绝。

## 下载

| 文件 | 说明 |
| --- | --- |
| `qq-bridge-enhanced-v0.3.0.zip` | 完整源码 + 文档 + 测试 + 配置模板（不含 node_modules、SnowLuma、DSH、任何真实配置或数据） |
| `qq-bridge-enhanced-v0.3.0.zip.sha256` | SHA-256 校验值 |

SnowLuma 需要用户自行从其官方 Release 下载安装（其专有组件不允许被第三方再分发）。

## 部署

给人看：[README.md](../../README.md) → 「增强版快速开始」。给 DSH agent 看：[docs/DSH_DEPLOYMENT.md](../DSH_DEPLOYMENT.md)。

最短路径：`npm ci` → `npm run test:audit`（应 36/36）→ 编辑 `config.json` → `node scripts/setup-dsh.mjs` → 重启 DSH →
`npm run probe:permission` → （可选）`npm run admin:totp-setup` → `start.bat`。

## 从上游 v0.2.0-r3 升级

`state/` 与 `config.json` 可直接沿用；必须重跑 `node scripts/setup-dsh.mjs` 并重启 DSH。
旧版按名字存的群友印象会自动迁移（能唯一对应 QQ 号的才导入）。若升级前停在 closed-agent，首次启动会回落到 reserved2 并告警。
行为变化见 [CHANGELOG.md](../../CHANGELOG.md)「变更」。

## 测试结果（开发机，离线）

- `npm run test:audit`：**36/36 脚本通过**（原版 31 + 新增 5：test-continuity 26 项、test-admin-control 24 项、test-integration-v030 30 项、test-agent-readonly-guard 9 项、preset patch 契约）。
- 从 Release ZIP 解压到全新目录 → `npm ci` → `npm run test:audit`：36/36 通过。
- 发布前做了一轮独立安全审查（9 条发现，均已修复并加回归测试，见 CHANGELOG「安全加固」）。
- 用 `@deepseek-ai/dsh@0.2.0-rc.2` 安装包做的工具名对账：通过。
- `setup-dsh.mjs` 幂等性测试（含 rc.2 的 YAML 加载器）：通过。
- 未运行：Playwright 控制台回归（`npm run test:console-ui`，开发环境未安装 Playwright）、所有需要真实 QQ / SnowLuma / 运行中 DSH 的验证。

## 需要部署后集成验证

- `npm run probe:permission`：DSH 的 `qq-full-ask` 预设、`/permission` 命令、`qq-agent-readonly` preset 在目标机上的实际行为；
- L1 守卫是否收到 `profile: readonly-agent` 配置（让 L1 Agent 尝试写文件，应被拒绝）；
- **L2/L3 审批闸门是否生效**（让 L2 Agent 执行 `dir`，必须先收到「🔐 审批 #n」）——这是 L2/L3 安全承诺的前提；
- `npm run probe:member-events`：SnowLuma 实际的入群/退群/改名片/撤回载荷；
- 真实 QQ 环境下的 12 项功能验证（[DSH_DEPLOYMENT.md](../DSH_DEPLOYMENT.md) 第 12 节）。

## 已知问题与风险

- 开发期间**没有**真实的 QQ、SnowLuma 运行实例或运行中的 DSH；DSH 行为来自对 rc.2 安装包源码的静态核对，SnowLuma 载荷来自其 1.14.22 源码。
- `group_card`（改名片）由 SnowLuma 在该成员下一次发言时派生，不是实时的。
- Windows 上 DSH 的沙箱是 partial 且不限制读；L2/L3 的 Agent 以 owner 的本机账户运行，安全性依赖你对每条审批的判断（不要批准读取 `state`/`.dsh` 或访问本机 API 的命令）。L3 本质上是完全访问。
- 管理通道建立在 QQ 账号之上；owner 的 QQ 被盗时攻击者可以开启 L1/L2（L3 需要 TOTP）。不需要时请 `admin.allowL3=false` 或 `admin.enabled=false`。
- 控制台 Playwright 回归基线（`scripts/console-ui-contracts.json`）未针对新控件重录；上游基线本身也已缺少 `sendVoice` 开关。
- `@snowluma/sdk` 的授权对第三方客户端是否适用不明确（见 [NOTICE.md](../../NOTICE.md)），发布前请自行评估。
- 设计文档中的离线整理会话、记忆衰减、关系线（Thread）、群档案、注意力调度等后续阶段未在本版本实现。
