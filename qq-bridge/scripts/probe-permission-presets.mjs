// 部署后验证：DSH 0.2.0-rc.2 的权限预设与 `/permission` 命令是否符合 v0.3.0 管理通道的假设。
//
// 需要：DSH 正在运行（npx @deepseek-ai/dsh@0.2.0-rc.2 web），且已运行过 node scripts/setup-dsh.mjs 并重启 DSH。
// 不需要 QQ / SnowLuma。鉴权走 probe-auth.mjs（与其它 probe 相同）。
//
// 它会：
//   1. 读 permissionPresets/catalog，确认 read-only / workspace-write / qq-full-ask 都在；
//   2. 读 agentPresets/list，确认 qq-agent-readonly / qq-agent-workspace / qq-agent-full 已加载；
//   3. 在一个**临时工作区**里建一个 qq-agent-readonly 会话，执行 `/permission read-only`
//      和 `/permission`（只读查询），确认返回文本形如 "preset read-only" / "current preset ..."；
//   4. 用 session/prompt 发一条 "/permission workspace-write" 文本，确认它**没有**被当成命令执行
//      （rc.2 的 prompt 不解析斜杠命令）——这是「QQ 文本透传无法改权限」的实测依据；
//   5. 归档临时会话。不改任何设置，不运行任何工具。
//
// 它**不能**验证的（需要一个真实模型回合，见 docs/DSH_DEPLOYMENT.md 第 12 节）：
//   · L1 守卫是否拿到 profile: readonly-agent（让 L1 Agent 写文件应被拒绝）；
//   · L2/L3 的 qq-approval-gate 是否真的在 tools/pre-execute 上弹审批（让 L2 Agent 执行 dir 应收到「🔐 审批 #n」）。
import { PROBE_BASE as BASE, probeCookie, probeRpc, probeWorkspaceDir } from './probe-auth.mjs';
import { randomUUID } from 'node:crypto';

const rpc = probeRpc(probeCookie({ base: BASE }));
let failures = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? `：${extra}` : ''}`);
  if (!cond) failures += 1;
};

const cat = await rpc('permissionPresets/catalog', {});
const names = (cat?.value?.options ?? []).map((o) => o.value);
console.log('权限预设目录：', names.join(', ') || '（空）', '默认：', cat?.value?.defaultPreset);
for (const want of ['read-only', 'workspace-write', 'qq-full-ask']) ok(names.includes(want), `预设 ${want} 存在`);

const list = await rpc('agentPresets/list', {});
const presetIds = (list?.value?.presets ?? []).map((p) => p.id);
for (const id of ['qq-agent-readonly', 'qq-agent-workspace', 'qq-agent-full']) ok(presetIds.includes(id), `agent preset ${id} 已加载`, presetIds.join(', '));

const ws = await rpc('workspace/create', { request: { path: probeWorkspaceDir('perm-probe') } });
const workspaceId = ws?.value?.workspace?.workspaceId;
ok(!!workspaceId, '临时工作区已创建');
if (workspaceId) {
  const created = await rpc('session/create', { request: { workspaceId, agentPreset: presetIds.includes('qq-agent-readonly') ? 'qq-agent-readonly' : undefined } });
  const sessionId = created?.value?.sessionId;
  ok(!!sessionId, '临时会话已创建');
  if (sessionId) {
    const set = await rpc('commands/execute', { agentId: sessionId, line: '/permission read-only', submittedAttachments: [] });
    ok(set?.value?.result?.kind === 'success' && /preset read-only/.test(set?.value?.result?.text ?? ''), 'commands/execute "/permission read-only" 生效', JSON.stringify(set?.value?.result));
    const q = await rpc('commands/execute', { agentId: sessionId, line: '/permission', submittedAttachments: [] });
    ok(/current preset read-only/.test(q?.value?.result?.text ?? ''), '"/permission" 查询返回当前预设', q?.value?.result?.text);
    const bad = await rpc('commands/execute', { agentId: sessionId, line: '/permission no-such-preset', submittedAttachments: [] });
    ok(bad?.value?.result?.kind === 'error', '未知预设被 DSH 拒绝', bad?.value?.result?.text);
    const p = await rpc('session/prompt', { request: { sessionId, mode: 'queue', requestId: randomUUID(), content: [{ type: 'text', text: '/permission workspace-write' }] } });
    ok(!p?.value?.command, 'session/prompt 不执行斜杠命令（文本只会进模型）', JSON.stringify(p?.value ?? p?.error));
    // 立刻取消这条 prompt，避免真的跑一个模型回合
    await rpc('session/cancel', { request: { sessionId } });
    const after = await rpc('commands/execute', { agentId: sessionId, line: '/permission', submittedAttachments: [] });
    ok(/current preset read-only/.test(after?.value?.result?.text ?? ''), '经 prompt 发送的 /permission 没有改变权限', after?.value?.result?.text);
    await rpc('workspace/archiveSession', { request: { sessionId } });
  }
}
console.log(failures ? `\n❌ ${failures} 项不符合预期 —— 管理通道的权限分级在这台机器上不可靠，请先修复再启用 closed-agent` : '\n✅ 权限预设与 /permission 行为符合 v0.3.0 的假设');
process.exit(failures ? 1 : 0);
