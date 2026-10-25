// QQ 连接器：NapCat（OneBot v11 正向 WebSocket）。只连接用户自己安装并运行的 NapCat，不安装、不启停、不修改它。
// NapCat 官方支持 macOS（12+，Intel / Apple Silicon）、Windows 与 Linux，是 Mac 上接入 QQ 的候选后端。
// 账号发现：<NapCat 配置目录>/onebot11_<QQ>.json 的 network.websocketServers（见 discovery.mjs）。
//
// 与 SnowLuma 的已知差异（按 NapCat v4.18.38 源码）：令牌错误时先接受连接、回 retcode 1403 再断开；
// 心跳间隔取各自配置（heartInterval，默认 30 秒）；扩展动作集合不同 —— 统一接口只依赖 OneBot v11 标准动作，
// 扩展动作经透传，是否支持以 NapCat 的实际回执为准，不以 SnowLuma 的清单推断。

import { createOneBotWsConnector, oneBotCapabilities } from '../onebot-v11/connector.mjs';
import { cap } from '../../core/model.mjs';
import { discoverNapCatEndpoints } from './discovery.mjs';

export const PROVIDER = {
  id: 'napcat',
  platform: 'qq',
  name: 'NapCat（OneBot v11）',
  available: true,
  management: ['external', 'remote'],
  os: ['darwin', 'win32', 'linux'],
  note: '连接用户自己安装并运行的 NapCat（macOS / Windows / Linux）。需要在 NapCat 里开启一个 WebSocket 服务端（websocketServers）。接口平台不安装、不启停 NapCat；其许可条款由使用者自行遵守。',
};

export const capabilities = () => oneBotCapabilities({
  'ext.qq.onebot': cap(true, { note: '过渡兼容层：OneBot v11 动作透传。NapCat 的扩展动作与 SnowLuma 不同，以实际回执为准' }),
});

export function createNapCatConnector(deps) {
  return createOneBotWsConnector({ provider: PROVIDER, discover: discoverNapCatEndpoints, capabilities, ...deps });
}
