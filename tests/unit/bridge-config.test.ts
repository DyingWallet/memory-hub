import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBridge } from '@memsvc/server/config';

const DEFAULT_PROBE = 'http://127.0.0.1:3100/';

test('normalizeBridge 默认关闭，只认明确写 true 的开关', () => {
  const off = normalizeBridge(undefined, {});
  assert.equal(off.enabled, false, '没有配置时必须是关的');
  assert.equal(off.retryMinutes, 10);
  assert.equal(off.startTimeoutSeconds, 20);
  assert.equal(off.probeUrl, DEFAULT_PROBE);

  // 手滑写成字符串不能把它打开（否则每分钟都在重启桥接）。
  const sloppy = normalizeBridge(undefined, { enabled: 'yes' as unknown as boolean });
  assert.equal(sloppy.enabled, false, '非布尔 true 一律当没开');

  assert.equal(normalizeBridge(undefined, { enabled: true }).enabled, true);
});

test('normalizeBridge 把越界配置夹回安全区间', () => {
  const config = normalizeBridge(undefined, {
    retryMinutes: 0,
    startTimeoutSeconds: 9999,
    probeUrl: '   ',
  });
  assert.equal(config.retryMinutes, 1, '退避最短 1 分钟');
  assert.equal(config.startTimeoutSeconds, 120, '等待上限 120 秒');
  assert.equal(config.probeUrl, DEFAULT_PROBE, '空白探活地址退回默认值');
});
