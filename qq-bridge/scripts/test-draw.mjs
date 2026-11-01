// 自检：判定矩阵、配额、队列串行、runner 健康、路径白名单
// 用法：node scripts/test-draw.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkDrawPolicy, sceneOf, quotaTierOf } from '../src/draw/policy.js';
import { createQuotaStore } from '../src/draw/quota.js';
import { createSerialQueue } from '../src/draw/queue.js';
import { isPathInside, createSendImageHandler } from '../src/draw/send-image.js';
import { loadPresets, allowedPresets } from '../src/draw/presets.js';
import { createRunner } from '../src/draw/runner.js';

let pass = 0;
const t = (name, fn) => {
  fn();
  pass += 1;
  console.log(`  ✓ ${name}`);
};

console.log('policy');
t('群聊不放行汐的 NSFW', () => {
  const r = checkDrawPolicy({ scene: 'group', character: 'xixi', nsfw: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'refuse_xixi_nsfw');
  assert.equal(r.tone, 'shy_angry_tsun');
});
t('主人私聊放行汐的 NSFW', () => {
  assert.equal(checkDrawPolicy({ scene: 'private_owner', character: 'xixi', nsfw: true }).ok, true);
});
t('他人私聊不放行汐的 NSFW', () => {
  assert.equal(checkDrawPolicy({ scene: 'private_other', character: 'xixi', nsfw: true }).ok, false);
});
t('群聊放行路人 NSFW', () => {
  assert.equal(checkDrawPolicy({ scene: 'group', character: 'generic', nsfw: true }).ok, true);
});
t('群聊放行汐的 SFW', () => {
  assert.equal(checkDrawPolicy({ scene: 'group', character: 'xixi', nsfw: false }).ok, true);
});
t('非法角色被拒', () => {
  assert.equal(checkDrawPolicy({ scene: 'group', character: 'xiaoxi', nsfw: false }).ok, false);
});

console.log('scene');
t('group 与 private 解析', () => {
  assert.equal(sceneOf('group:123', '9'), 'group');
  assert.equal(sceneOf('private:9', '9'), 'private_owner');
  assert.equal(sceneOf('private:8', '9'), 'private_other');
  assert.equal(sceneOf('bad', '9'), null);
});
t('配额档位', () => {
  assert.equal(quotaTierOf({ scene: 'private_owner', nsfw: true }), 'owner');
  assert.equal(quotaTierOf({ scene: 'group', nsfw: true }), 'generic_nsfw');
  assert.equal(quotaTierOf({ scene: 'group', nsfw: false }), 'normal');
});

console.log('quota');
t('每人每日上限 + 冷却', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drawq-'));
  let clock = 1_000_000;
  const q = createQuotaStore(dir, { now: () => clock });
  // 普通档：15 张/日、10 分钟冷却
  for (let i = 0; i < 15; i += 1) {
    assert.equal(q.check({ key: 'group:1', userId: 'u1', tier: 'normal' }).ok, true, `第 ${i + 1} 张应放行`);
    q.consume({ key: 'group:1', userId: 'u1' });
    clock += 11 * 60_000;
  }
  const r = q.check({ key: 'group:1', userId: 'u1', tier: 'normal' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'quota_user');
});
t('冷却拦截', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drawq-'));
  let clock = 1_000_000;
  const q = createQuotaStore(dir, { now: () => clock });
  q.consume({ key: 'group:1', userId: 'u2' });
  const r = q.check({ key: 'group:1', userId: 'u2', tier: 'normal' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'cooldown');
  assert.ok(r.waitMs > 0);
});
t('any:nsfw 档更紧（3 张 / 30 分钟）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drawq-'));
  let clock = 1_000_000;
  const q = createQuotaStore(dir, { now: () => clock });
  for (let i = 0; i < 3; i += 1) {
    q.consume({ key: 'group:1', userId: 'u3' });
    clock += 31 * 60_000;
  }
  const r = q.check({ key: 'group:1', userId: 'u3', tier: 'generic_nsfw' });
  assert.equal(r.code, 'quota_user');
  assert.equal(r.limit, 3);
});
t('每群每日上限', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drawq-'));
  let clock = 1_000_000;
  const q = createQuotaStore(dir, { now: () => clock });
  for (let i = 0; i < 60; i += 1) {
    q.consume({ key: 'group:7', userId: `u${i}` });
    clock += 1;
  }
  const r = q.check({ key: 'group:7', userId: 'newbie', tier: 'normal' });
  assert.equal(r.code, 'quota_group');
});

console.log('queue');
t('串行执行，最大并发 1', async () => {
  const q = createSerialQueue({ maxDepth: 5, timeoutMs: 5000 });
  let active = 0;
  let maxActive = 0;
  const jobs = [];
  for (let i = 0; i < 4; i += 1) {
    const e = q.push(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active -= 1;
      return { ok: true, i };
    });
    assert.equal(e.accepted, true);
    jobs.push(e.promise);
  }
  const results = await Promise.all(jobs);
  assert.equal(maxActive, 1, `并发应恒为 1，实际 ${maxActive}`);
  assert.ok(results.every((r) => r.ok));
});
t('队列满时拒绝', async () => {
  const q = createSerialQueue({ maxDepth: 1, timeoutMs: 5000 });
  const first = q.push(() => new Promise((r) => setTimeout(() => r({ ok: true }), 50)));
  assert.equal(first.accepted, true);
  const second = q.push(() => ({ ok: true }));
  const third = q.push(() => ({ ok: true }));
  assert.equal(third.accepted, false);
  assert.equal(third.code, 'queue_full');
  await first.promise;
  await second.promise;
});

console.log('send-image');
t('路径白名单', () => {
  const root = 'D:\\deepseek_workspace\\outputs\\qq';
  assert.equal(isPathInside(root, 'D:\\deepseek_workspace\\outputs\\qq\\a\\b.png'), true);
  assert.equal(isPathInside(root, 'D:\\deepseek_workspace\\outputs\\qq\\..\\secret.txt'), false);
  assert.equal(isPathInside(root, 'D:\\Windows\\win.ini'), false);
});
t('处理函数：非法扩展名/不存在文件被拒', async () => {
  const root = mkdtempSync(join(tmpdir(), 'drawimg-'));
  mkdirSync(join(root, 'sub'), { recursive: true });
  writeFileSync(join(root, 'sub', 'ok.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  const handler = createSendImageHandler({
    allowRoot: root,
    sendGroupImage: async () => {},
    sendPrivateImage: async () => {},
    guardKey: () => true,
  });
  assert.equal((await handler({ key: 'group:1', path: join(root, 'sub', 'ok.png') })).ok, true);
  assert.equal((await handler({ key: 'group:1', path: join(root, 'sub', 'nope.png') })).code, 'not_found');
  assert.equal((await handler({ key: 'group:1', path: 'D:\\Windows\\win.ini' })).code, 'path_not_allowed');
  assert.equal((await handler({ key: 'weird:1', path: join(root, 'sub', 'ok.png') })).code, 'bad_key');
});

console.log('presets + runner');
t('预设表可加载，群聊清单不含汐的 NSFW', () => {
  const { presets, names } = loadPresets();
  assert.ok(names.length >= 10, `预设太少：${names.length}`);
  const groupList = allowedPresets(presets, 'group');
  assert.equal(groupList.some((p) => p.character === 'xixi' && p.nsfw), false);
  const ownerList = allowedPresets(presets, 'private_owner');
  assert.equal(ownerList.some((p) => p.character === 'xixi' && p.nsfw), true);
});
t('runner 健康检查', () => {
  const r = createRunner({});
  const h = r.health();
  assert.equal(h.scriptExists, true);
  assert.equal(h.presetsOk, true);
});

console.log(`\n全部通过：${pass} 项`);
