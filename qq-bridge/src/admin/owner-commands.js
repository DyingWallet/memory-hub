// owner 私聊管理通道的命令解析（纯函数，不执行任何操作）。
//
// 这些命令由桥接在消息交给模型**之前**拦截并直接执行；模型看不到它们，也无法伪造它们
// （伪造需要以 ownerQQ 的身份在 QQ 私聊里发消息，模型做不到）。
//
// 只在 owner 私聊里生效。群里出现这些命令一律拒绝（防止群友围观确认码、防止误触）。

const MODE_WORDS = {
  chat: 'chat',
  reserved: 'reserved',
  reserved2: 'reserved2',
  simulation: 'reserved2',
  sim: 'reserved2',
  群友: 'reserved2',
  agent: 'closed-agent',
  'closed-agent': 'closed-agent',
  运维: 'closed-agent',
};

const PERMISSION_WORDS = {
  'read-only': 'L1',
  readonly: 'L1',
  只读: 'L1',
  'workspace-write': 'L2',
  workspace: 'L2',
  工作区: 'L2',
  'qq-full-ask': 'L3',
  full: 'L3',
  完全访问: 'L3',
};

/** 能改变权限/沙箱/preset/运行状态的斜杠命令：一律由桥接接管或拒绝，**绝不**透传给 DSH。 */
export const PRIVILEGED_SLASH = new Set([
  'permission', 'permissions', 'perm', 'sandbox', 'approval', 'approvals', 'preset', 'presets',
  'agent', 'yolo', 'mode', 'level', 'plan', 'goal', 'model', 'export',
]);

function parseLevel(word) {
  const w = String(word ?? '').trim();
  if (/^L[0-3]$/i.test(w)) return w.toUpperCase();
  return PERMISSION_WORDS[w.toLowerCase()] ?? PERMISSION_WORDS[w] ?? null;
}

/**
 * 解析 owner 私聊消息。返回 null 表示不是管理命令（交给正常流程/模型）。
 * @returns {null|{type:string,[k:string]:any}}
 */
export function parseOwnerCommand(text, { naturalLanguage = true } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const t = raw.replace(/\s+/g, ' ');

  if (/^(?:确认|确定|\/confirm)\s*\d{4,8}(?:\s+\d{6})?$/i.test(t)) return { type: 'confirm', text: t };
  if (/^\/(?:panic|紧急关闭)$/i.test(t) || /^紧急关闭$/.test(t)) return { type: 'panic' };
  if (/^\/cancel$/i.test(t) || /^取消申请$/.test(t)) return { type: 'cancel' };

  let m = /^\/mode(?:\s+(\S+))?(?:\s+(\S+))?$/i.exec(t);
  if (m) {
    if (!m[1] || m[1] === 'status') return { type: 'status' };
    const mode = MODE_WORDS[m[1].toLowerCase()] ?? MODE_WORDS[m[1]] ?? null;
    if (!mode) return { type: 'error', text: `未知模式「${m[1]}」。可用：chat / reserved / reserved2（simulation）/ agent（closed-agent）` };
    const level = m[2] ? parseLevel(m[2]) : null;
    if (m[2] && !level) return { type: 'error', text: `未知权限级别「${m[2]}」。可用：L1 / L2 / L3` };
    return { type: 'mode', mode, level };
  }
  m = /^\/(?:level|perm|permission|permissions)(?:\s+(\S+))?$/i.exec(t);
  if (m) {
    if (!m[1]) return { type: 'status' };
    if (/^danger-full-access$/i.test(m[1])) {
      return { type: 'error', text: '不允许从 QQ 开启 danger-full-access：它的审批策略是 never（不弹审批直接执行）。需要高权限请用 /level L3（完全访问 + 每次审批，需 TOTP）。' };
    }
    const level = parseLevel(m[1]);
    if (!level) return { type: 'error', text: `未知权限级别「${m[1]}」。可用：L1（只读）/ L2（工作区）/ L3（完全访问+审批）/ L0（回到群友模式）` };
    if (level === 'L0') return { type: 'mode', mode: null, level: 'L0' };
    return { type: 'mode', mode: 'closed-agent', level };
  }
  if (/^\/approvals$/i.test(t)) return { type: 'approvals' };
  m = /^\/audit(?:\s+(\d{1,3}))?$/i.exec(t);
  if (m) return { type: 'audit', count: m[1] ? Number(m[1]) : 10 };
  if (/^\/(?:admin|管理|adminhelp)$/i.test(t)) return { type: 'help' };

  // ── 人物档案 ──
  m = /^\/whois\s+(\d{1,12})$/i.exec(t);
  if (m) return { type: 'whois', userId: m[1] };
  m = /^\/people(?:\s+(.+))?$/i.exec(t);
  if (m) return { type: 'people', query: m[1] ?? '' };
  m = /^\/person\s+(\d{1,12})\s+(name|称呼)\s+(.+)$/i.exec(t);
  if (m) return { type: 'person-name', userId: m[1], name: m[3] };
  m = /^\/person\s+(\d{1,12})\s+(?:level|熟悉度)\s+(listed|observed|talked|familiar)$/i.exec(t);
  if (m) return { type: 'person-acq', userId: m[1], level: m[2].toLowerCase() };
  m = /^\/person\s+(\d{1,12})\s+(?:avoid|不喜欢)\s+(teasing|proactiveChat|poke|recallPast)$/i.exec(t);
  if (m) return { type: 'person-pref', userId: m[1], key: m[2], value: 'avoid' };
  m = /^\/person\s+(\d{1,12})\s+(?:ok|可以)\s+(teasing|proactiveChat|poke|recallPast)$/i.exec(t);
  if (m) return { type: 'person-pref', userId: m[1], key: m[2], value: 'ok' };
  m = /^\/person\s+(\d{1,12})\s+alias\s+(\d{1,12})$/i.exec(t);
  if (m) return { type: 'person-alias', userId: m[1], alias: m[2] };
  m = /^\/person\s+(\d{1,12})\s+(?:forget|删除)$/i.exec(t);
  if (m) return { type: 'person-forget', userId: m[1] };
  m = /^\/note\s+(\d{1,12})\s+(.+)$/i.exec(t);
  if (m) return { type: 'note-global', userId: m[1], text: m[2] };
  m = /^\/note-del\s+(\d{1,12})\s+(n\d+)$/i.exec(t);
  if (m) return { type: 'note-del', userId: m[1], noteId: m[2] };
  m = /^\/share\s+(approve|reject|批准|驳回)\s+(\d{1,12})\s+(n\d+)$/i.exec(t);
  if (m) return { type: 'share-review', approve: /approve|批准/i.test(m[1]), userId: m[2], noteId: m[3] };
  if (/^\/review$/i.test(t)) return { type: 'review' };

  // ── 代为发言（原话转发到白名单群；会在她的记忆里标注「受管理员之托」）──
  m = /^\/say\s+(\d{1,12})\s+([\s\S]+)$/i.exec(raw);
  if (m) return { type: 'say', groupId: m[1], text: m[2].trim() };

  // 其余特权斜杠命令：拦截，不透传。
  m = /^\/([a-z][a-z0-9_-]*)/i.exec(t);
  if (m && PRIVILEGED_SLASH.has(m[1].toLowerCase())) {
    return { type: 'blocked-slash', name: m[1].toLowerCase() };
  }

  if (naturalLanguage) {
    // 确定性的自然语言意图（正则，不经过模型）。只会**登记申请**或执行降级，不会直接提权。
    if (/^(?:请)?(?:帮我)?(?:切换?到|切回|进入|开启|打开)\s*(?:agent|运维|closed-agent|管理)\s*模式[。！!]?$/i.test(t)) {
      return { type: 'mode', mode: 'closed-agent', level: null, natural: true };
    }
    if (/^(?:请)?(?:帮我)?(?:切回|回到|退出agent|退出 agent|恢复)\s*(?:群友|聊天|仿真|二代)?\s*模式[。！!]?$/i.test(t) || /^退出\s*agent\s*模式[。！!]?$/i.test(t)) {
      return { type: 'mode', mode: null, level: 'L0', natural: true };
    }
    m = /^(?:请)?(?:把)?权限(?:提升|调|改|切换?)?到\s*(L[1-3]|只读|工作区|完全访问)[。！!]?$/i.exec(t);
    if (m) return { type: 'mode', mode: 'closed-agent', level: parseLevel(m[1]), natural: true };
  }
  return null;
}

export const ADMIN_HELP = [
  '【管理通道命令】（仅 owner 私聊有效，由桥接直接执行，不经过 AI）',
  '/mode —— 查看当前模式与权限',
  '/mode reserved2 | chat | reserved —— 切换群友模式（降级一步完成）',
  '/mode agent [L1|L2|L3] —— 申请切换到运维 Agent（需回复确认码；L3 还需 TOTP）',
  '/level L1|L2|L3|L0 —— 调整权限级别（升级需确认，降级立即生效）',
  '确认 <码> [6位动态码] —— 确认申请；/cancel 取消所有待确认申请',
  '/panic —— 紧急关闭：立刻回到安全模式',
  '/approvals —— 查看待审批；回复「通过 #编号」/「拒绝 #编号」',
  '/whois <QQ> · /people [关键词] · /review —— 人物档案与待审核',
  '/person <QQ> name <称呼> | level <熟悉度> | avoid/ok <偏好> | alias <QQ> | forget',
  '/note <QQ> <内容> —— 写一条跨群共享的全局记忆；/note-del <QQ> <编号>',
  '/share approve|reject <QQ> <编号> —— 批准/驳回 AI 提交的跨群共享申请',
  '/say <群号> <内容> —— 以机器人身份在白名单群原话发言',
  '/audit [条数] —— 查看最近的管理审计记录',
].join('\n');
