// QQ 连接器：SnowLuma（OneBot v11 正向 WebSocket）。只连接用户自己运行的 SnowLuma，不启停它的进程。
// 账号发现：<SnowLuma>/config/onebot_<QQ>.json 的 networks.wsServers[0]（见 discovery.mjs）。

import { createOneBotWsConnector, oneBotCapabilities } from '../onebot-v11/connector.mjs';
import { discoverWsEndpoints } from './discovery.mjs';

export const PROVIDER = {
  id: 'snowluma',
  platform: 'qq',
  name: 'SnowLuma（OneBot v11）',
  available: true,
  management: ['external', 'remote'],
  os: ['win32', 'linux'], // 2.0 起正式支持 Linux x64 / arm64
  note: '连接用户自己运行的 SnowLuma（Windows / Linux 版）；启停 SnowLuma 进程只能由用户在控制中心亲手点击（不经接口平台）。',
};

export const capabilities = () => oneBotCapabilities();

export function createSnowLumaConnector(deps) {
  return createOneBotWsConnector({ provider: PROVIDER, discover: discoverWsEndpoints, capabilities, ...deps });
}
