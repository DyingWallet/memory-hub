// 权限级别 → DSH 0.2.0-rc.2 的落地方式（已对照 rc.2 安装包源码核实，见 docs/guides/ADMIN_CHANNEL.md §DSH 事实）。
//
// rc.2 的事实：
//   · 权限预设 = 沙箱模式（read-only / workspace-write / danger-full-access）+ 审批策略（ask / never）。
//     dsh-base 默认表：read-only(ask)、workspace-write(ask)、danger-full-access(**never**)。
//   · 预设表只能通过 profile 的 cordis.patch.yml 覆盖 `id: permission` 行的 config 来扩展
//     （settings 只能改 volatile 的 defaultPreset）。scripts/setup-dsh.mjs 负责加入 qq-full-ask。
//   · 单个会话的预设只能通过 `commands/execute(sessionId, "/permission <名字>")` 设置
//     （与 DSH 官方 Web UI 的做法相同）；session.create 没有权限参数。
//   · `sessions.prompt` 不解析斜杠命令：QQ 里发来的 "/permission ..." 文字只会作为普通文本进模型。
//   · Windows 上 read-only 沙箱只限制写、且是 partial（硬链接/NUL 等缝隙），读不受限。
//     因此 L1 额外用 qq-agent-readonly agent preset 的**工具白名单守卫**挡掉写/执行类工具 ——
//     这道边界与操作系统无关。
//
// 绝不映射到内置 danger-full-access（审批策略 never = 不弹审批直接执行）。

export const LEVEL_PERMISSION_PRESET = Object.freeze({
  L1: 'read-only',
  L2: 'workspace-write',
  L3: 'qq-full-ask',
});

/** 禁止使用的权限预设：审批策略为 never 的一律不允许由桥接设置。 */
export const FORBIDDEN_PERMISSION_PRESETS = Object.freeze(['danger-full-access']);

/** L3 自定义预设的定义（setup-dsh.mjs 写入 profile；这里是唯一权威）。 */
export const QQ_FULL_ASK_PRESET = Object.freeze({
  sandbox: 'danger-full-access',
  approval: 'ask',
  name: 'QQ 桥接 L3（完全访问 + 每次审批）',
  description: '由 qq-bridge 管理通道在 owner 确认 + TOTP 后启用；所有越权操作仍需 owner 审批',
});

/** 各级别使用的 agent preset（都由 qq-agent-presets bundle 提供；缺失时 fail-closed）。 */
export const L1_AGENT_PRESET = 'qq-agent-readonly';
export const LEVEL_AGENT_PRESET = Object.freeze({
  L1: L1_AGENT_PRESET,
  // L2/L3 带桥接自己的审批闸门（qq-approval-gate）：rc.2 的审批只在「越过沙箱」时触发，
  // 不加闸门的话 L2 工作区内的命令、L3 的一切操作都不会弹审批。
  L2: 'qq-agent-workspace',
  L3: 'qq-agent-full',
});

/**
 * 计算某个级别应使用的 agent preset 与权限预设。
 * @param {'L1'|'L2'|'L3'} level
 * @param {object} ctx
 * @param {string[]} ctx.presetIds         DSH agentPresets/list 返回的 id
 * @param {string} ctx.closedAgentPreset   控制台配置的 closed-agent preset（仅 allowCustomAgentPreset=true 时对 L2/L3 生效）
 * @param {boolean} ctx.allowCustomAgentPreset  admin.allowCustomAgentPreset：允许 L2/L3 改用自选 preset（**没有审批闸门**）
 * @param {string[]|null} ctx.permissionCatalog  permissionPresets/catalog 的 value 列表；null = 未知
 * @returns {{ok:true, agentPreset:string, permissionPreset:string, custom?:boolean}|{ok:false, error:string}}
 */
export function resolveLevelPlan(level, { presetIds = [], closedAgentPreset = '', allowCustomAgentPreset = false, permissionCatalog = null } = {}) {
  const permissionPreset = LEVEL_PERMISSION_PRESET[level];
  if (!permissionPreset) return { ok: false, error: `未知权限级别 ${level}` };
  if (FORBIDDEN_PERMISSION_PRESETS.includes(permissionPreset)) return { ok: false, error: '禁止映射到免审批的完全访问预设' };
  if (Array.isArray(permissionCatalog) && !permissionCatalog.includes(permissionPreset)) {
    return {
      ok: false,
      error: level === 'L3'
        ? `DSH 中没有权限预设 ${permissionPreset}（完全访问 + 审批）。请运行 node scripts/setup-dsh.mjs 并重启 DSH；桥接不会退回到免审批的 danger-full-access`
        : `DSH 中没有权限预设 ${permissionPreset}`,
    };
  }
  const custom = String(closedAgentPreset || '').trim();
  if (level !== 'L1' && allowCustomAgentPreset && custom && presetIds.includes(custom) && !['qq-chat', 'qq-chat-v2'].includes(custom)) {
    return { ok: true, agentPreset: custom, permissionPreset, custom: true };
  }
  const agentPreset = LEVEL_AGENT_PRESET[level];
  if (!presetIds.includes(agentPreset)) {
    return { ok: false, error: `${level} 需要 agent preset ${agentPreset}${level === 'L1' ? '（只读工具白名单）' : '（带 qq-bridge 审批闸门）'}，但它不在 DSH 可用清单中；请运行 node scripts/setup-dsh.mjs 并重启 DSH` };
  }
  return { ok: true, agentPreset, permissionPreset };
}

/** 从 `/permission` 命令结果文本判断是否生效（rc.2 成功时返回 "preset <name>"）。 */
export function permissionCommandSucceeded(result, wanted) {
  const r = result?.result ?? result;
  if (!r || r.kind !== 'success') return false;
  const text = String(r.text ?? '');
  return text.includes(wanted);
}
