# interface-platform —— 接口平台

把聊天平台的账号、事件和发送统一管理起来，桥接只面对一个接口；具体后端（SnowLuma、将来的 Mac 原生接入、Discord 等）是可以替换的连接器。

当前进度：**M1**（见 [docs/MILESTONES.md](docs/MILESTONES.md)）。只有 QQ，有两个连接器：SnowLuma（Windows / Linux）和 NapCat（macOS / Windows / Linux），都连接用户自己运行的后端。M1 不是完整交付。

```text
DeepSeek / DSH ↔ 桥接 ↔ 接口平台 ┬ SnowLuma 连接器 ↔ SnowLuma（Windows / Linux）↔ QQ
                                  └ NapCat 连接器   ↔ NapCat（macOS / Windows / Linux）↔ QQ
```

## 运行

零运行时依赖，Node ≥ 22.13，Windows / macOS 通用。

```bash
node src/index.mjs                # 默认 127.0.0.1:3120，数据目录 ./state
node src/index.mjs --port 3121 --data-dir D:\platform-data
```

通常不用手动运行：qq-bridge 控制中心的「接口平台」标签里点「启动接口平台」即可。本目录是 qq-bridge-enhanced 仓库里的独立子程序（零运行时依赖，自己的 `package.json` / 测试 / `state/`），控制中心默认按 `<仓库>/interface-platform` 找它，与平台只经 HTTP 接口通信；平台代码不导入桥接的任何模块，桥接也不导入平台的模块（`scripts/test-platform.mjs` ⑥ 检查）。

首次启动会在数据目录生成：

| 文件 | 用途 |
| --- | --- |
| `platform.json` | 实例、账号开关、兼容入口、恢复策略（含上游令牌，不要提交） |
| `data-token` | 数据令牌：桥接调用 `/v1` 与 OneBot 兼容入口 |
| `admin-token` | 管理令牌：手动调用 `/v1/admin` 时用。qq-bridge 控制中心不读它，而是在启动平台时经 `INTERFACE_PLATFORM_ADMIN_TOKEN` 交来自己保管的管理令牌 |

## 接入 SnowLuma

`platform.json` 的实例二选一：

- 填 `upstream.homeDir`（SnowLuma 解压目录）：按 `config/onebot_<QQ>.json` 自动发现每个账号的 WS 端点与令牌，换账号自动跟上，一个实例可提供多个账号。
- 不填目录：用 `upstream.wsUrl` + `upstream.accessToken` 连单个账号。

接口平台只连接 SnowLuma，不启动、不停止它。

## 接入 NapCat（macOS 用这个）

1. 自己安装并启动 NapCat（官方文档：https://napneko.github.io/guide/boot/Shell#macos ），扫码登录机器人 QQ。接口平台不安装、不启停、不修改 NapCat；NapCat 的许可条款由使用者自行遵守。
2. 在 NapCat 的 OneBot 网络配置里**新建并启用一个 WebSocket 服务端**（`websocketServers`，`enable: true`），记下端口和 token。
3. `platform.json` 的实例：`"provider": "napcat"`，二选一：
   - `upstream.homeDir` 填 NapCat 的配置目录（含 `onebot11_<QQ>.json` 的目录或它的上一级），自动发现每个账号的端点；
   - 或填 `upstream.wsUrl` + `upstream.accessToken`。

macOS 上首次启动时默认实例就是 `napcat-main`（Windows 上是 `snowluma-main`）。令牌错误时 NapCat 会先接受连接再回 1403，平台会显示为「鉴权失败」而不是普通掉线。

**状态**：NapCat 连接器已用离线假后端测过（发现、收发、兼容入口、鉴权失败）；**还没有在真实 Mac + NapCat + QQ 上验收**。NapCat 的扩展动作集合与 SnowLuma 不同，统一接口只依赖 OneBot v11 标准动作。

## 让桥接经过平台（M1 过渡方式）

桥接 `config.json` 的 `snowluma` 改为（控制中心「接入桥接」按钮会经 `GET /v1/admin/bridge-link` 向平台要凭据，自动完成并备份原值）：

```json
{
  "wsUrl": "ws://127.0.0.1:3120/onebot/v11/ws",
  "httpUrl": "http://127.0.0.1:3120/onebot/v11",
  "accessToken": "<data-token 的内容>",
  "viaPlatform": true,
  "followDiscoveredEndpoint": false
}
```

## 接口

完整契约见 [docs/CONTRACT.md](docs/CONTRACT.md)。

## 测试

```bash
npm test          # 离线：假 SnowLuma + 真实 @snowluma/sdk 客户端（在 qq-bridge 仓库内运行时可用）
npm run bench     # 直连 vs 经平台的相对开销（同进程，非交付承诺）
```
