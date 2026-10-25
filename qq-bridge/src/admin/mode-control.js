// 运行模式与权限级别的**唯一**变更入口（桥接侧确定性代码，不经过模型）。
//
// 级别：
//   L0  群友模式：chat / reserved / reserved2，会话只挂 qq-chat* 安全 preset，无本地工具
//   L1  本地只读 Agent：closed-agent，仅 owner 私聊，DSH 权限预设 qq-l1-readonly（read-only + 审批）
//   L2  工作区读写 Agent：closed-agent，qq-l2-workspace（workspace-write + 审批）
//   L3  高权限 Agent：closed-agent，qq-l3-full-ask（danger-full-access + **仍然审批**）
//   不存在、也不允许从 QQ 开启「完全访问 + 免审批」。
//
// 规则：
//   · 升级（级别变高）必须：owner 私聊发起 → 桥接发确认码 → owner 回「确认 <码>」；
//     L3 还要在同一条确认里附 TOTP 动态码（「确认 <码> <6位动态码>」）。
//   · 降级（级别变低）与紧急关闭一步完成，不需要确认。
//   · 同级的 L0 模式之间切换（chat ↔ reserved2 等）不涉及提权，直接执行并通知。
//   · AI 最多只能「登记申请」（requestChange，origin='ai-tool'），确认码由桥接直接发给 owner，
//     确认消息由桥接在交给模型之前拦截。模型没有任何确认/执行入口。
//   · 每次变更（成功或失败）都写审计并私聊通知 owner：前后模式、级别、来源、时间、结果。
//   · 高权限闲置超时 / 超过最长时长自动回落到 safeMode（默认 reserved2 / L0）。
//
// 本模块不直接碰 DSH 或 QQ：真正的切换由 deps.applyMode 执行，通知由 deps.notifyOwner 发送。

import crypto from 'node:crypto';
import { createJsonStore } from '../lib/json-store.js';
import { verifyTotp } from './totp.js';

export const LEVELS = ['L0', 'L1', 'L2', 'L3'];
export const L0_MODES = ['chat', 'reserved', 'reserved2'];
export const LEVEL_TEXT = {
  L0: 'L0 群友模式（无本地工具）',
  L1: 'L1 本地只读 Agent（敏感操作需审批）',
  L2: 'L2 工作区读写 Agent（危险操作需审批）',
  L3: 'L3 高权限 Agent（二次认证 + 每次操作审批）',
};
export const MODE_TEXT = {
  chat: 'chat（普通聊天）',
  reserved: 'reserved（一代仿真）',
  reserved2: 'reserved2（二代仿真）',
  'closed-agent': 'closed-agent（owner 私聊 Agent）',
};

export function levelRank(level) {
  const i = LEVELS.indexOf(level);
  return i < 0 ? 0 : i;
}

/** 把 (mode, level) 规整成合法组合：L0 只配 L0 模式，closed-agent 只配 L1~L3。 */
export function normalizeTarget(mode, level, { defaultAgentLevel = 'L1' } = {}) {
  const m = String(mode ?? '').trim();
  if (m === 'closed-agent') {
    const lv = LEVELS.includes(level) && level !== 'L0' ? level : defaultAgentLevel;
    return { mode: 'closed-agent', level: lv };
  }
  if (L0_MODES.includes(m)) return { mode: m, level: 'L0' };
  return null;
}

/** 解析「确认 1234」「确认 1234 567890」「/confirm 1234 567890」。 */
export function parseConfirm(text) {
  const t = String(text ?? '').trim().replace(/\s+/g, ' ');
  const m = /^(?:确认|确定|\/confirm)\s*(\d{4,8})(?:\s+(\d{6}))?$/i.exec(t);
  return m ? { code: m[1], totp: m[2] ?? null } : null;
}

function emptyState() {
  return {
    mode: null,          // 控制器认可的当前模式；null = 尚未初始化
    level: 'L0',
    changedAt: 0,
    changedBy: null,
    elevatedAt: 0,
    elevatedEndedAt: 0,
    lastActivityAt: 0,
    requestSeq: 0,
    requests: [],
    totp: { lastUsedCounter: -1, failures: [], lockedUntil: 0 },
    approvalSeq: 0,
  };
}

/**
 * @param {object} o
 * @param {string} o.file                   state/admin/control.json
 * @param {object} o.config                 config.admin（见 config.example.json）
 * @param {(target:{mode,level}, ctx:object)=>Promise<void>} o.applyMode   真正执行切换；抛错 = 失败
 * @param {(text:string)=>Promise<void>} o.notifyOwner                    私聊通知 owner（失败不影响流程）
 * @param {object} o.audit                  audit-log.js 实例
 * @param {() => string|null} o.getTotpSecret
 * @param {() => number} [o.now]
 * @param {(m:string)=>void} [o.log]
 */
export function createModeController({ file, config = {}, applyMode, notifyOwner, audit, getTotpSecret = () => null, now = Date.now, log = () => {} }) {
  const store = createJsonStore({ file, version: 1, empty: emptyState, log });
  const st = () => store.data;
  const opts = () => ({
    safeMode: L0_MODES.includes(config.safeMode) ? config.safeMode : 'reserved2',
    defaultAgentLevel: ['L1', 'L2', 'L3'].includes(config.defaultAgentLevel) ? config.defaultAgentLevel : 'L1',
    codeDigits: Math.min(8, Math.max(4, Number(config.confirmCodeDigits) || 4)),
    requestTtlMs: Math.max(30_000, Number(config.requestTtlMs) || 120_000),
    maxAttempts: Math.max(1, Number(config.maxConfirmAttempts) || 3),
    maxPending: Math.max(1, Number(config.maxPendingRequests) || 3),
    idleTimeoutMs: Number(config.idleTimeoutMs) >= 0 ? Number(config.idleTimeoutMs ?? 1_800_000) : 1_800_000,
    maxElevatedMs: {
      L1: Number(config.maxElevatedMs?.L1) || 4 * 3600_000,
      L2: Number(config.maxElevatedMs?.L2) || 2 * 3600_000,
      L3: Number(config.maxElevatedMs?.L3) || 3600_000,
    },
    totpMaxFailures: Math.max(1, Number(config.totpMaxFailures) || 5),
    totpLockMs: Math.max(60_000, Number(config.totpLockMs) || 15 * 60_000),
    allowL3: config.allowL3 !== false,
    externalEscalation: config.externalEscalation === 'alert' ? 'alert' : 'revert',
    // 控制台提权冷却：高权限期间与刚回落后的一段时间内，控制台不能提权（防止高权限 Agent 用本机读到的
    // 控制台令牌先降级、再自己提权；见 docs/guides/ADMIN_CHANNEL.md「已知限制」）。
    consoleEscalationCooldownMs: Number(config.consoleEscalationCooldownMs) >= 0 ? Number(config.consoleEscalationCooldownMs ?? 600_000) : 600_000,
  });
  let busy = Promise.resolve();
  let timer = null;
  let initialized = false;

  function save() { try { store.save(); } catch (error) { log(`⚠️ 管理状态写盘失败：${error?.message ?? error}`); } }

  function serialize(fn) {
    // 所有状态变更串行执行：并发申请/确认/回落不会交错覆盖。
    const run = busy.then(fn, fn);
    busy = run.catch(() => {});
    return run;
  }

  function fmtTime(t) {
    const d = new Date(t);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  async function safeNotify(text) {
    try { await notifyOwner(text); } catch (error) { log(`⚠️ owner 通知发送失败：${error?.message ?? error}`); }
  }

  /**
   * 执行一次变更并统一通知。所有入口（QQ 管理通道、控制台、自动回落、外部变更回退）最终都走这里。
   * @param {{mode,level}} target
   * @param {string} source  qq-command / qq-confirm / console / auto-idle / auto-max / external-revert / startup
   */
  async function transition(target, source, meta = {}) {
    const before = { mode: st().mode, level: st().level };
    const at = now();
    let ok = true;
    let error = null;
    try {
      await applyMode(target, { source, ...meta });
    } catch (e) {
      ok = false;
      error = String(e?.message ?? e).slice(0, 300);
    }
    if (ok) {
      st().mode = target.mode;
      st().level = target.level;
      st().changedAt = at;
      st().changedBy = source;
      if (levelRank(target.level) > 0) {
        if (levelRank(before.level) === 0 || target.level !== before.level) st().elevatedAt = at;
        st().lastActivityAt = at;
      } else {
        if (levelRank(before.level) > 0) st().elevatedEndedAt = at;
        st().elevatedAt = 0;
      }
      // 任何成功的变更都让未完成的升级申请作废（避免「先降级、再用旧码升级」）。
      if (levelRank(target.level) < levelRank(before.level) || target.mode !== before.mode) {
        for (const r of st().requests) if (r.status === 'pending') r.status = 'superseded';
      }
      save();
    }
    audit?.append(ok ? 'mode.changed' : 'mode.change_failed', { from: before, to: target, source, ok, error, ...meta.auditExtra });
    const lines = [
      `${ok ? '🔔 模式已变更' : '⚠️ 模式变更失败'}：${before.mode ?? '（未知）'} → ${target.mode}`,
      `当前权限：${LEVEL_TEXT[ok ? target.level : before.level] ?? (ok ? target.level : before.level)}`,
      `来源：${sourceText(source)}（${fmtTime(at)}）`,
      `结果：${ok ? '成功' : `失败（${error}）`}`,
    ];
    if (ok && target.mode === 'closed-agent') lines.push('现在私聊里回复你的是运维 Agent（独立 DSH 会话），不是群友人格；群聊暂停响应。');
    if (ok && levelRank(target.level) > 0 && opts().idleTimeoutMs > 0) lines.push(`闲置 ${Math.round(opts().idleTimeoutMs / 60000)} 分钟或满 ${Math.round(opts().maxElevatedMs[target.level] / 60000)} 分钟后自动回落到 ${opts().safeMode}。发 /panic 可立即关闭。`);
    if (meta.alert) lines.unshift('🚨 告警：检测到不是经 QQ 管理通道/控制台发起的模式变更，请确认是否本人操作。');
    if (!meta.silent) await safeNotify(lines.join('\n'));
    return { ok, error, before, after: ok ? target : before };
  }

  function sourceText(s) {
    return ({
      'qq-command': 'QQ 管理通道（直接命令）',
      'qq-confirm': 'QQ 管理通道（申请 + 确认码）',
      console: '桥接控制台',
      'auto-idle': '自动回落（闲置超时）',
      'auto-max': '自动回落（超过最长时长）',
      'external-revert': '外部变更被回退',
      'external-accept': 'DSH 设置（外部变更）',
      startup: '启动校验',
      panic: '紧急关闭（/panic）',
    })[s] ?? s;
  }

  function newCode() {
    const digits = opts().codeDigits;
    const used = new Set(st().requests.filter((r) => r.status === 'pending').map((r) => r.code));
    for (let i = 0; i < 20; i += 1) {
      const c = String(crypto.randomInt(0, 10 ** digits)).padStart(digits, '0');
      if (!used.has(c)) return c;
    }
    throw new Error('无法生成唯一确认码');
  }

  function expireRequests() {
    const t = now();
    let changed = false;
    for (const r of st().requests) {
      if (r.status === 'pending' && t > r.expiresAt) { r.status = 'expired'; changed = true; audit?.append('mode.request_expired', { id: r.id, target: r.target }); }
    }
    // 只保留最近 50 条申请记录。
    if (st().requests.length > 50) { st().requests.splice(0, st().requests.length - 50); changed = true; }
    if (changed) save();
  }

  function current() {
    return { mode: st().mode, level: st().level, changedAt: st().changedAt, changedBy: st().changedBy, elevatedAt: st().elevatedAt, lastActivityAt: st().lastActivityAt };
  }

  /**
   * 登记一次变更申请（升级）或直接执行（降级/同级）。
   * @param {{mode, level?}} want
   * @param {{origin:'command'|'nl'|'ai-tool'|'console', reason?:string}} ctx
   * @returns {Promise<{status:'applied'|'pending'|'noop'|'rejected', text:string, request?:object}>}
   */
  function requestChange(want, ctx = {}) {
    return serialize(async () => {
      if (!initialized) return { status: 'rejected', text: '管理通道还在做启动校验（等待 DSH 就绪），请稍后再试。' };
      expireRequests();
      const o = opts();
      const target = normalizeTarget(want?.mode, want?.level, { defaultAgentLevel: o.defaultAgentLevel });
      if (!target) return { status: 'rejected', text: `无法识别的目标模式：${want?.mode ?? ''}。可用：${[...L0_MODES, 'closed-agent'].join(' / ')}，级别 L1~L3` };
      if (target.level === 'L3' && !o.allowL3) {
        audit?.append('mode.request_rejected', { target, origin: ctx.origin, reason: 'L3 disabled' });
        return { status: 'rejected', text: '配置禁止开启 L3（admin.allowL3=false）。' };
      }
      if (target.level === 'L3' && !getTotpSecret()) {
        audit?.append('mode.request_rejected', { target, origin: ctx.origin, reason: 'totp not configured' });
        return { status: 'rejected', text: 'L3 需要 TOTP 二次认证，但本机尚未配置 TOTP。请在电脑上运行 npm run admin:totp-setup 后再试。' };
      }
      const cur = current();
      if (cur.mode === target.mode && cur.level === target.level) return { status: 'noop', text: `已经是 ${MODE_TEXT[target.mode] ?? target.mode} / ${LEVEL_TEXT[target.level]}。` };
      const up = levelRank(target.level) > levelRank(cur.level);
      if (!up) {
        // 降级与 L0 之间的平移：一步执行。AI 工具也可以发起降级 —— 降级不会扩大任何能力。
        const r = await transition(target, ctx.origin === 'ai-tool' ? 'qq-command' : (ctx.origin === 'console' ? 'console' : 'qq-command'), { auditExtra: { origin: ctx.origin, reason: ctx.reason ?? '' } });
        return { status: r.ok ? 'applied' : 'rejected', text: r.ok ? `已切换到 ${MODE_TEXT[target.mode]} / ${LEVEL_TEXT[target.level]}。` : `切换失败：${r.error}` };
      }
      const pending = st().requests.filter((r) => r.status === 'pending');
      if (pending.length >= o.maxPending) return { status: 'rejected', text: `已有 ${pending.length} 个待确认申请，请先确认或发 /cancel 取消。` };
      st().requestSeq += 1;
      const req = {
        id: st().requestSeq,
        code: newCode(),
        target,
        from: { mode: cur.mode, level: cur.level },
        origin: String(ctx.origin ?? 'command'),
        reason: String(ctx.reason ?? '').slice(0, 200),
        createdAt: now(),
        expiresAt: now() + o.requestTtlMs,
        attempts: 0,
        status: 'pending',
        needsTotp: target.level === 'L3',
      };
      st().requests.push(req);
      save();
      audit?.append('mode.request_created', { id: req.id, target, from: req.from, origin: req.origin, reason: req.reason, needsTotp: req.needsTotp });
      const ttlMin = Math.round(o.requestTtlMs / 60000 * 10) / 10;
      const lines = [
        `⚠️ 申请 #${req.id}：切换到 ${MODE_TEXT[target.mode]}，权限 ${LEVEL_TEXT[target.level]}。`,
        target.mode === 'closed-agent' ? '切换后群聊会暂停响应，私聊由运维 Agent 接管。' : '',
        req.origin === 'ai-tool' ? '（此申请由 AI 根据对话代为登记；AI 不能替你确认。）' : '',
        req.needsTotp
          ? `确认请回复「确认 ${req.code} <验证器上的6位动态码>」，${ttlMin} 分钟内有效。`
          : `确认请回复「确认 ${req.code}」，${ttlMin} 分钟内有效。`,
        '不想切换就忽略，或回复 /cancel。',
      ].filter(Boolean);
      return { status: 'pending', text: lines.join('\n'), request: req };
    });
  }

  function totpLocked() {
    const t = st().totp;
    return t.lockedUntil && now() < t.lockedUntil;
  }

  function noteTotpFailure() {
    const t = st().totp;
    const o = opts();
    t.failures = (t.failures || []).filter((x) => now() - x < o.totpLockMs);
    t.failures.push(now());
    if (t.failures.length >= o.totpMaxFailures) {
      t.lockedUntil = now() + o.totpLockMs;
      t.failures = [];
      audit?.append('totp.locked', { until: new Date(t.lockedUntil).toISOString() });
    }
    save();
  }

  /**
   * 处理 owner 的确认消息。由桥接在消息交给模型**之前**调用。
   * @returns {Promise<{handled:boolean, text?:string}>}
   */
  function confirm(text) {
    const parsed = parseConfirm(text);
    if (!parsed) return Promise.resolve({ handled: false });
    return serialize(async () => {
      if (!initialized) return { handled: true, text: '管理通道还在做启动校验，请稍后再试。' };
      expireRequests();
      const o = opts();
      const req = st().requests.find((r) => r.status === 'pending' && r.code === parsed.code);
      if (!req) {
        audit?.append('mode.confirm_unknown', { codeLength: parsed.code.length });
        // 不提示「码错了还是过期了」的细节之外的信息；也不把这条消息交给模型。
        return { handled: true, text: '没有与这个确认码对应的待确认申请（可能已过期、已使用或已被取消）。' };
      }
      req.attempts += 1;
      if (req.attempts > o.maxAttempts) {
        req.status = 'locked';
        save();
        audit?.append('mode.request_locked', { id: req.id });
        return { handled: true, text: `申请 #${req.id} 尝试次数过多，已作废。` };
      }
      if (req.needsTotp) {
        if (totpLocked()) {
          save();
          audit?.append('totp.rejected', { id: req.id, reason: 'locked' });
          return { handled: true, text: 'TOTP 校验因连续失败暂时锁定，请稍后再试。' };
        }
        if (!parsed.totp) {
          save();
          return { handled: true, text: `申请 #${req.id} 需要附上验证器动态码：回复「确认 ${req.code} <6位动态码>」。` };
        }
        const seed = getTotpSecret();
        if (!seed) {
          save();
          return { handled: true, text: 'TOTP 未配置，无法完成 L3 确认。' };
        }
        const v = verifyTotp(seed, parsed.totp, { nowMs: now(), lastUsedCounter: st().totp.lastUsedCounter });
        if (!v.ok) {
          noteTotpFailure();
          audit?.append('totp.rejected', { id: req.id, reason: v.reason });
          return { handled: true, text: v.reason === 'replay' ? '这个动态码已经用过了，请等下一个。' : '动态码不正确。' };
        }
        st().totp.lastUsedCounter = v.counter;
        st().totp.failures = [];
        audit?.append('totp.verified', { id: req.id });
      }
      // 申请时的出发点必须仍然成立：期间如果模式已经变了，旧申请作废，避免「换了上下文还沿用确认」。
      if (req.from.mode !== st().mode || req.from.level !== st().level) {
        req.status = 'superseded';
        save();
        return { handled: true, text: `申请 #${req.id} 发起后模式已经变化，已作废，请重新申请。` };
      }
      req.status = 'confirmed';
      req.confirmedAt = now();
      save();
      audit?.append('mode.request_confirmed', { id: req.id, target: req.target, totp: req.needsTotp });
      const r = await transition(req.target, 'qq-confirm', { auditExtra: { requestId: req.id } });
      return { handled: true, text: r.ok ? `✅ 申请 #${req.id} 已确认。` : `申请 #${req.id} 已确认，但切换失败：${r.error}` };
    });
  }

  function cancelAll(reason = 'owner') {
    return serialize(async () => {
      let n = 0;
      for (const r of st().requests) if (r.status === 'pending') { r.status = 'cancelled'; n += 1; }
      save();
      if (n) audit?.append('mode.request_cancelled', { count: n, reason });
      return n;
    });
  }

  /** 紧急关闭：立即回到 safeMode / L0，不需要任何确认。 */
  function panic(source = 'panic') {
    return serialize(async () => {
      for (const r of st().requests) if (r.status === 'pending') r.status = 'cancelled';
      return transition({ mode: opts().safeMode, level: 'L0' }, source);
    });
  }

  /** 控制台直接设置。控制台持有管理令牌，L1/L2 不需要确认码；L3 仍要求 TOTP。 */
  function consoleSet(want, { totp = null } = {}) {
    return serialize(async () => {
      const o = opts();
      const target = normalizeTarget(want?.mode, want?.level, { defaultAgentLevel: o.defaultAgentLevel });
      if (!target) return { ok: false, error: '无效的目标模式/级别' };
      if (levelRank(target.level) > levelRank(st().level)) {
        if (levelRank(st().level) > 0) {
          audit?.append('mode.console_escalation_denied', { from: st().level, to: target.level, reason: 'elevated' });
          return { ok: false, error: '高权限期间控制台不能再提权（请先降级，或在 QQ 管理通道申请 + 确认）' };
        }
        const since = now() - (st().elevatedEndedAt || 0);
        if (st().elevatedEndedAt && since < o.consoleEscalationCooldownMs) {
          audit?.append('mode.console_escalation_denied', { to: target.level, reason: 'cooldown' });
          return { ok: false, error: `刚从高权限回落 ${Math.round(since / 1000)} 秒，控制台提权冷却中（${Math.round(o.consoleEscalationCooldownMs / 60000)} 分钟）；可在 QQ 管理通道申请 + 确认` };
        }
      }
      if (target.level === 'L3') {
        if (!o.allowL3) return { ok: false, error: '配置禁止开启 L3' };
        const seed = getTotpSecret();
        if (!seed) return { ok: false, error: 'L3 需要先配置 TOTP（npm run admin:totp-setup）' };
        if (totpLocked()) return { ok: false, error: 'TOTP 暂时锁定' };
        const v = verifyTotp(seed, totp, { nowMs: now(), lastUsedCounter: st().totp.lastUsedCounter });
        if (!v.ok) { noteTotpFailure(); audit?.append('totp.rejected', { via: 'console', reason: v.reason }); return { ok: false, error: `TOTP 校验失败（${v.reason}）` }; }
        st().totp.lastUsedCounter = v.counter;
        save();
      }
      const r = await transition(target, 'console');
      return { ok: r.ok, error: r.error, mode: r.after.mode, level: r.after.level };
    });
  }

  /** 记一次高权限期间的活动（owner 发消息、Agent 回合结束），用于闲置回落。 */
  function touch() {
    if (levelRank(st().level) === 0) return;
    st().lastActivityAt = now();
    // 不每次落盘：tick 时落盘即可（闲置判断容忍几十秒误差）。
  }

  /** 周期检查：申请过期、闲置回落、最长时长回落。 */
  function tick() {
    return serialize(async () => {
      expireRequests();
      const o = opts();
      const lv = st().level;
      if (levelRank(lv) === 0) return null;
      const t = now();
      if (o.idleTimeoutMs > 0 && t - (st().lastActivityAt || st().elevatedAt || t) >= o.idleTimeoutMs) {
        log(`高权限 ${lv} 闲置超时，自动回落到 ${o.safeMode}`);
        return transition({ mode: o.safeMode, level: 'L0' }, 'auto-idle');
      }
      const max = o.maxElevatedMs[lv];
      if (max > 0 && st().elevatedAt && t - st().elevatedAt >= max) {
        log(`高权限 ${lv} 超过最长时长，自动回落到 ${o.safeMode}`);
        return transition({ mode: o.safeMode, level: 'L0' }, 'auto-max');
      }
      save();
      return null;
    });
  }

  /**
   * 桥接从 DSH 设置（qq-mode 命名空间）读到的模式与控制器认可的不一致时调用。
   * 升级到 closed-agent 而控制器没有授权记录 → 默认回退并告警（externalEscalation=revert），
   * 或只告警（alert）。非提权变化 → 接受并通知。
   */
  function observeExternalMode(modeFromDsh) {
    return serialize(async () => {
      const ext = String(modeFromDsh ?? '');
      if (!ext || ext === st().mode) return { action: 'none' };
      const o = opts();
      if (ext === 'closed-agent' && levelRank(st().level) === 0) {
        audit?.append('mode.external_escalation', { from: st().mode, to: ext, policy: o.externalEscalation });
        if (o.externalEscalation === 'revert') {
          const r = await transition({ mode: st().mode || o.safeMode, level: 'L0' }, 'external-revert', { alert: true, auditExtra: { external: ext } });
          return { action: 'reverted', ok: r.ok };
        }
        // 只告警模式下也最多按 L1 接受：外部写入绕过了确认码与 TOTP，不能因此得到更高权限。
        const r = await transition({ mode: 'closed-agent', level: 'L1' }, 'external-accept', { alert: true });
        return { action: 'accepted-alert', ok: r.ok };
      }
      const target = normalizeTarget(ext, ext === 'closed-agent' ? st().level : 'L0', { defaultAgentLevel: o.defaultAgentLevel });
      if (!target) return { action: 'ignored' };
      const r = await transition(target, 'external-accept', { alert: ext !== st().mode && levelRank(st().level) > 0 ? false : false });
      return { action: 'accepted', ok: r.ok };
    });
  }

  /**
   * 启动时调用：用持久化的控制器状态 + 实际模式做一次一致性校验。
   * 高权限状态在重启后**不**继承：一律回落到 safeMode（重启 = 一次可能的异常，应当回到安全态）。
   */
  function initialize(actualMode) {
    return serialize(async () => {
      store.load();
      initialized = true;
      const o = opts();
      const actual = String(actualMode ?? '');
      if (st().mode === null) {
        // 第一次运行：认可当前的 L0 模式；如果当前是 closed-agent（老版本遗留），回落并告警。
        if (L0_MODES.includes(actual)) {
          st().mode = actual; st().level = 'L0'; st().changedAt = now(); st().changedBy = 'startup';
          save();
          audit?.append('mode.initialized', { mode: actual });
          return { action: 'initialized' };
        }
        const r = await transition({ mode: o.safeMode, level: 'L0' }, 'startup', { alert: actual === 'closed-agent', auditExtra: { actual } });
        return { action: 'fallback', ok: r.ok };
      }
      if (levelRank(st().level) > 0 || actual === 'closed-agent') {
        const r = await transition({ mode: o.safeMode, level: 'L0' }, 'startup', { auditExtra: { actual, persisted: { mode: st().mode, level: st().level } } });
        return { action: 'fallback', ok: r.ok };
      }
      if (actual && actual !== st().mode && L0_MODES.includes(actual)) {
        // 离线期间被改成另一个 L0 模式：接受（不涉及提权）。
        st().mode = actual;
        save();
      }
      return { action: 'ok' };
    });
  }

  function start(intervalMs = 30_000) {
    if (timer) return;
    timer = setInterval(() => { void tick().catch((e) => log(`管理状态检查异常：${e?.message ?? e}`)); }, intervalMs);
    timer.unref?.();
  }

  function stop() { if (timer) clearInterval(timer); timer = null; }

  function pendingRequests() {
    return st().requests.filter((r) => r.status === 'pending' && now() <= r.expiresAt).map((r) => ({ id: r.id, target: r.target, origin: r.origin, expiresAt: r.expiresAt, needsTotp: r.needsTotp }));
  }

  /** 审批编号持久化（跨重启不复用）。 */
  function persistApprovalSeq(n) {
    if (n > (st().approvalSeq || 0)) { st().approvalSeq = n; save(); }
  }

  return {
    initialize,
    requestChange,
    confirm,
    cancelAll,
    panic,
    consoleSet,
    observeExternalMode,
    touch,
    tick,
    start,
    stop,
    current,
    pendingRequests,
    persistApprovalSeq,
    get approvalSeq() { return st().approvalSeq || 0; },
    get options() { return opts(); },
  };
}
