// 管理员私聊跨群只读 + 群长期规则（socialV2.tools.ownerGroupAccess，默认关闭）离线测试。全部假数据。
//   ① 纯逻辑：发起方/目标校验、规则增删与上限、恢复时清洗、提示词、只读视图不带内部状态
//   ② 接线（静态）：默认关闭、端点与 MCP 都要求显式 true、规则注入记忆摘要
//   ③ 集成（真实 bridge.js 夹具）：只有 owner 私聊能用；白名单外的群不行；查看不改目标已读；
//      设规则后落盘、并出现在目标群的唤醒提示词里；私聊令牌仍不能直接往群里发
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { validateOwnerGroupAccess, normalizeRules, addRule, removeRule, rulesPromptBlock, peekView, GROUP_RULE_LIMITS } from '../src/social/group-rules.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 123;      // 夹具里的 ownerQQ
const GROUP = 456;      // 夹具白名单群
const GROUP2 = 789;     // 白名单外
const QUESTION_RULE = '用问号怼人时，先单独发一条只有「？」的消息，再把后面的话作为下一条发';

const base = { tokenOk: true, isOwnerPrivateKey: (k) => k === `private:${OWNER}`, isTargetAllowed: (k) => k === `group:${GROUP}`, enabled: true };

test('校验：令牌、开关、只有 owner 私聊、群号格式、白名单', () => {
  assert.equal(validateOwnerGroupAccess({ ...base, fromKey: `private:${OWNER}`, targetGroupId: String(GROUP) }).targetKey, `group:${GROUP}`);
  assert.match(validateOwnerGroupAccess({ ...base, tokenOk: false, fromKey: `private:${OWNER}`, targetGroupId: GROUP }).error, /token/);
  assert.match(validateOwnerGroupAccess({ ...base, enabled: false, fromKey: `private:${OWNER}`, targetGroupId: GROUP }).error, /未启用/);
  assert.match(validateOwnerGroupAccess({ ...base, fromKey: `group:${GROUP}`, targetGroupId: GROUP }).error, /管理员本人的私聊/);
  assert.match(validateOwnerGroupAccess({ ...base, fromKey: 'private:999', targetGroupId: GROUP }).error, /管理员本人的私聊/);
  assert.equal(validateOwnerGroupAccess({ ...base, fromKey: `private:${OWNER}`, targetGroupId: 'abc' }).status, 400);
  assert.equal(validateOwnerGroupAccess({ ...base, fromKey: `private:${OWNER}`, targetGroupId: '0123' }).status, 400);
  assert.match(validateOwnerGroupAccess({ ...base, fromKey: `private:${OWNER}`, targetGroupId: GROUP2 }).error, /白名单/);
});

test('规则：新增、同文去重、字数与条数上限、按编号删除、空内容拒绝', () => {
  let r = addRule([], `  ${QUESTION_RULE}  `, { now: 1 });
  assert.equal(r.rule.id, 1);
  assert.equal(r.rule.text, QUESTION_RULE, '首尾空白被去掉');
  const dup = addRule(r.rules, QUESTION_RULE);
  assert.equal(dup.duplicate, true);
  assert.equal(dup.rules.length, 1);
  assert.match(addRule([], '').error, /不能为空/);
  assert.match(addRule([], 'x'.repeat(GROUP_RULE_LIMITS.maxChars + 1)).error, /不能超过/);
  let rules = [];
  for (let i = 0; i < GROUP_RULE_LIMITS.maxRules; i++) rules = addRule(rules, `规则${i}`).rules;
  assert.match(addRule(rules, '再来一条').error, /上限/);
  const rm = removeRule(rules, 3);
  assert.equal(rm.removed.text, '规则2');
  assert.equal(rm.rules.length, GROUP_RULE_LIMITS.maxRules - 1);
  assert.equal(addRule(rm.rules, '新的').rule.id, GROUP_RULE_LIMITS.maxRules + 1, '编号不复用');
  assert.match(removeRule(rules, 999).error, /没有编号/);
});

test('恢复：坏条目丢弃、重复编号去掉、非数组当空', () => {
  assert.deepEqual(normalizeRules(null), []);
  assert.deepEqual(normalizeRules([{ id: 1, text: 'a' }, { id: 1, text: 'b' }, { id: 'x', text: 'c' }, { id: 2, text: '  ' }, { id: 3, text: 'd', at: 5 }]).map((r) => [r.id, r.text]), [[1, 'a'], [3, 'd']]);
});

test('提示词：标明来源与必须遵守；无规则时为空', () => {
  assert.equal(rulesPromptBlock([]), '');
  const b = rulesPromptBlock([{ id: 1, text: QUESTION_RULE }]);
  assert.match(b, /管理员为本群设定的长期规则/);
  assert.match(b, /不是群友说的/);
  assert.ok(b.includes(`1. ${QUESTION_RULE}`));
});

test('只读视图：只带需要的字段、不带令牌等内部状态、条数有上限', () => {
  const st = { agentToken: 'SECRET-TOKEN', recentMessages: Array.from({ length: 80 }, (_, i) => ({ seq: i, time: 1000 + i, sender: `群友${i}`, userId: 10000 + i, text: `消息${i}`, plain: `消息${i}`, isSelf: i === 79 })), ownerRules: [{ id: 1, text: QUESTION_RULE }] };
  const v = peekView(st, { limit: 999, memoryText: '【对群友的印象】' });
  assert.equal(v.messages.length, GROUP_RULE_LIMITS.peekMax);
  assert.equal(v.messages.at(-1).sender, '（我）');
  assert.equal(v.rules[0].text, QUESTION_RULE);
  assert.ok(!JSON.stringify(v).includes('SECRET-TOKEN'), '视图里没有令牌');
  assert.equal(peekView(st, {}).messages.length, 20, '默认 20 条');
});

test('接线：默认关闭、端点与 MCP 都要求显式 true、规则注入记忆摘要、群会话自己的清记忆工具碰不到规则', () => {
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  const mcp = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  assert.equal(example.socialV2.tools.ownerGroupAccess, false, '模板默认关闭');
  assert.equal((bridge.match(/ownerGroupAccess: false/g) ?? []).length, 2, '桥接两处运行时默认都是关闭');
  assert.ok(bridge.includes('enabled: cfg.socialV2?.tools?.ownerGroupAccess === true'), '端点要求显式 true');
  assert.ok(mcp.includes('if (cfg.socialV2?.tools?.ownerGroupAccess === true) {'), 'MCP 只在显式 true 时注册');
  const fmt = bridge.slice(bridge.indexOf('function formatMemoryV2(st) {'), bridge.indexOf('function appendMemoryV2('));
  assert.ok(fmt.includes('rulesPromptBlock(st.ownerRules)'), '记忆摘要（每次唤醒注入）带上规则');
  const seg = bridge.slice(bridge.indexOf("url.pathname === '/api/socialV2/owner-peek'"), bridge.indexOf('// ── v0.3.0 控制台（管理端专用'));
  assert.ok(seg.includes('agentTokenOk(key, agentToken)'), '令牌只和发起方会话比对');
  assert.ok(!seg.includes('noteModelMessagesV2'), '查看不标记目标群已读');
  assert.ok(!/sendGroupMessage|sendToQQ\(|scheduleWakeV2/.test(seg), '端点不发消息、不唤醒目标群');
  const clear = bridge.slice(bridge.indexOf("url.pathname === '/api/socialV2/memory-clear'"), bridge.indexOf("url.pathname === '/api/socialV2/slang/query'"));
  assert.ok(!clear.includes('ownerRules'), '群会话的 qq_memory_clear 不会清掉管理员规则');
});

function request(server, method, route, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: route, method,
      headers: { 'x-console-token': 'fixture-console-token', ...(data ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch {} resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('集成（真实 bridge.js 夹具）：权限边界、只读、规则落盘并注入目标群唤醒提示词', async () => {
  const h = await bridgeHarness();
  try {
    await h.initControllerOnce('reserved2');
    h.setMode('reserved2');
    h.cfg.allow.private = [String(OWNER)];
    const ownerSt = h.getSocialV2State(`private:${OWNER}`);
    const groupSt = h.getSocialV2State(`group:${GROUP}`);
    h.appendSocialV2Message(`group:${GROUP}`, '甲', '大家好', '大家好', false, false, '11', [], '20001');
    const server = h.startConsoleServer();
    await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
    try {
      const hdr = (st) => ({ 'x-agent-token': st.agentToken, 'x-agent-call': '1' });
      const peek = (st, from, gid) => request(server, 'GET', `/api/socialV2/owner-peek?key=${encodeURIComponent(from)}&targetGroupId=${gid}`, { headers: hdr(st) });
      const rule = (st, from, gid, body) => request(server, 'POST', '/api/socialV2/group-rule', { body: { key: from, targetGroupId: String(gid), ...body }, headers: hdr(st) });

      assert.equal((await peek(ownerSt, `private:${OWNER}`, GROUP)).status, 403, '默认关闭');
      h.cfg.socialV2.tools.ownerGroupAccess = true;
      assert.equal((await peek(groupSt, `group:${GROUP}`, GROUP)).status, 403, '群会话不能用');
      assert.equal((await peek(groupSt, `private:${OWNER}`, GROUP)).status, 403, '拿群令牌冒充 owner 私聊 key 不行');
      assert.equal((await peek(ownerSt, `private:${OWNER}`, GROUP2)).status, 403, '白名单外的群不行');
      assert.equal((await request(server, 'GET', `/api/socialV2/owner-peek?key=private:${OWNER}&targetGroupId=${GROUP}`)).status, 403, '没有会话令牌（只有控制台令牌）不行');

      const readBefore = groupSt.lastReadThroughSeq;
      const p = await peek(ownerSt, `private:${OWNER}`, GROUP);
      assert.equal(p.status, 200, JSON.stringify(p.body));
      assert.ok(p.body.messages.some((m) => m.text === '大家好'), '看得到目标群消息');
      assert.ok(!JSON.stringify(p.body).includes(groupSt.agentToken), '不外露目标群令牌');
      assert.equal(groupSt.lastReadThroughSeq, readBefore, '查看不改变目标群的已读进度');

      const add = await rule(ownerSt, `private:${OWNER}`, GROUP, { action: 'add', text: QUESTION_RULE });
      assert.equal(add.status, 200, JSON.stringify(add.body));
      assert.equal(groupSt.ownerRules.length, 1);
      assert.equal((await rule(groupSt, `group:${GROUP}`, GROUP, { action: 'add', text: '群会话自己加' })).status, 403, '群会话不能给自己加规则');
      assert.equal((await rule(ownerSt, `private:${OWNER}`, GROUP, { action: 'add', text: 'token: abcdefg123' })).status, 403, '敏感内容被拦');

      const saved = JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'social-v2.json'), 'utf8'));
      assert.equal(saved.conversations[`group:${GROUP}`].ownerRules[0].text, QUESTION_RULE, '规则落盘');
      const prompt = h.buildWakePromptV2(`group:${GROUP}`, 'question');
      assert.ok(prompt.includes('管理员为本群设定的长期规则') && prompt.includes(QUESTION_RULE), '目标群唤醒提示词里有这条规则');
      assert.ok(!h.buildWakePromptV2(`private:${OWNER}`, 'question').includes(QUESTION_RULE), '规则只注入目标群，不串到私聊');

      const list = await rule(ownerSt, `private:${OWNER}`, GROUP, { action: 'list' });
      assert.equal(list.body.rules[0].id, 1);
      const rm = await rule(ownerSt, `private:${OWNER}`, GROUP, { action: 'remove', ruleId: 1 });
      assert.equal(rm.status, 200);
      assert.equal(groupSt.ownerRules.length, 0);

      // 隔离不变：私聊令牌仍然不能直接往群里发
      const direct = await request(server, 'POST', '/api/send/group', { body: { groupId: String(GROUP), message: 'hi', token: ownerSt.agentToken }, headers: hdr(ownerSt) });
      assert.equal(direct.status, 403, '私聊令牌直接发群仍被拒');
      assert.ok(JSON.stringify(h.ext.audit.tail(30)).includes('grouprule.add'), '记入审计');
    } finally {
      await new Promise((r) => server.close(r));
    }
  } finally {
    h.ext.controller.stop();
    await h.close();
  }
});
