// L1「本地只读 Agent」（qq-agent-readonly preset）的硬边界：
//   · preset 行列表里没有任何 shell / 子代理 / 工作流 / 任务类行；
//   · 守卫以 profile: readonly-agent 运行，只多放行只读工具，写入/执行一律拒绝；
//   · 不带 profile 时守卫行为与原版完全一致（群友会话不因此多出读文件能力）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

const root = fileURLToPath(new URL('..', import.meta.url));
const presetDir = path.join(root, 'dsh', 'agent-presets', 'qq-agent-readonly');
const guardUrl = pathToFileURL(path.join(root, 'plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs')).href;

function flatten(rows) {
  const out = [];
  for (const r of rows) {
    out.push(r);
    if (r.group && Array.isArray(r.config)) out.push(...flatten(r.config));
  }
  return out;
}

function makeGuard(mod, config) {
  const restricted = [];
  let guard;
  mod.apply({ tools: { restrict: ({ deny }) => restricted.push(...deny), guard: (fn) => { guard = fn; } } }, config);
  return { guard, restricted };
}

test('L1 preset 不挂载任何执行/派生类工具行', () => {
  const rows = flatten(yaml.load(fs.readFileSync(path.join(presetDir, 'agent.cordis.yml'), 'utf8')));
  const names = rows.map((r) => r.name);
  for (const forbidden of ['dsh-tool-pwsh', 'dsh-tool-bash', 'dsh-tool-subagent', 'dsh-tool-workflow', 'dsh-tool-jobs', 'dsh-workflow-ptc', 'dsh-tool-ralph', 'dsh-tool-str-replace-editor', 'dsh-tool-goal', 'dsh-plan-mode', 'dsh-tool-workspace-dependencies']) {
    assert.ok(!names.some((n) => String(n).includes(forbidden)), `不应挂载 ${forbidden}`);
  }
  const guardRow = rows.find((r) => r.id === 'qq-tool-restrict');
  assert.equal(guardRow?.config?.profile, 'readonly-agent');
});

test('readonly-agent 守卫：放行只读工具与 QQ MCP，拒绝写入/执行/未知工具', async () => {
  const mod = await import(guardUrl);
  const { guard, restricted } = makeGuard(mod, { profile: 'readonly-agent' });
  for (const name of ['read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch', 'todo_write', 'ask_user_question', 'mcp__snowluma__qq_status']) {
    assert.equal(guard({ name }), undefined, `应放行 ${name}`);
  }
  for (const name of ['write', 'edit', 'str_replace_editor', 'pwsh', 'bash', 'subagent', 'workflow', 'job_kill', 'plugin_manager', 'load_workspace_dependencies', 'schedule_create', 'mcp__filesystem__write', 'unknown_tool', '', null]) {
    assert.equal(typeof guard({ name }), 'string', `应拒绝 ${JSON.stringify(name)}`);
  }
  assert.ok(!restricted.includes('read'), '只读工具不从 schema 隐藏');
  assert.ok(restricted.includes('pwsh') && restricted.includes('write'));
});

test('不带 profile 时守卫与原版一致：群友会话依旧不能读文件', async () => {
  const mod = await import(guardUrl);
  const { guard, restricted } = makeGuard(mod, undefined);
  for (const name of ['read', 'glob', 'grep', 'web_fetch', 'write', 'pwsh']) {
    assert.equal(typeof guard({ name }), 'string', `群友会话应拒绝 ${name}`);
  }
  assert.ok(restricted.includes('read'));
  assert.deepEqual([...mod.READONLY_AGENT_TOOLS].sort(), ['glob', 'grep', 'read', 'read_image', 'web_fetch', 'web_search']);
});

test('桥接的 L1 映射指向这个 preset，L3 不映射到免审批预设', async () => {
  const { L1_AGENT_PRESET, LEVEL_PERMISSION_PRESET, QQ_FULL_ASK_PRESET } = await import(pathToFileURL(path.join(root, 'src', 'admin', 'dsh-permission.js')).href);
  assert.equal(L1_AGENT_PRESET, 'qq-agent-readonly');
  assert.equal(LEVEL_PERMISSION_PRESET.L1, 'read-only');
  assert.equal(QQ_FULL_ASK_PRESET.approval, 'ask', 'L3 预设必须保留审批');
  assert.notEqual(LEVEL_PERMISSION_PRESET.L3, 'danger-full-access');
});

// ── L2/L3 运维 preset 的审批闸门与凭据保护（独立安全审查后新增）──────────────────
const gateUrl = pathToFileURL(path.join(root, 'plugins', 'qq-agent-presets', 'qq-approval-gate.mjs')).href;
const ppUrl = pathToFileURL(path.join(root, 'plugins', 'qq-agent-presets', 'protected-paths.mjs')).href;

test('审批闸门：L2 执行命令要审批、工作区写入放行；L3 除只读外全部要审批；派生类直接拒绝', async () => {
  const { decide } = await import(gateUrl);
  assert.equal(decide({ name: 'pwsh', arguments: { command: 'dir' } }, 'L2'), 'ask');
  assert.equal(decide({ name: 'write', arguments: { file_path: 'C:/work/a.txt' } }, 'L2'), 'allow');
  assert.equal(decide({ name: 'write', arguments: { file_path: 'C:/work/a.txt' } }, 'L3'), 'ask');
  assert.equal(decide({ name: 'pwsh', arguments: { command: 'dir' } }, 'L3'), 'ask');
  assert.equal(decide({ name: 'read', arguments: { file_path: 'C:/work/a.txt' } }, 'L3'), 'allow');
  assert.equal(decide({ name: 'mcp__snowluma__qq_status' }, 'L3'), 'allow');
  assert.equal(decide({ name: 'brand_new_tool' }, 'L2'), 'ask', '未知工具按需审批处理');
  for (const t of ['subagent', 'workflow', 'plugin_manager', 'schedule_create']) assert.ok(decide({ name: t }, 'L3').deny, t);
});

test('审批闸门：apply 注册 tools/pre-execute，返回 ask；上游拒绝时不放宽', async () => {
  const mod = await import(gateUrl);
  let handler;
  mod.apply({ on: (ev, fn) => { assert.equal(ev, 'tools/pre-execute'); handler = fn; } }, { level: 'L3' });
  assert.equal((await handler({ name: 'pwsh', arguments: { command: 'x' } }, async () => ({ kind: 'allow' }))).kind, 'ask');
  assert.equal((await handler({ name: 'read', arguments: { file_path: 'C:/w/a' } }, async () => ({ kind: 'allow' }))).kind, 'allow');
  assert.equal((await handler({ name: 'pwsh' }, async () => ({ kind: 'deny', reason: 'sandbox' }))).kind, 'deny');
  let h2;
  mod.apply({ on: (ev, fn) => { h2 = fn; } }, {});
  assert.equal((await h2({ name: 'write', arguments: { file_path: 'C:/w/a' } }, async () => ({ kind: 'allow' }))).kind, 'ask', '缺省 level 按更严的 L3');
});

test('凭据保护：桥接 state/、config.json、DSH 凭据与向上跳出的相对路径都被拒绝', async () => {
  const { touchesProtected, protectedFileReason, PROTECTED_PATHS } = await import(ppUrl);
  for (const p of PROTECTED_PATHS) assert.equal(touchesProtected(p), true, p);
  assert.equal(touchesProtected(path.join(root, 'state', 'admin', 'totp.json')), true);
  assert.equal(touchesProtected('../console-token'), true);
  assert.equal(touchesProtected(['..', '..', 'config.json'].join(path.sep)), true);
  assert.equal(touchesProtected('D:/anything/.credentials.yaml'), true);
  assert.equal(touchesProtected('C:/Users/someone/project/readme.md'), false);
  assert.ok(protectedFileReason({ name: 'grep', arguments: { pattern: 'token', path: path.join(root, 'state') } }));
  assert.equal(protectedFileReason({ name: 'read', arguments: { file_path: 'C:/proj/a.txt' } }), undefined);
});

test('operator 守卫：拒绝派生/编排类与凭据读取，其余交给审批闸门', async () => {
  const mod = await import(guardUrl);
  const { guard, restricted } = makeGuard(mod, { profile: 'operator' });
  assert.equal(guard({ name: 'pwsh', arguments: { command: 'dir' } }), undefined, 'pwsh 由闸门审批，不由守卫拒绝');
  assert.equal(typeof guard({ name: 'subagent' }), 'string');
  assert.equal(typeof guard({ name: 'dev_install_package' }), 'string');
  assert.equal(typeof guard({ name: 'read', arguments: { file_path: path.join(root, 'state', 'console-token') } }), 'string');
  assert.ok(!restricted.includes('pwsh'));
});

test('L2/L3 preset：挂了闸门与 operator 守卫，没有子代理/工作流/插件管理行', () => {
  for (const [id, level] of [['qq-agent-workspace', 'L2'], ['qq-agent-full', 'L3']]) {
    const rows = flatten(yaml.load(fs.readFileSync(path.join(root, 'dsh', 'agent-presets', id, 'agent.cordis.yml'), 'utf8')));
    assert.equal(rows.find((r) => r.id === 'qq-approval-gate')?.config?.level, level, id);
    assert.equal(rows.find((r) => r.id === 'qq-tool-restrict')?.config?.profile, 'operator', id);
    for (const forbidden of ['dsh-tool-subagent', 'dsh-tool-workflow', 'dsh-workflow-ptc', 'dsh-plugin-manager', 'dsh-tool-skill', 'dsh-plan-mode', 'dsh-tool-goal']) {
      assert.ok(!rows.some((r) => String(r.name).includes(forbidden)), `${id} 不应挂 ${forbidden}`);
    }
  }
});
