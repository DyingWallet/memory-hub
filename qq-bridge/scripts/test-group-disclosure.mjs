// 跨场景披露 + 持久化成员表的回归测试（不依赖 QQ / 不联网）。
//
//   node scripts/test-group-disclosure.mjs
//
// 覆盖：意图识别、多群歧义、成员校验（含缓存刷新与 fail-closed）、事件增减、限流、格式化。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGroupMemberStore } from '../src/group-members.js';
import {
  createDisclosureService,
  detectDisclosureIntent,
  formatDisclosureBlock,
  pickGroup,
} from '../src/group-disclosure.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'group-members-'));
const file = path.join(tmp, 'group-members.json');
const quiet = { info: () => undefined, warn: () => undefined };

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}\n     ${error?.message ?? error}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}\n     ${error?.message ?? error}`);
  }
}

// ── 意图 ────────────────────────────────────────────────────────────────
check('识别「群里聊了什么」', () => {
  assert.deepEqual(detectDisclosureIntent('刚才群里聊了什么'), {});
  assert.deepEqual(detectDisclosureIntent('昨天群里有啥有意思的事'), {});
  assert.equal(detectDisclosureIntent('中午吃什么'), null);
  assert.equal(detectDisclosureIntent('我们私聊聊了什么'), null);
});

// ── 选群 ────────────────────────────────────────────────────────────────
check('点名优先', () => {
  assert.deepEqual(pickGroup({ text: '123456789 群聊了啥', candidates: ['123456789', '111'], memberOf: ['111'] }), {
    kind: 'named',
    groupId: '123456789',
  });
});

check('多群且没点名 → ambiguous', () => {
  assert.deepEqual(pickGroup({ text: '群里聊了啥', candidates: ['1', '2'], memberOf: ['1', '2'] }), {
    kind: 'ambiguous',
    candidates: ['1', '2'],
  });
});

check('只在一个群 → unique', () => {
  assert.deepEqual(pickGroup({ text: '群里聊了啥', candidates: ['1', '2'], memberOf: ['2'] }), { kind: 'unique', groupId: '2' });
});

// ── 成员表 ──────────────────────────────────────────────────────────────
const store = createGroupMemberStore({ file, maxAgeMs: 60_000, now: () => Date.now(), logger: quiet });
const fetchCalls = [];
const fetchMemberIds = async (gid) => {
  fetchCalls.push(gid);
  return gid === '123456789' ? ['10002', '10003', '70903'] : ['10003'];
};

await checkAsync('首次校验会拉一次成员表', async () => {
  const verdict = await store.verifyMember('123456789', '10002', fetchMemberIds);
  assert.equal(verdict.member, true);
  assert.equal(fetchCalls.length, 1);
});

await checkAsync('缓存期内不再拉取', async () => {
  const verdict = await store.verifyMember('123456789', '10003', fetchMemberIds);
  assert.equal(verdict.member, true);
  assert.equal(fetchCalls.length, 1, '第二次应命中缓存');
});

check('非成员被拒', () => {
  assert.equal(store.isMember('123456789', '99999'), false);
});

check('join 事件把人加进来', () => {
  store.applyNotice({ groupId: '123456789', userId: '10009', kind: 'join' });
  assert.equal(store.isMember('123456789', '10009'), true);
});

check('leave 事件把人移出', () => {
  store.applyNotice({ groupId: '123456789', userId: '10002', kind: 'leave' });
  assert.equal(store.isMember('123456789', '10002'), false);
});

check('持久化：新实例读得到同一份数据', () => {
  const reopened = createGroupMemberStore({ file, maxAgeMs: 60_000, logger: quiet });
  assert.equal(reopened.isMember('123456789', '10009'), true);
  assert.equal(reopened.isMember('123456789', '10002'), false);
});

check('groupsOf 列出某人所在的群', () => {
  assert.deepEqual(store.groupsOf('10003').sort(), ['123456789']);
});

await checkAsync('拉取失败时 fail-closed（不拿旧缓存放行）', async () => {
  const broken = createGroupMemberStore({ file: path.join(tmp, 'broken.json'), maxAgeMs: 0, logger: quiet });
  const verdict = await broken.verifyMember('123456789', '10002', async () => {
    throw new Error('gateway down');
  });
  assert.equal(verdict.member, false);
  assert.match(verdict.reason ?? '', /gateway down/);
});

// ── 每日对账 ────────────────────────────────────────────────────────────
await checkAsync('refreshAll：一次刷完所有群，报成员数', async () => {
  const daily = createGroupMemberStore({ file: path.join(tmp, 'daily.json'), maxAgeMs: 24 * 3600e3, logger: quiet });
  const result = await daily.refreshAll(['123456789', '222222'], fetchMemberIds, { force: true });
  assert.deepEqual(result.failed, []);
  assert.deepEqual(
    result.refreshed.map((item) => [item.groupId, item.members]).sort(),
    [
      ['123456789', 3],
      ['222222', 1],
    ],
  );
});

await checkAsync('refreshAll：单个群失败不影响其它群', async () => {
  const daily = createGroupMemberStore({ file: path.join(tmp, 'daily2.json'), maxAgeMs: 24 * 3600e3, logger: quiet });
  const result = await daily.refreshAll(['123456789', '333333'], async (gid) => {
    if (gid === '333333') throw new Error('boom');
    return ['10003'];
  }, { force: true });
  assert.deepEqual(result.refreshed.map((item) => item.groupId), ['123456789']);
  assert.deepEqual(result.failed.map((item) => item.groupId), ['333333']);
});

await checkAsync('refreshAll：force=false 时只刷过期/缺失的群', async () => {
  let clock = 1_000_000;
  const daily = createGroupMemberStore({ file: path.join(tmp, 'daily3.json'), maxAgeMs: 24 * 3600e3, now: () => clock, logger: quiet });
  const calls = [];
  await daily.refreshAll(['123456789'], async (gid) => {
    calls.push(gid);
    return ['10003'];
  }, { force: true });
  assert.equal(calls.length, 1);
  // 没过期：不再拉
  const second = await daily.refreshAll(['123456789'], async (gid) => {
    calls.push(gid);
    return ['10003'];
  });
  assert.equal(calls.length, 1, '未过期不应重拉');
  assert.equal(second.refreshed[0]?.source, 'cache');
  // 过期：重拉
  clock += 24 * 3600e3 + 1000;
  const third = await daily.refreshAll(['123456789'], async (gid) => {
    calls.push(gid);
    return ['10003', '10004'];
  });
  assert.equal(calls.length, 2, '过期后应重拉');
  assert.equal(third.refreshed[0]?.members, 2);
});

// ── 披露服务 ────────────────────────────────────────────────────────────
const items = [
  { id: 'c1', updated_at: new Date().toISOString(), render: { text: '中午吃什么，投票' } },
  { id: 'c2', updated_at: new Date().toISOString(), render: { text: '我投火锅' } },
];

function makeService(overrides = {}) {
  const calls = [];
  const service = createDisclosureService({
    store,
    fetchMemberIds,
    fetchDisclose: async (gid) => {
      calls.push({ gid });
      return items;
    },
    logger: quiet,
    cooldownMs: 0,
    ...overrides,
  });
  return { service, calls };
}

await checkAsync('成员提问 → 拿到披露块', async () => {
  const { service, calls } = makeService();
  const result = await service.run({ text: '刚才群里聊了什么', senderQQ: '10003', candidates: ['123456789'] });
  assert.equal(result.reason, 'ok');
  assert.match(result.block, /群消息披露/);
  assert.match(result.block, /中午吃什么/);
  assert.equal(calls.length, 1);
});

await checkAsync('非成员提问 → 不披露', async () => {
  const { service, calls } = makeService();
  const result = await service.run({ text: '刚才群里聊了什么', senderQQ: '99999', candidates: ['123456789'] });
  assert.equal(result.block, '');
  assert.equal(result.reason, 'not-a-member');
  assert.equal(calls.length, 0);
});

await checkAsync('多群且在多个群里 → 让模型问清楚，不猜', async () => {
  store.set('222222', ['10003'], 'fetch');
  const { service, calls } = makeService();
  const result = await service.run({ text: '刚才群里聊了什么', senderQQ: '10003', candidates: ['123456789', '222222'] });
  assert.equal(result.block, '');
  assert.equal(result.reason, 'ambiguous');
  assert.equal(calls.length, 0);
});

await checkAsync('点名某个群 → 即使他也在别的群也只查那个', async () => {
  const { service, calls } = makeService();
  const result = await service.run({ text: '222222 群里聊了什么', senderQQ: '10003', candidates: ['123456789', '222222'] });
  assert.equal(result.reason, 'ok');
  assert.equal(calls[0]?.gid, '222222');
});

await checkAsync('限流：冷却期内重复提问不再披露', async () => {
  const { service, calls } = makeService({ cooldownMs: 60_000 });
  await service.run({ text: '群里聊了什么', senderQQ: '10003', candidates: ['123456789'] });
  const second = await service.run({ text: '群里聊了什么', senderQQ: '10003', candidates: ['123456789'] });
  assert.equal(second.reason, 'cooldown');
  assert.equal(calls.length, 1);
});

await checkAsync('memd 调用失败 → 不披露也不抛错', async () => {
  const { service } = makeService({
    fetchDisclose: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  const result = await service.run({ text: '群里聊了什么', senderQQ: '10003', candidates: ['123456789'] });
  assert.equal(result.block, '');
  assert.match(result.reason, /disclose-failed/);
});

check('格式化：空结果也给出明确说明', () => {
  const block = formatDisclosureBlock({ groupId: '123456789', items: [] });
  assert.match(block, /没有可披露的消息/);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? '\nall disclosure checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
