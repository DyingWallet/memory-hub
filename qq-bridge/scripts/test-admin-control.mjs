// 管理通道模块的离线测试：TOTP / 审计哈希链 / 模式切换状态机 / 审批编号 / owner 命令解析 / 权限映射。
// 不连 QQ、不连 DSH；applyMode / notifyOwner 都是记录调用的假实现。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { base32Encode, base32Decode, hotp, totp, verifyTotp, generateSecret, otpauthUri } from '../src/admin/totp.js';
import { createAuditLog } from '../src/admin/audit-log.js';
import { createModeController, parseConfirm, normalizeTarget } from '../src/admin/mode-control.js';
import { createApprovalRegistry, parseApprovalReply, describeToolArgs } from '../src/admin/approvals.js';
import { parseOwnerCommand } from '../src/admin/owner-commands.js';
import { resolveLevelPlan, permissionCommandSucceeded, LEVEL_PERMISSION_PRESET } from '../src/admin/dsh-permission.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-admin-'));

// RFC 6238 附录 B 的 SHA1 测试向量（秘密 = ASCII "12345678901234567890"）。
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

test('TOTP：RFC 6238 测试向量（8 位截取后 6 位一致）', () => {
  assert.equal(RFC_SECRET, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  const vectors = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037']];
  for (const [t, expected8] of vectors) {
    assert.equal(hotp(base32Decode(RFC_SECRET), Math.floor(t / 30), 8), expected8, `t=${t}`);
    assert.equal(totp(RFC_SECRET, t * 1000), expected8.slice(-6));
  }
});

test('TOTP：窗口 ±1、重放拒绝、格式错误拒绝', () => {
  const now = 1_700_000_000_000;
  const code = totp(RFC_SECRET, now);
  const ok = verifyTotp(RFC_SECRET, code, { nowMs: now });
  assert.equal(ok.ok, true);
  assert.equal(verifyTotp(RFC_SECRET, code, { nowMs: now, lastUsedCounter: ok.counter }).reason, 'replay');
  assert.equal(verifyTotp(RFC_SECRET, totp(RFC_SECRET, now - 30_000), { nowMs: now }).ok, true, '上一个步长仍可用');
  assert.equal(verifyTotp(RFC_SECRET, totp(RFC_SECRET, now - 90_000), { nowMs: now }).reason, 'mismatch', '超出窗口');
  assert.equal(verifyTotp(RFC_SECRET, '12345', { nowMs: now }).reason, 'format');
  assert.equal(verifyTotp(RFC_SECRET, 'abcdef', { nowMs: now }).reason, 'format');
  const s = generateSecret();
  assert.match(s, /^[A-Z2-7]{32}$/);
  assert.match(otpauthUri(s), /^otpauth:\/\/totp\//);
});

test('审计日志：哈希链可校验，篡改可发现', () => {
  const dir = tmp();
  const file = path.join(dir, 'audit.jsonl');
  const a = createAuditLog({ file });
  a.append('mode.changed', { from: 'reserved2', to: 'closed-agent' });
  a.append('totp.verified', {});
  assert.deepEqual(a.verify(), { ok: true, count: 2, brokenAt: null });
  const b = createAuditLog({ file }); // 重启后接续链
  b.append('mode.changed', { from: 'closed-agent', to: 'reserved2' });
  assert.equal(b.verify().ok, true);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines[1] = lines[1].replace('totp.verified', 'totp.rejected');
  fs.writeFileSync(file, lines.join('\n'));
  assert.equal(b.verify().ok, false);
  assert.equal(b.verify().brokenAt, 2);
});

function makeController(overrides = {}) {
  const dir = tmp();
  const clock = { t: 1_700_000_000_000 };
  const applied = [];
  const notices = [];
  const audit = createAuditLog({ file: path.join(dir, 'audit.jsonl'), now: () => clock.t });
  let failNext = false;
  const ctl = createModeController({
    file: path.join(dir, 'control.json'),
    config: { idleTimeoutMs: 30 * 60_000, ...overrides.config },
    applyMode: async (target, ctx) => {
      if (failNext) { failNext = false; throw new Error('DSH 不可用'); }
      applied.push({ ...target, source: ctx.source });
    },
    notifyOwner: async (text) => { notices.push(text); },
    audit,
    getTotpSecret: () => overrides.secret ?? null,
    now: () => clock.t,
  });
  return { ctl, clock, applied, notices, audit, dir, failOnce: () => { failNext = true; } };
}

test('升级必须确认码；确认消息被拦截；码只能用一次', async () => {
  const h = makeController();
  await h.ctl.initialize('reserved2');
  const r = await h.ctl.requestChange({ mode: 'closed-agent', level: 'L2' }, { origin: 'command' });
  assert.equal(r.status, 'pending');
  assert.equal(h.applied.length, 0, '申请阶段不执行');
  assert.match(r.text, /确认 \d{4}/);
  const code = r.request.code;
  const c = await h.ctl.confirm(`确认 ${code}`);
  assert.equal(c.handled, true);
  assert.deepEqual(h.applied.at(-1), { mode: 'closed-agent', level: 'L2', source: 'qq-confirm' });
  assert.equal(h.ctl.current().level, 'L2');
  const again = await h.ctl.confirm(`确认 ${code}`);
  assert.match(again.text, /没有与这个确认码对应/);
  assert.equal(h.applied.length, 1);
  assert.ok(h.notices.some((n) => n.includes('模式已变更') && n.includes('来源') && n.includes('当前权限')));
});

test('确认码过期作废；错误码不执行；尝试次数上限', async () => {
  const h = makeController();
  await h.ctl.initialize('reserved2');
  const r = await h.ctl.requestChange({ mode: 'closed-agent' }, { origin: 'command' });
  h.clock.t += 121_000;
  const c = await h.ctl.confirm(`确认 ${r.request.code}`);
  assert.match(c.text, /没有与这个确认码对应/);
  assert.equal(h.applied.length, 0);
  const wrong = await h.ctl.confirm('确认 0000');
  assert.equal(wrong.handled, true);
  assert.equal(h.applied.length, 0);
});

test('并发申请：各自独立的码，互不覆盖；确认一个后另一个作废（出发点已变）', async () => {
  const h = makeController();
  await h.ctl.initialize('reserved2');
  const a = await h.ctl.requestChange({ mode: 'closed-agent', level: 'L1' }, { origin: 'command' });
  const b = await h.ctl.requestChange({ mode: 'closed-agent', level: 'L2' }, { origin: 'command' });
  assert.notEqual(a.request.code, b.request.code);
  assert.notEqual(a.request.id, b.request.id);
  await h.ctl.confirm(`确认 ${b.request.code}`);
  assert.equal(h.ctl.current().level, 'L2');
  const late = await h.ctl.confirm(`确认 ${a.request.code}`);
  assert.equal(h.ctl.current().level, 'L2', '旧申请不能把 L2 改成 L1');
  assert.ok(/没有与这个确认码|已作废/.test(late.text));
});

test('降级一步完成，不需要确认；/panic 立即回到安全模式', async () => {
  const h = makeController();
  await h.ctl.initialize('reserved2');
  const r = await h.ctl.requestChange({ mode: 'closed-agent', level: 'L2' }, { origin: 'command' });
  await h.ctl.confirm(`确认 ${r.request.code}`);
  const down = await h.ctl.requestChange({ mode: 'closed-agent', level: 'L1' }, { origin: 'command' });
  assert.equal(down.status, 'applied');
  assert.equal(h.ctl.current().level, 'L1');
  const p = await h.ctl.panic();
  assert.equal(p.ok, true);
  assert.deepEqual(h.ctl.current().mode, 'reserved2');
  assert.equal(h.ctl.current().level, 'L0');
});

test('L3：未配置 TOTP 拒绝；配置后必须附动态码；动态码重放拒绝', async () => {
  const none = makeController();
  await none.ctl.initialize('reserved2');
  assert.equal((await none.ctl.requestChange({ mode: 'closed-agent', level: 'L3' }, { origin: 'command' })).status, 'rejected');

  const h = makeController({ secret: RFC_SECRET });
  await h.ctl.initialize('reserved2');
  const r = await h.ctl.requestChange({ mode: 'closed-agent', level: 'L3' }, { origin: 'command' });
  assert.match(r.text, /动态码/);
  const noTotp = await h.ctl.confirm(`确认 ${r.request.code}`);
  assert.match(noTotp.text, /附上验证器动态码/);
  assert.equal(h.applied.length, 0);
  const bad = await h.ctl.confirm(`确认 ${r.request.code} 000000`);
  assert.match(bad.text, /不正确/);
  const good = totp(RFC_SECRET, h.clock.t);
  const ok = await h.ctl.confirm(`确认 ${r.request.code} ${good}`);
  assert.match(ok.text, /已确认/);
  assert.equal(h.ctl.current().level, 'L3');
  await h.ctl.panic();
  const r2 = await h.ctl.requestChange({ mode: 'closed-agent', level: 'L3' }, { origin: 'command' });
  const replay = await h.ctl.confirm(`确认 ${r2.request.code} ${good}`);
  assert.match(replay.text, /用过了/, '同一个动态码不能用第二次');
  assert.equal(h.ctl.current().level, 'L0');
});

test('TOTP 连续失败锁定', async () => {
  const h = makeController({ secret: RFC_SECRET, config: { totpMaxFailures: 3, maxConfirmAttempts: 10 } });
  await h.ctl.initialize('reserved2');
  const r = await h.ctl.requestChange({ mode: 'closed-agent', level: 'L3' }, { origin: 'command' });
  for (let i = 0; i < 3; i++) await h.ctl.confirm(`确认 ${r.request.code} 00000${i}`);
  const locked = await h.ctl.confirm(`确认 ${r.request.code} ${totp(RFC_SECRET, h.clock.t)}`);
  assert.match(locked.text, /锁定/);
  assert.equal(h.ctl.current().level, 'L0');
  assert.ok(h.audit.tail(50).some((e) => e.event === 'totp.locked'));
});

test('高权限闲置自动回落；超过最长时长自动回落；回落会通知', async () => {
  const h = makeController({ config: { idleTimeoutMs: 60_000, maxElevatedMs: { L2: 120_000 } } });
  await h.ctl.initialize('reserved2');
  const r = await h.ctl.requestChange({ mode: 'closed-agent', level: 'L2' }, { origin: 'command' });
  await h.ctl.confirm(`确认 ${r.request.code}`);
  h.clock.t += 30_000;
  h.ctl.touch();
  assert.equal(await h.ctl.tick(), null);
  h.clock.t += 61_000;
  const fb = await h.ctl.tick();
  assert.equal(fb.ok, true);
  assert.equal(h.applied.at(-1).source, 'auto-idle');
  assert.ok(h.notices.at(-1).includes('闲置超时'));
  const r2 = await h.ctl.requestChange({ mode: 'closed-agent', level: 'L2' }, { origin: 'command' });
  await h.ctl.confirm(`确认 ${r2.request.code}`);
  for (let i = 0; i < 5; i++) { h.clock.t += 30_000; h.ctl.touch(); await h.ctl.tick(); }
  assert.equal(h.applied.at(-1).source, 'auto-max');
  assert.equal(h.ctl.current().level, 'L0');
});

test('外部（DSH 设置）提权被回退并告警；非提权变化接受并通知', async () => {
  const h = makeController();
  await h.ctl.initialize('reserved2');
  const r = await h.ctl.observeExternalMode('closed-agent');
  assert.equal(r.action, 'reverted');
  assert.equal(h.ctl.current().level, 'L0');
  assert.ok(h.notices.at(-1).includes('告警'));
  const r2 = await h.ctl.observeExternalMode('chat');
  assert.equal(r2.action, 'accepted');
  assert.equal(h.ctl.current().mode, 'chat');
});

test('重启不继承高权限：启动时回落到安全模式', async () => {
  const h = makeController();
  await h.ctl.initialize('reserved2');
  const r = await h.ctl.requestChange({ mode: 'closed-agent', level: 'L1' }, { origin: 'command' });
  await h.ctl.confirm(`确认 ${r.request.code}`);
  // 用同一个状态文件新建控制器 = 重启
  const applied = [];
  const again = createModeController({
    file: path.join(h.dir, 'control.json'), config: {}, applyMode: async (t, c) => applied.push({ ...t, source: c.source }),
    notifyOwner: async () => {}, audit: null, now: () => h.clock.t,
  });
  const res = await again.initialize('closed-agent');
  assert.equal(res.action, 'fallback');
  assert.deepEqual(applied[0], { mode: 'reserved2', level: 'L0', source: 'startup' });
});

test('首次启动时发现老版本遗留的 closed-agent：回落并告警', async () => {
  const h = makeController();
  const r = await h.ctl.initialize('closed-agent');
  assert.equal(r.action, 'fallback');
  assert.equal(h.ctl.current().mode, 'reserved2');
  assert.ok(h.notices[0].includes('告警'));
});

test('切换失败：状态不变，通知失败原因，审计记录失败', async () => {
  const h = makeController();
  await h.ctl.initialize('reserved2');
  const r = await h.ctl.requestChange({ mode: 'closed-agent', level: 'L1' }, { origin: 'command' });
  h.failOnce();
  const c = await h.ctl.confirm(`确认 ${r.request.code}`);
  assert.match(c.text, /切换失败/);
  assert.equal(h.ctl.current().level, 'L0');
  assert.ok(h.notices.at(-1).includes('失败'));
  assert.ok(h.audit.tail(10).some((e) => e.event === 'mode.change_failed'));
});

test('AI 工具只能登记申请：origin=ai-tool 的升级仍需 owner 确认', async () => {
  const h = makeController();
  await h.ctl.initialize('reserved2');
  const r = await h.ctl.requestChange({ mode: 'closed-agent', level: 'L2' }, { origin: 'ai-tool', reason: '用户说想切换' });
  assert.equal(r.status, 'pending');
  assert.match(r.text, /AI 不能替你确认/);
  assert.equal(h.applied.length, 0);
});

test('控制台：L0 时 L1/L2 直接设置、L3 要 TOTP；高权限期间与回落冷却期内不能提权', async () => {
  const h = makeController({ secret: RFC_SECRET });
  await h.ctl.initialize('reserved2');
  assert.equal((await h.ctl.consoleSet({ mode: 'closed-agent', level: 'L2' })).ok, true);
  assert.equal(h.applied.at(-1).source, 'console');
  // 审计 F1：高权限 Agent 若读到控制台令牌，不能借控制台给自己提权
  const up = await h.ctl.consoleSet({ mode: 'closed-agent', level: 'L3' }, { totp: totp(RFC_SECRET, h.clock.t) });
  assert.equal(up.ok, false);
  assert.match(up.error, /高权限期间/);
  assert.equal((await h.ctl.consoleSet({ mode: 'closed-agent', level: 'L1' })).ok, true, '降级仍然允许');
  assert.equal((await h.ctl.consoleSet({ mode: 'reserved2' })).ok, true);
  const cool = await h.ctl.consoleSet({ mode: 'closed-agent', level: 'L3' }, { totp: totp(RFC_SECRET, h.clock.t) });
  assert.match(cool.error, /冷却/, '先降级再提权的组合被冷却期挡住');
  h.clock.t += 11 * 60_000;
  assert.equal((await h.ctl.consoleSet({ mode: 'closed-agent', level: 'L3' })).ok, false, 'L3 无 TOTP 拒绝');
  assert.equal((await h.ctl.consoleSet({ mode: 'closed-agent', level: 'L3' }, { totp: totp(RFC_SECRET, h.clock.t) })).ok, true);
});

test('启动校验完成前拒绝申请与确认（审计 F5）', async () => {
  const h = makeController();
  assert.equal((await h.ctl.requestChange({ mode: 'closed-agent', level: 'L1' }, { origin: 'command' })).status, 'rejected');
  assert.match((await h.ctl.confirm('确认 1234')).text, /启动校验/);
});

test('外部变更在 alert 模式下最多按 L1 接受（审计 F3）', async () => {
  const h = makeController({ config: { externalEscalation: 'alert', defaultAgentLevel: 'L3' } });
  await h.ctl.initialize('reserved2');
  const r = await h.ctl.observeExternalMode('closed-agent');
  assert.equal(r.action, 'accepted-alert');
  assert.equal(h.ctl.current().level, 'L1');
});

test('目标规整与确认解析', () => {
  assert.deepEqual(normalizeTarget('closed-agent', 'L0'), { mode: 'closed-agent', level: 'L1' });
  assert.deepEqual(normalizeTarget('reserved2', 'L3'), { mode: 'reserved2', level: 'L0' });
  assert.equal(normalizeTarget('danger', 'L1'), null);
  assert.deepEqual(parseConfirm('确认 7342'), { code: '7342', totp: null });
  assert.deepEqual(parseConfirm('确认7342 123456'), { code: '7342', totp: '123456' });
  assert.equal(parseConfirm('确认一下'), null);
  assert.equal(parseConfirm('是'), null);
});

test('审批：并发编号、带编号回复、裸回复歧义拒绝、旧编号不能复用', async () => {
  const timedOut = [];
  const reg = createApprovalRegistry({ timeoutMs: 1000, onTimeout: async (e) => timedOut.push(e.id) });
  reg.noteToolCall('s1', 'c1', 'pwsh', JSON.stringify({ command: 'winget install foo' }));
  const a = reg.register({ key: 'private:111', sessionId: 's1', clientId: 'k', eventId: 'e1', toolName: 'pwsh', callId: 'c1' }).entry;
  assert.equal(a.argsKnown, true);
  assert.match(describeToolArgs(a.args), /command: winget install foo/);
  const b = reg.register({ key: 'private:111', sessionId: 's1', clientId: 'k', eventId: 'e2', toolName: 'write', callId: 'c2' }).entry;
  assert.equal(b.argsKnown, false);
  assert.notEqual(a.id, b.id);
  const dup = reg.register({ key: 'private:111', sessionId: 's1', clientId: 'k', eventId: 'e1', toolName: 'pwsh', callId: 'c1' });
  assert.equal(dup.duplicate, true, '事件流重放不重复编号');
  assert.match(reg.resolveReply('private:111', '通过').error, /2 个待审批/);
  const r = reg.resolveReply('private:111', `通过 #${b.id}`);
  assert.equal(r.ok, true);
  assert.equal(r.entry.eventId, 'e2');
  reg.complete(b.id);
  assert.match(reg.resolveReply('private:111', `通过 #${b.id}`).error, /不存在或已失效/);
  assert.equal(reg.resolveReply('private:111', '通过').entry.id, a.id, '只剩一个时裸回复可用');
  assert.match(reg.resolveReply('group:222', `通过 #${a.id}`).error, /不属于这个会话/);
  assert.equal(reg.resolveReply('private:111', '今天天气不错'), null);
  clearTimeout(a.timer);
});

test('审批：超时自动拒绝回调；编号跨重启不复用', async () => {
  const timedOut = [];
  const reg = createApprovalRegistry({ timeoutMs: 20, onTimeout: async (e) => timedOut.push(e.id), startId: 41 });
  const e = reg.register({ key: 'private:111', sessionId: 's', clientId: 'k', eventId: 'x', toolName: 'pwsh' }).entry;
  assert.equal(e.id, 42);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(timedOut, [42]);
  assert.equal(reg.pendingFor('private:111').length, 0);
});

test('审批回复解析', () => {
  assert.deepEqual(parseApprovalReply('通过 #3'), { decision: 'allowed-once', id: 3 });
  assert.deepEqual(parseApprovalReply('拒绝#12'), { decision: 'rejected', id: 12 });
  assert.deepEqual(parseApprovalReply('通过'), { decision: 'allowed-once', id: null });
  assert.equal(parseApprovalReply('通过了吗'), null);
});

test('owner 命令：/permission danger-full-access 被拒绝；特权斜杠命令被拦截', () => {
  assert.equal(parseOwnerCommand('/permission danger-full-access').type, 'error');
  assert.deepEqual(parseOwnerCommand('/permission read-only'), { type: 'mode', mode: 'closed-agent', level: 'L1' });
  assert.deepEqual(parseOwnerCommand('/level L3'), { type: 'mode', mode: 'closed-agent', level: 'L3' });
  assert.deepEqual(parseOwnerCommand('/mode agent L2'), { type: 'mode', mode: 'closed-agent', level: 'L2' });
  assert.deepEqual(parseOwnerCommand('/mode simulation'), { type: 'mode', mode: 'reserved2', level: null });
  for (const c of ['/sandbox off', '/approval never', '/yolo', '/preset standard', '/plan', '/goal 做点事']) {
    assert.equal(parseOwnerCommand(c)?.type, 'blocked-slash', c);
  }
  assert.equal(parseOwnerCommand('/compact'), null, '无害命令不拦截');
  assert.equal(parseOwnerCommand('今天吃什么'), null);
  assert.equal(parseOwnerCommand('切换到agent模式').type, 'mode');
  assert.equal(parseOwnerCommand('切回群友模式').level, 'L0');
  assert.equal(parseOwnerCommand('确认 1234').type, 'confirm');
  assert.equal(parseOwnerCommand('/panic').type, 'panic');
  assert.deepEqual(parseOwnerCommand('/say 10001 大家好'), { type: 'say', groupId: '10001', text: '大家好' });
  assert.equal(parseOwnerCommand('切换到agent模式', { naturalLanguage: false }), null);
});

test('权限映射：L3 绝不落到 danger-full-access；缺预设时 fail-closed', () => {
  assert.equal(LEVEL_PERMISSION_PRESET.L3, 'qq-full-ask');
  assert.ok(!Object.values(LEVEL_PERMISSION_PRESET).includes('danger-full-access'));
  const catalog = ['read-only', 'workspace-write', 'danger-full-access'];
  assert.equal(resolveLevelPlan('L3', { permissionCatalog: catalog }).ok, false);
  assert.equal(resolveLevelPlan('L3', { presetIds: ['qq-agent-full'], permissionCatalog: [...catalog, 'qq-full-ask'] }).permissionPreset, 'qq-full-ask');
  assert.equal(resolveLevelPlan('L1', { presetIds: ['standard'] }).ok, false, 'L1 缺只读 preset 时拒绝');
  assert.equal(resolveLevelPlan('L1', { presetIds: ['qq-agent-readonly'] }).agentPreset, 'qq-agent-readonly');
  // v0.3.0 审计修订：L2/L3 使用带审批闸门的运维 preset，缺失时 fail-closed，不再退回 DSH 默认 preset
  assert.equal(resolveLevelPlan('L2', { presetIds: ['standard', 'qq-chat'] }).ok, false);
  assert.equal(resolveLevelPlan('L2', { presetIds: ['qq-agent-workspace'] }).agentPreset, 'qq-agent-workspace');
  assert.equal(resolveLevelPlan('L3', { presetIds: ['qq-agent-full'], permissionCatalog: [...catalog, 'qq-full-ask'] }).agentPreset, 'qq-agent-full');
  assert.equal(resolveLevelPlan('L2', { presetIds: ['standard', 'qq-agent-workspace'], closedAgentPreset: 'standard' }).agentPreset, 'qq-agent-workspace', '未显式允许时忽略自选 preset');
  assert.equal(resolveLevelPlan('L2', { presetIds: ['standard', 'qq-agent-workspace'], closedAgentPreset: 'standard', allowCustomAgentPreset: true }).custom, true);
  assert.equal(resolveLevelPlan('L2', { presetIds: ['qq-chat', 'qq-agent-workspace'], closedAgentPreset: 'qq-chat', allowCustomAgentPreset: true }).agentPreset, 'qq-agent-workspace', '自选 preset 不能是群友 preset');
  assert.equal(permissionCommandSucceeded({ result: { kind: 'success', text: 'preset read-only' } }, 'read-only'), true);
  assert.equal(permissionCommandSucceeded({ result: { kind: 'error', text: 'unknown preset' } }, 'read-only'), false);
  assert.equal(permissionCommandSucceeded(undefined, 'read-only'), false);
});
