// v0.3.0 新功能的组装点：人物库、管理审计、模式/权限控制器、审批登记表、owner 管理命令。
//
// bridge.js 只负责接线（在消息入口、事件流、控制台路由里调用这里的函数），
// 业务规则都在 src/social/* 与 src/admin/* 里，便于离线测试。
//
// 状态文件（都在 state/ 下，随 state ACL 一起收紧，不入库）：
//   state/social/people.json     人物库（含各群名片、成员关系、分层记忆）
//   state/admin/control.json     当前模式/级别、待确认申请、TOTP 防重放计数
//   state/admin/audit.jsonl      管理审计（哈希链）
//   state/admin/totp.json        TOTP 秘密（npm run admin:totp-setup 生成；也可用环境变量）

import fs from 'node:fs';
import path from 'node:path';
import { createPeopleRegistry, normalizeQQ, normalizeGroupId } from './social/people.js';
import { buildPersonView, renderPeopleBlock } from './social/memory-policy.js';
import { createAuditLog } from './admin/audit-log.js';
import { createModeController, LEVEL_TEXT, MODE_TEXT } from './admin/mode-control.js';
import { createApprovalRegistry, describeToolArgs } from './admin/approvals.js';
import { parseOwnerCommand, ADMIN_HELP } from './admin/owner-commands.js';

// bridge.js 只 import 这一个模块（测试夹具按名字注入绑定，入口越少越不容易漂移）。
export { normalizeMemberNotice, processMemberEvent, joinWakeInstruction } from './social/group-events.js';
export { checkCrossGroup, queryPresence, queryActivity } from './social/cross-group.js';
export { resolveLevelPlan, permissionCommandSucceeded } from './admin/dsh-permission.js';
export { L0_MODES, LEVEL_TEXT } from './admin/mode-control.js';
export { createReconnectWatchdog } from './lib/ws-watchdog.mjs';
export { describeAgentError, agentErrorUserText, isConfigError } from './lib/agent-errors.mjs';
/** 斜杠命令守卫：不做自然语言识别，只判断「这是不是管理/特权命令」。 */
export function parseOwnerCommandForGuard(text) {
  return parseOwnerCommand(text, { naturalLanguage: false });
}

// 只抹掉「凭据赋值」形态（给 owner 看审批参数时用：路径要保留，否则就是盲批）。实现在 src/lib/redact.mjs（控制中心也用）。
export { redactCredentials } from './lib/redact.mjs';
import { redactCredentials } from './lib/redact.mjs';

/** 读取 TOTP 秘密：环境变量优先，其次 state/admin/totp.json。秘密不会被打印或发给模型。 */
export function loadTotpSecret(stateDir, env = process.env) {
  const fromEnv = String(env.QQ_BRIDGE_TOTP_SECRET ?? '').trim();
  if (fromEnv) return fromEnv;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(stateDir, 'admin', 'totp.json'), 'utf8').trim());
    const s = String(raw?.secret ?? '').trim();
    return s || null;
  } catch {
    return null;
  }
}

function fmt(t) {
  if (!t) return '—';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * @param {object} deps
 * @param {object} deps.cfg                  桥接的内存配置对象（热更新时同一个引用）
 * @param {string} deps.stateDir
 * @param {(...a:any[])=>void} deps.log
 * @param {(text:string)=>Promise<void>} deps.notifyOwner
 * @param {(target:{mode,level}, ctx:object)=>Promise<void>} deps.applyMode
 * @param {(entry:object)=>Promise<void>} deps.onApprovalTimeout
 * @param {() => number} [deps.now]
 */
export function createBridgeExtensions({ cfg, stateDir, log, notifyOwner, applyMode, onApprovalTimeout, now = Date.now, env = process.env }) {
  const logLine = (m) => log(m);
  const people = createPeopleRegistry({
    file: path.join(stateDir, 'social', 'people.json'),
    log: logLine,
    now,
    dedupeWindowMs: Number(cfg.continuity?.dedupeWindowMs) || 10 * 60 * 1000,
  });
  try { people.load(); } catch (error) { log(`⚠️ 人物库加载失败：${error?.message ?? error}（本次运行不记录人物）`); }
  const audit = createAuditLog({ file: path.join(stateDir, 'admin', 'audit.jsonl'), log: logLine, now });
  const getTotpSecret = () => loadTotpSecret(stateDir, env);
  const controller = createModeController({
    file: path.join(stateDir, 'admin', 'control.json'),
    config: cfg.admin ?? {},
    applyMode,
    notifyOwner,
    audit,
    getTotpSecret,
    now,
    log: logLine,
  });
  const approvals = createApprovalRegistry({
    timeoutMs: Math.max(10_000, Number(cfg.questionTimeoutMs) || 300_000),
    onTimeout: async (entry) => {
      audit.append('approval.timeout', { id: entry.id, key: entry.key, tool: entry.toolName });
      await onApprovalTimeout?.(entry);
    },
    now,
    // 编号跨重启不复用：从控制器持久化的最大编号继续。
    startId: (() => { try { return controller.approvalSeq; } catch { return 0; } })(),
  });

  const continuity = () => cfg.continuity ?? {};
  const continuityEnabled = () => cfg.continuity?.enabled !== false;
  const adminEnabled = () => cfg.admin?.enabled !== false && !!normalizeQQ(cfg.ownerQQ);
  const isOwnerPrivateKey = (key) => !!normalizeQQ(cfg.ownerQQ) && key === `private:${normalizeQQ(cfg.ownerQQ)}`;

  function groupRecordable(groupId) {
    return cfg.continuity?.groups?.[String(groupId)]?.recordable !== false;
  }

  /** 消息入口调用：记录「看到此人发言」。返回 people.observeMessage 的结果或 null。 */
  function observeMessage({ kind, id, event, directedAtSelf }) {
    if (!continuityEnabled()) return null;
    if (kind === 'group' && !groupRecordable(id)) return null;
    try {
      return people.observeMessage({
        kind,
        groupId: kind === 'group' ? id : null,
        userId: event?.user_id ?? event?.sender?.user_id,
        card: kind === 'group' ? (event?.sender?.card ?? '') : '',
        nickname: event?.sender?.nickname ?? '',
        directedAtSelf: !!directedAtSelf,
      });
    } catch (error) {
      log(`人物库记录失败：${error?.message ?? error}`);
      return null;
    }
  }

  /** 唤醒提示词的「在场人物」小节（按需注入：只含本轮消息里出现的人）。 */
  function peopleBlockFor(key, userIds) {
    if (!continuityEnabled() || cfg.continuity?.injectPeople === false) return '';
    const m = /^group:(\d+)$/.exec(key);
    if (m && !groupRecordable(m[1])) return '';
    const seen = new Set();
    const persons = [];
    for (const uid of userIds) {
      const qq = normalizeQQ(uid);
      if (!qq || seen.has(qq) || qq === normalizeQQ(cfg.ownerQQ) && key.startsWith('private:')) continue;
      seen.add(qq);
      const p = people.getPerson(qq);
      if (p) persons.push(p);
    }
    return renderPeopleBlock(persons, key, continuity(), {
      maxPeople: Number(cfg.continuity?.injectMaxPeople) || 8,
      maxChars: Number(cfg.continuity?.injectMaxChars) || 1500,
      now: now(),
    });
  }

  /** AI 工具用：当前会话可见的某人视图（已按可见性过滤）。 */
  function personViewFor(key, userId) {
    const p = people.getPerson(userId);
    if (!p) return null;
    const m = /^group:(\d+)$/.exec(key);
    if (m && !groupRecordable(m[1])) return null;
    const v = buildPersonView(p, key, continuity(), { now: now(), maxNotes: 10 });
    if (!v) return null;
    const { text, ...rest } = v;
    return rest;
  }

  function renderApprovalRequest(entry, { key, auditKey, redactAll }) {
    const redact = auditKey ? redactAll : redactCredentials;
    const lines = [`🔐 审批 #${entry.id}：agent 请求使用工具「${redact(entry.toolName || '未知')}」`];
    if (entry.reason) lines.push(`理由：${redact(entry.reason).slice(0, 300)}`);
    if (entry.argsKnown) {
      const shown = describeToolArgs(entry.args, { redact, maxChars: Number(cfg.admin?.approvalArgsMaxChars) || 600 });
      if (shown) lines.push(`参数：\n${shown}`);
    } else {
      lines.push('参数：（桥接没有收到这次调用的参数，无法展示具体命令——如不确定请拒绝）');
    }
    const timeoutMin = Math.round((entry.expiresAt - entry.createdAt) / 60000);
    lines.push(`回复「通过 #${entry.id}」或「拒绝 #${entry.id}」，${timeoutMin} 分钟内不回复自动拒绝。只放行这一次操作。`);
    return lines.join('\n');
  }

  function statusText() {
    const c = controller.current();
    const pend = controller.pendingRequests();
    const appr = approvals.list();
    const lines = [
      `当前模式：${MODE_TEXT[c.mode] ?? c.mode ?? '（未初始化）'}`,
      `权限级别：${LEVEL_TEXT[c.level] ?? c.level}`,
      `最近变更：${fmt(c.changedAt)}（${c.changedBy ?? '—'}）`,
    ];
    if (c.level !== 'L0') lines.push(`高权限开始：${fmt(c.elevatedAt)}；最近活动：${fmt(c.lastActivityAt)}`);
    if (pend.length) lines.push(`待确认申请：${pend.map((r) => `#${r.id}→${r.target.mode}/${r.target.level}`).join('、')}`);
    if (appr.length) lines.push(`待审批：${appr.map((a) => `#${a.id} ${a.toolName}`).join('、')}`);
    lines.push(`TOTP：${getTotpSecret() ? '已配置' : '未配置（L3 不可用）'}`);
    const s = people.stats();
    lines.push(`人物库：${s.people} 人 / ${s.notes} 条记忆 / 待审核共享 ${s.pendingShare} / 迁移待确认 ${s.legacyReview}`);
    return lines.join('\n');
  }

  function whoisText(qq) {
    const p = people.getPerson(qq);
    if (!p) return `人物库里没有 QQ ${qq}。`;
    const lines = [`QQ ${p.qq}${p.nickname ? `（昵称 ${p.nickname}）` : ''}`, `认识程度：${p.acquaintance}${p.acquaintanceSetBy === 'admin' ? '（管理员设定）' : ''}；首次见到 ${fmt(p.firstSeenAt)}；最近 ${fmt(p.lastSeenAt)}`];
    if (p.preferredName) lines.push(`跨群称呼：${p.preferredName.value}`);
    for (const [gid, g] of Object.entries(p.groups)) {
      lines.push(`· 群 ${gid}：${g.status === 'member' ? '在群' : '已离开'}，名片「${g.card || '—'}」，发言 ${g.messageCount} 条${g.cardHistory?.length > 1 ? `，曾用 ${g.cardHistory.slice(0, -1).map((h) => h.value).join('/')}` : ''}`);
    }
    if (p.private) lines.push(`· 私聊：${p.private.messageCount} 条`);
    const showPrivate = cfg.admin?.showPrivateNotes === true;
    for (const n of p.notes) {
      if (n.scope.startsWith('private:') && !showPrivate) continue;
      lines.push(`  [${n.id}] ${n.scope}${n.shareStatus === 'pending' ? '（申请共享）' : n.shareStatus === 'approved' && n.scope !== 'global' ? '（已共享）' : ''}：${n.text}`);
    }
    const privateCount = p.notes.filter((n) => n.scope.startsWith('private:')).length;
    if (privateCount && !showPrivate) lines.push(`  （另有 ${privateCount} 条私聊来源的记忆，默认不在管理通道显示；控制台可查看）`);
    if (Object.keys(p.preferences).length) lines.push(`互动偏好：${Object.entries(p.preferences).map(([k, v]) => `${k}=${v}`).join('，')}`);
    if (p.aliases.length) lines.push(`管理员关联的小号：${p.aliases.join('、')}`);
    return lines.join('\n');
  }

  function reviewText() {
    const lines = [];
    for (const p of Object.values(people.data.people)) {
      for (const n of p.notes) if (n.shareStatus === 'pending') lines.push(`共享申请：QQ ${p.qq} [${n.id}] ${n.scope}：${n.text}  → /share approve ${p.qq} ${n.id}`);
    }
    for (const r of (people.data.legacyReview ?? []).slice(-10)) {
      lines.push(`旧记忆待确认：${r.scope} 名字「${r.name}」（${r.reason}${r.candidates?.length ? `，候选 ${r.candidates.join('/')}` : ''}）：${(r.traits ?? []).join('、')}`);
    }
    return lines.length ? lines.slice(0, 30).join('\n') : '没有待审核的条目。';
  }

  /**
   * owner 私聊管理命令的执行。由 bridge 在消息交给模型之前调用。
   * @param {string} text
   * @param {object} ctx
   * @param {(groupId:string, text:string)=>Promise<string>} ctx.say   代为发言（bridge 负责白名单与发送）
   * @returns {Promise<{handled:boolean, reply?:string}>}
   */
  async function handleOwnerText(text, { say } = {}) {
    if (!adminEnabled()) return { handled: false };
    const cmd = parseOwnerCommand(text, { naturalLanguage: cfg.admin?.naturalLanguage !== false });
    if (!cmd) return { handled: false };
    const reply = (r) => ({ handled: true, reply: r });
    try {
      switch (cmd.type) {
        case 'confirm': {
          const r = await controller.confirm(cmd.text);
          return reply(r.text ?? '');
        }
        case 'cancel': {
          const n = await controller.cancelAll('owner');
          return reply(n ? `已取消 ${n} 个待确认申请。` : '没有待确认的申请。');
        }
        case 'panic': {
          const r = await controller.panic('panic');
          return reply(r.ok ? '' : `紧急关闭失败：${r.error}（请直接停止桥接进程）`);
        }
        case 'status':
          return reply(statusText());
        case 'help':
          return reply(ADMIN_HELP);
        case 'mode': {
          const mode = cmd.mode ?? (controller.options.safeMode);
          const r = await controller.requestChange({ mode, level: cmd.level }, { origin: cmd.natural ? 'nl' : 'command' });
          // 已执行（降级）时统一通知已经发过，这里不再重复。
          return reply(r.status === 'applied' ? '' : r.text);
        }
        case 'error':
          return reply(cmd.text);
        case 'blocked-slash':
          audit.append('slash.blocked', { name: cmd.name });
          return reply(`「/${cmd.name}」会影响权限、工具或运行状态，已由桥接拦截，不会转交 DSH。改模式/权限请用 /mode 或 /level（发 /admin 查看命令）。`);
        case 'approvals': {
          const list = approvals.list();
          return reply(list.length ? list.map((e) => `#${e.id} ${e.key} 工具 ${e.toolName}（${Math.max(0, Math.round((e.expiresAt - now()) / 1000))} 秒后超时）`).join('\n') : '没有待审批。');
        }
        case 'audit': {
          const rows = audit.tail(Math.min(50, cmd.count));
          const v = audit.verify();
          return reply([`审计哈希链：${v.ok ? '完整' : `第 ${v.brokenAt} 行起不一致（可能被改动）`}`, ...rows.map((r) => `${r.time?.slice(5, 16) ?? ''} ${r.event} ${r.source ?? r.origin ?? ''} ${r.to ? `${r.to.mode}/${r.to.level}` : ''}`.trim())].join('\n'));
        }
        case 'whois':
          return reply(whoisText(cmd.userId));
        case 'people': {
          const list = people.listPeople({ query: cmd.query, limit: 20 });
          return reply(list.length ? list.map((p) => `${p.qq} ${p.nickname || ''} [${Object.entries(p.groups).map(([g, x]) => `${g}:${x.card || '—'}`).join(' ')}] ${p.acquaintance}`).join('\n') : '没有匹配的人物。');
        }
        case 'person-name':
          people.updatePerson(cmd.userId, { preferredName: cmd.name });
          audit.append('person.updated', { userId: cmd.userId, field: 'preferredName' });
          return reply(`已设置 QQ ${cmd.userId} 的跨群称呼为「${cmd.name.slice(0, 30)}」。`);
        case 'person-acq':
          people.updatePerson(cmd.userId, { acquaintance: cmd.level });
          audit.append('person.updated', { userId: cmd.userId, field: 'acquaintance' });
          return reply(`已设置 QQ ${cmd.userId} 的认识程度为 ${cmd.level}。`);
        case 'person-pref':
          people.updatePerson(cmd.userId, { preferences: { [cmd.key]: cmd.value } });
          audit.append('person.updated', { userId: cmd.userId, field: `preferences.${cmd.key}` });
          return reply(`已记录：QQ ${cmd.userId} 对「${cmd.key}」${cmd.value === 'avoid' ? '不喜欢' : '可以'}。`);
        case 'person-alias':
          people.updatePerson(cmd.userId, { addAlias: cmd.alias });
          audit.append('person.updated', { userId: cmd.userId, field: 'aliases' });
          return reply(`已把 QQ ${cmd.alias} 记为 QQ ${cmd.userId} 的小号（只是管理员标注，不会合并两份档案）。`);
        case 'person-forget': {
          const ok = people.deletePerson(cmd.userId);
          audit.append('person.deleted', { userId: cmd.userId, ok });
          return reply(ok ? `已彻底删除 QQ ${cmd.userId} 的全部记录。` : `人物库里没有 QQ ${cmd.userId}。`);
        }
        case 'note-global': {
          const n = people.addNote(cmd.userId, { text: cmd.text, scope: 'global', origin: 'admin', certainty: 'explicit', pinned: true });
          audit.append('person.note_added', { userId: cmd.userId, noteId: n.id, scope: 'global' });
          return reply(`已添加全局记忆 [${n.id}]（仅在 sharePolicy=shared 的群里可见）。`);
        }
        case 'note-del': {
          const ok = people.deleteNote(cmd.userId, cmd.noteId);
          audit.append('person.note_deleted', { userId: cmd.userId, noteId: cmd.noteId, ok });
          return reply(ok ? '已删除。' : '没有这条记忆。');
        }
        case 'share-review': {
          const n = people.reviewNote(cmd.userId, cmd.noteId, cmd.approve);
          audit.append('person.share_reviewed', { userId: cmd.userId, noteId: cmd.noteId, approve: cmd.approve, ok: !!n });
          return reply(n ? `已${cmd.approve ? '批准' : '驳回'}共享 [${n.id}]。` : '没有这条记忆。');
        }
        case 'review':
          return reply(reviewText());
        case 'say': {
          if (typeof say !== 'function') return reply('当前不支持代为发言。');
          const r = await say(cmd.groupId, cmd.text);
          audit.append('owner.say', { groupId: cmd.groupId, chars: cmd.text.length, result: r });
          return reply(r);
        }
        default:
          return { handled: false };
      }
    } catch (error) {
      return reply(`命令执行失败：${error?.message ?? error}`);
    }
  }

  return {
    people,
    audit,
    controller,
    approvals,
    getTotpSecret,
    continuity,
    continuityEnabled,
    adminEnabled,
    isOwnerPrivateKey,
    groupRecordable,
    observeMessage,
    peopleBlockFor,
    personViewFor,
    renderApprovalRequest,
    handleOwnerText,
    statusText,
    whoisText,
    normalizeQQ,
    normalizeGroupId,
  };
}
export { resolveDshBaseUrl, dshBaseUrlCandidates, detectDshDesktop } from './lib/dsh-endpoint.mjs';
export { isNapCatVersionInfo, looksLikePathOnlyError, stickerTempBase, writeTempSticker, findFavByMd5, napcatAddOk } from './social/sticker-collect.js';
export { GROUP_RULE_LIMITS, validateOwnerGroupAccess, normalizeRules, addRule, removeRule, rulesPromptBlock, peekView, groupRuleResultText, groupRuleNoticeText } from './social/group-rules.js';
export { OWNER_RELAY_DEFAULTS, ownerRelayConfig, validateOwnerRelay, createOwnerRelayLimiter, createOwnerRelayStore, ownerRelayPromptBlock, ownerRelayResultText, ownerRelayNoticeText } from './social/owner-relay.js';
export { qqBackendFromVersionInfo, qqBackendLabel } from './lib/qq-backend-label.js';
export { classifyDshError, createDshHealth } from './lib/dsh-health.js';
