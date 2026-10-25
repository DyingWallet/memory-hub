// v0.4.2 回归：管理员私聊托付群会话（方案 C）。
// 只有管理员私聊的会话能托付；目标必须是白名单群；开关默认关闭；有限频；托付只交给目标群自己的会话，
// 不改变「会话令牌只能发到自己的会话」这条隔离。全部用假数据，不连 QQ/DSH。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ownerRelayConfig, validateOwnerRelay, createOwnerRelayLimiter, createOwnerRelayStore,
  ownerRelayPromptBlock, ownerRelayResultText,
} from '../src/social/owner-relay.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'private:10001';
const ALLOWED_GROUP = '20002';
const base = {
  fromKey: OWNER,
  tokenOk: true,
  isOwnerPrivateKey: (k) => k === OWNER,
  isTargetAllowed: (k) => k === `group:${ALLOWED_GROUP}`,
  enabled: true,
  targetGroupId: ALLOWED_GROUP,
  instruction: '在群里随便冒个泡',
  maxChars: 300,
};

test('合法托付：管理员私聊 → 白名单群', () => {
  const r = validateOwnerRelay(base);
  assert.equal(r.ok, true);
  assert.equal(r.targetKey, `group:${ALLOWED_GROUP}`);
  assert.equal(r.instruction, '在群里随便冒个泡');
});

test('拒绝：开关关闭 / 令牌不对 / 非管理员私聊 / 群会话发起 / 白名单外 / 非群号 / 超长 / 空内容', () => {
  assert.match(validateOwnerRelay({ ...base, enabled: false }).error, /未启用/);
  assert.match(validateOwnerRelay({ ...base, tokenOk: false }).error, /token/);
  assert.match(validateOwnerRelay({ ...base, fromKey: 'private:30003' }).error, /只有管理员/);
  assert.match(validateOwnerRelay({ ...base, fromKey: `group:${ALLOWED_GROUP}` }).error, /只有管理员/, '群会话不能托付别的群（防群内提示词注入）');
  assert.match(validateOwnerRelay({ ...base, targetGroupId: '40004' }).error, /白名单/);
  assert.match(validateOwnerRelay({ ...base, targetGroupId: 'abc' }).error, /群号/);
  assert.match(validateOwnerRelay({ ...base, targetGroupId: 'group:20002' }).error, /群号/);
  assert.match(validateOwnerRelay({ ...base, instruction: 'x'.repeat(301) }).error, /300/);
  assert.match(validateOwnerRelay({ ...base, instruction: '   ' }).error, /不能为空/);
  // 开关检查在身份检查之前也无妨，但令牌检查必须最先：不给无效令牌任何信息。
  assert.match(validateOwnerRelay({ ...base, tokenOk: false, enabled: false }).error, /token/);
});

test('限频：全局与单群上限，一小时后恢复', () => {
  let t = 0;
  const lim = createOwnerRelayLimiter({ now: () => t });
  const cfg = { maxPerHour: 3, maxPerTargetPerHour: 2 };
  assert.equal(lim.take('group:1', cfg), null);
  assert.equal(lim.take('group:1', cfg), null);
  assert.match(lim.take('group:1', cfg), /这个群/);
  assert.equal(lim.take('group:2', cfg), null);
  assert.match(lim.take('group:3', cfg), /每小时 3 次/);
  t = 3600_000;
  assert.equal(lim.take('group:1', cfg), null);
});

test('待办：peek 不取走、take 取走、过期丢弃、每群有上限', () => {
  let t = 0;
  const store = createOwnerRelayStore({ now: () => t, maxPerKey: 2 });
  store.add('group:1', 'a', 1000);
  assert.equal(store.peek('group:1').length, 1);
  assert.equal(store.peek('group:1').length, 1, 'peek 不会消耗（唤醒提示词会构建两次）');
  assert.deepEqual(store.take('group:1').map((x) => x.instruction), ['a']);
  assert.equal(store.peek('group:1').length, 0);
  store.add('group:1', 'b', 1000);
  t = 2000;
  assert.equal(store.has('group:1'), false, '过期丢弃');
  store.add('group:1', 'c', 1000); store.add('group:1', 'd', 1000); store.add('group:1', 'e', 1000);
  assert.deepEqual(store.peek('group:1').map((x) => x.instruction), ['d', 'e']);
});

test('提示词与返回文案：标明来源、不让原样转发、不让模型谎称已发出', () => {
  const block = ownerRelayPromptBlock([{ instruction: '冒个泡' }]);
  assert.match(block, /管理员托付/);
  assert.match(block, /不是群友消息/);
  assert.match(block, /不要原样复述/);
  assert.match(block, /不要发送会话令牌/);
  assert.equal(ownerRelayPromptBlock([]), '');
  assert.match(ownerRelayResultText('group:1', false), /不要声称已经发出/);
  const c = ownerRelayConfig({ maxChars: -1, notifyOwner: false, maxPerHour: '7' });
  assert.equal(c.maxChars, 300);
  assert.equal(c.maxPerHour, 7);
  assert.equal(c.notifyOwner, false);
});

test('接线：开关默认关闭、MCP 仅显式 true 才注册、端点不复用目标群令牌', () => {
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  const mcp = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  assert.equal(example.socialV2.tools.ownerRelay, false, '模板默认关闭');
  assert.ok(/ownerRelay: false/.test(bridge), '桥接运行时默认关闭');
  assert.ok(bridge.includes('enabled: cfg.socialV2?.tools?.ownerRelay === true'), '端点要求显式 true');
  assert.ok(mcp.includes("if (cfg.socialV2?.tools?.ownerRelay === true) {"), 'MCP 只在显式 true 时注册');
  // 端点的令牌校验针对发起方 key（管理员私聊），并且唤醒的是目标群自己的会话，而不是直接发送。
  const seg = bridge.slice(bridge.indexOf("url.pathname === '/api/socialV2/owner-relay'"), bridge.indexOf('// ── v0.3.0 控制台（管理端专用'));
  assert.ok(seg.includes('agentTokenOk(key, agentToken)'), '令牌只和发起方会话比对');
  assert.ok(seg.includes("scheduleWakeV2(check.targetKey, 'ownerRelay')"), '交给目标群会话自己处理');
  assert.ok(!/sendGroupMessage|sendToQQ\(/.test(seg), '端点本身不直接往群里发消息');
  assert.ok(seg.includes('ext.audit.append'), '记审计');
});
