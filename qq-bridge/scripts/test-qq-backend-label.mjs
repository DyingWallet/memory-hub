// 桥接日志里 QQ 后端的称呼（src/lib/qq-backend-label.js）离线测试：经接口平台时不再一律写「SnowLuma」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { qqBackendFromVersionInfo, qqBackendLabel } from '../src/lib/qq-backend-label.js';

const root = fileURLToPath(new URL('..', import.meta.url));

test('从 get_version_info 认出后端', () => {
  assert.deepEqual(qqBackendFromVersionInfo({ app_name: 'NapCat.Onebot', app_version: '4.18.38' }), { name: 'NapCat', version: '4.18.38' });
  assert.deepEqual(qqBackendFromVersionInfo({ app_name: 'SnowLuma', app_version: '1.14.22' }), { name: 'SnowLuma', version: '1.14.22' });
  assert.deepEqual(qqBackendFromVersionInfo({ app_name: 'OtherBot' }), { name: 'OtherBot', version: null });
  assert.deepEqual(qqBackendFromVersionInfo(null), { name: null, version: null });
});

test('称呼：经接口平台写「QQ 后端（经接口平台 · NapCat 版本）」；直连 SnowLuma 仍写 SnowLuma', () => {
  assert.equal(qqBackendLabel({ viaPlatform: true, backend: { name: 'NapCat', version: '4.18.38' } }), 'QQ 后端（经接口平台 · NapCat 4.18.38）');
  assert.equal(qqBackendLabel({ viaPlatform: true, backend: null }), 'QQ 后端（经接口平台）', '还不知道后端时不猜');
  assert.equal(qqBackendLabel({ viaPlatform: true, backend: { name: 'SnowLuma', version: null } }), 'QQ 后端（经接口平台 · SnowLuma）');
  assert.equal(qqBackendLabel({ viaPlatform: false, backend: null }), 'SnowLuma');
  assert.equal(qqBackendLabel({ viaPlatform: false, backend: { name: 'SnowLuma', version: '1.14.22' } }), 'SnowLuma 1.14.22');
  assert.equal(qqBackendLabel({ viaPlatform: false, backend: { name: 'NapCat', version: '4.18.38' } }), 'QQ 后端（NapCat 4.18.38）', '直连 NapCat 也不叫 SnowLuma');
});

test('桥接接线：连上 / 断开的日志用称呼函数，不再写死「SnowLuma 已连接」', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8');
  assert.ok(!/log\(`SnowLuma 已连接/.test(src));
  assert.ok(!/log\(`SnowLuma 连接断开/.test(src));
  assert.match(src, /log\(`\$\{backendLabelNow\(\)\} 已连接：/);
  assert.match(src, /log\(`\$\{backendLabelNow\(\)\} 连接断开/);
  assert.match(fs.readFileSync(path.join(root, 'src', 'bridge-extensions.js'), 'utf8'), /qq-backend-label\.js/);
});
