# 语音发送说明（VOICE）

> 本文是 v0.3.0 补充的公开版说明。原仓库的同名文档含开发机路径，被 `.gitignore` 排除，
> 但 `scripts/test-voice-system.mjs` 要求它存在，所以这里提供一份不含任何本机信息的版本。

## 两种发语音的方式

| 方式 | 谁在用 | 默认 |
| --- | --- | --- |
| AI 工具 `qq_send_voice` / `qq_list_voices` | 二代仿真（reserved2）里的 AI | **默认是关的**：`socialV2.tools.sendVoice=false` 且 `socialV2.voice.enabled=false` |
| 独立「发语音」工具 `voice-tool/` | 你本人（命令行或图形界面） | 需要单独放置，不在本仓库内 |

### AI 发语音（默认关闭）

1. 把音频文件放进语音库目录（`socialV2.voice.dir`，默认仓库下的 `audio/`，该目录不入库）。
2. 在 `config.json` 里同时打开 `socialV2.voice.enabled=true` 与 `socialV2.tools.sendVoice=true`，重启 DSH 让工具清单刷新。
3. AI 只能发送语音库里的文件：不接受任意本地路径、URL 或 base64（防止提示注入把本机文件当语音外发）。
   时长、体积、频率另有独立上限（`socialV2.voice.maxSeconds / maxBytes / maxPerMinute / maxPerHour`）。

### 独立发语音工具（可选）

`voice-tool/` 是从桥接拆出来的独立工具，放在仓库**上一级**目录（`../voice-tool/`），不随本仓库发布：

- 命令行：`node voice-cli.mjs`（交互菜单 / `send` / `list` / `check`）
- 图形界面：`node voice-gui.mjs`（只监听 127.0.0.1，带一次性令牌）；工作区根目录的 `发语音-图形界面.cmd` 是它的双击启动器

没有这个目录时，`npm run voice-gui` / `npm run voice-cli` 会失败，相关测试会自动跳过 —— 这不影响桥接本身。

## 音量

`socialV2.voice.defaultVolume` / `loudness` 控制默认音量与响度归一；调整依赖 ffmpeg（`socialV2.voice.ffmpegPath` 或系统 PATH）。
