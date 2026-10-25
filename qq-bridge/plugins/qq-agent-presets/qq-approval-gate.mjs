// qq-bridge 运维 Agent 的审批闸门（L2 qq-agent-workspace / L3 qq-agent-full 两个 preset 共用）。
//
// 为什么需要（对照 DSH 0.2.0-rc.2 安装包核实）：DSH 的审批只在工具**请求越过当前沙箱**时才触发；
// 沙箱本身是 workspace-write 时，工作区内的命令直接执行；沙箱是 danger-full-access 时**没有可越过的边界**，
// 也就永远不会弹审批 —— 「完全访问 + ask」在 rc.2 里实际等于完全访问。
// 所以桥接用 `tools/pre-execute` 瀑布（rc.2 的 PreToolDecision 支持 `{ kind: 'ask' }`）自己要求审批：
// 返回 ask 后，DSH 走它自己的审批通道（approval/request 事件）→ 桥接转发到 owner 的 QQ → 「通过 #n」才执行一次。
//
// 策略：
//   · 只读工具（read / glob / grep / web_* / todo / ask_user / job_list / job_output）与 QQ MCP：放行；
//     但文件类工具触碰桥接/DSH 凭据（见 protected-paths.mjs）一律拒绝。
//   · L2（level: L2）：pwsh / bash / job_kill 以及任何未知工具都要审批；write / edit 在工作区沙箱内放行
//     （越出工作区时 DSH 沙箱本身会要求越权审批）。
//   · L3（level: L3）：除只读工具外**全部**要审批，包括 write / edit。
//   · 派生 agent / 工作流 / 插件管理 / 自我调度类工具：直接拒绝（rc.2 把子代理的审批策略固定为 never，
//     一旦放行就绕过了本闸门）。这些工具本来就不在运维 preset 的行列表里，这里是回归网。
import { protectedFileReason } from './protected-paths.mjs'

export const name = 'qq-approval-gate'
export const inject = ['tools']

export const READ_TOOLS = Object.freeze(['read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch', 'todo_write', 'ask_user_question', 'job_list', 'job_output'])
const FILE_TOOLS = new Set(['read', 'read_image', 'glob', 'grep', 'write', 'edit', 'str_replace_editor'])
const SAFE_PREFIXES = ['mcp__snowluma__', 'mcp__snowluma-host__', 'mcp__web-search-safe__']
export const DENY_TOOLS = Object.freeze([
  'subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code', 'list_subagent_models',
  'send_message', 'interrupt_agent', 'list_agents', 'spawn_teammate',
  'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  'workflow', 'ralph', 'plugin_manager', 'load_workspace_dependencies',
  'schedule_create', 'schedule_update', 'schedule_delete', 'schedule_list',
  'cordis_inspect_list', 'cordis_inspect_query', 'read_mcp_resource', 'list_mcp_resources', 'list_mcp_resource_templates',
])
const L2_ALLOWED_MUTATIONS = new Set(['write', 'edit', 'str_replace_editor'])

function summarize(exec) {
  const a = exec?.arguments ?? exec?.input
  let s = ''
  try { s = typeof a === 'string' ? a : JSON.stringify(a) } catch {}
  return s.length > 160 ? `${s.slice(0, 160)}…` : s
}

/**
 * 纯函数决策（便于离线测试）：返回 'allow' | 'ask' | { deny: string }。
 * @param {{name:string, arguments?:unknown}} exec
 * @param {'L2'|'L3'} level
 */
export function decide(exec, level) {
  const tool = exec?.name
  if (typeof tool !== 'string' || !tool) return { deny: '工具名无效，已拒绝' }
  if (DENY_TOOLS.includes(tool)) return { deny: `工具「${tool}」会派生 agent / 编排工作流 / 改插件或调度，运维 Agent 不允许使用` }
  if (FILE_TOOLS.has(tool)) {
    const reason = protectedFileReason(exec)
    if (reason) return { deny: reason }
  }
  if (READ_TOOLS.includes(tool)) return 'allow'
  if (SAFE_PREFIXES.some((p) => tool.startsWith(p))) return 'allow'
  if (level === 'L2' && L2_ALLOWED_MUTATIONS.has(tool)) return 'allow'
  return 'ask'
}

export function apply(ctx, config = {}) {
  const level = config?.level === 'L2' ? 'L2' : 'L3' // 配错/缺省按更严的 L3 处理
  ctx.on('tools/pre-execute', async (exec, next) => {
    const upstream = await next()
    // 上游已经拒绝/取消/要求审批：不放宽，原样返回。
    if (!upstream || upstream.kind !== 'allow') return upstream
    const d = decide(exec, level)
    if (d === 'allow') return upstream
    if (d === 'ask') {
      return {
        kind: 'ask',
        reason: `qq-bridge ${level} 审批闸门：工具 ${exec.name} ${summarize(exec)}`,
        displayReason: { en: `qq-bridge ${level} gate: ${exec.name}`, zh: `qq-bridge ${level} 审批：${exec.name}` },
      }
    }
    return { kind: 'deny', reason: d.deny }
  })
}
