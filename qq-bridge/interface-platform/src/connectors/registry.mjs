// 已知提供方。只有 available: true 的可以创建实例；其余在界面上标「尚未提供」，不得展示成可用连接器。

import { PROVIDER as SNOWLUMA, createSnowLumaConnector } from './qq-snowluma/index.mjs';
import { PROVIDER as NAPCAT, createNapCatConnector } from './qq-napcat/index.mjs';

export const PROVIDERS = [
  SNOWLUMA,
  NAPCAT,
  { id: 'qq-mac-native', platform: 'qq', name: 'macOS 本机 QQ 接入', available: false, note: 'M3：Mac 原生接入，研究中，尚未提供' },
  { id: 'discord-official', platform: 'discord', name: 'Discord 官方 API', available: false, note: '尚未提供' },
  { id: 'kook-official', platform: 'kook', name: 'KOOK 官方 API', available: false, note: '尚未提供' },
  { id: 'wechat', platform: 'wechat', name: 'WeChat', available: false, note: '接入方式未选定，尚未提供' },
];

const FACTORIES = { snowluma: createSnowLumaConnector, napcat: createNapCatConnector };

export function createConnector(instance, deps) {
  const f = FACTORIES[instance.provider];
  if (!f) throw new Error(`提供方「${instance.provider}」尚未提供`);
  return f({ instance, ...deps });
}
