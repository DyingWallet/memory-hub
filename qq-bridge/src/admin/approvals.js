// 工具审批登记表：给每个 DSH 审批请求分配**全局唯一编号**，绑定到具体的待执行操作。
//
// 解决原版的三个问题：
//   1. 原版每个会话只有一个挂起槽，新审批会**覆盖并自动拒绝**旧审批；并发时 owner 回复的
//      「通过」不知道对应哪一个。这里改为多槽 + 编号：「通过 #3」/「拒绝 #3」。
//      只有一个挂起时仍兼容裸回复「通过」/「拒绝」；多个挂起时裸回复会被要求带编号。
//   2. 原版审批消息只显示工具名（DSH 的 approval/request 故意不带参数）。这里按 callId 关联
//      之前收到的 tool/call 事件参数，展示实际命令与关键参数（经脱敏、截断）。
//      找不到参数时明确告诉 owner「参数未知」，而不是假装完整。
//   3. 旧回复不能用于新操作：编号单调递增从不复用，已决/超时/会话失效的编号回复一律拒绝。
//
// 安全边界：审批只能由桥接从**真实 QQ 消息**（OneBot 事件，发送者 = ownerQQ，且在发起审批的
// 同一会话里）消费。模型没有任何能调用 decide() 的工具或接口 —— AI 说「已经批准了」没有任何效果。

const APPROVE_RE = /^(通过|批准|同意|允许|approve|yes|y|ok)$/i;
const REJECT_RE = /^(拒绝|否决|不同意|不允许|deny|reject|no|n)$/i;

/**
 * 解析 owner 的审批回复。
 * @returns {{decision:'allowed-once'|'rejected', id:number|null}|null}  不像审批回复返回 null
 */
export function parseApprovalReply(text) {
  const t = String(text ?? '').trim().replace(/\s+/g, ' ');
  const m = /^(\S+?)\s*(?:#|＃)\s*(\d{1,6})$/.exec(t);
  const word = m ? m[1] : t;
  const id = m ? Number(m[2]) : null;
  if (APPROVE_RE.test(word)) return { decision: 'allowed-once', id };
  if (REJECT_RE.test(word)) return { decision: 'rejected', id };
  return null;
}

function truncate(s, n) {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n)}…（共 ${str.length} 字）` : str;
}

/** 把工具参数渲染成给人看的几行。优先显示命令/路径/URL 这类关键字段。 */
export function describeToolArgs(args, { redact = (s) => s, maxChars = 600 } = {}) {
  if (args === undefined || args === null) return null;
  let obj = args;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); } catch { return redact(truncate(obj, maxChars)); }
  }
  if (typeof obj !== 'object') return redact(truncate(String(obj), maxChars));
  const keyOrder = ['command', 'cmd', 'script', 'code', 'path', 'file_path', 'filePath', 'paths', 'url', 'cwd', 'content', 'pattern'];
  const keys = Object.keys(obj);
  keys.sort((a, b) => {
    const ia = keyOrder.indexOf(a); const ib = keyOrder.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const lines = [];
  let used = 0;
  for (const k of keys) {
    let v = obj[k];
    if (typeof v !== 'string') v = JSON.stringify(v);
    const line = `${k}: ${redact(truncate(v, Math.max(80, maxChars - used)))}`;
    used += line.length;
    lines.push(line);
    if (used >= maxChars) { lines.push('…（其余参数省略）'); break; }
  }
  return lines.join('\n');
}

/**
 * @param {object} opts
 * @param {number} opts.timeoutMs
 * @param {(entry:object)=>Promise<void>} opts.onTimeout   超时：调用方负责给 DSH 回 rejected 并通知 owner
 * @param {() => number} [opts.now]
 * @param {number} [opts.startId]  从持久化的序号继续（编号跨重启也不复用）
 */
export function createApprovalRegistry({ timeoutMs, onTimeout, now = Date.now, startId = 0, maxPerKey = 10 } = {}) {
  let seq = Number.isSafeInteger(startId) && startId > 0 ? startId : 0;
  const entries = new Map(); // id -> entry
  const toolCalls = new Map(); // sessionId -> Map<callId, {name, args, at}>

  /** 记录一次 tool/call 事件的参数，供之后同 callId 的审批展示。 */
  function noteToolCall(sessionId, callId, name, args) {
    if (!sessionId || callId == null) return;
    let m = toolCalls.get(sessionId);
    if (!m) { m = new Map(); toolCalls.set(sessionId, m); }
    m.set(String(callId), { name: String(name ?? ''), args, at: now() });
    if (m.size > 200) m.delete(m.keys().next().value);
  }

  function lookupToolCall(sessionId, callId) {
    if (!sessionId || callId == null) return null;
    return toolCalls.get(sessionId)?.get(String(callId)) ?? null;
  }

  function forgetSession(sessionId) {
    toolCalls.delete(sessionId);
    const dropped = [];
    for (const e of entries.values()) if (e.sessionId === sessionId) { clearTimeout(e.timer); entries.delete(e.id); dropped.push(e); }
    return dropped;
  }

  /** 登记一个新审批，返回带编号的条目。同一 eventId 重复登记返回原条目（事件流重连重放）。 */
  function register({ key, sessionId, clientId, eventId, toolName, callId, reason }) {
    for (const e of entries.values()) if (e.eventId === eventId && e.clientId === clientId) return { entry: e, duplicate: true };
    const sameKey = [...entries.values()].filter((e) => e.key === key);
    let evicted = null;
    if (sameKey.length >= maxPerKey) {
      evicted = sameKey.sort((a, b) => a.id - b.id)[0];
      clearTimeout(evicted.timer);
      entries.delete(evicted.id);
    }
    seq += 1;
    const call = lookupToolCall(sessionId, callId);
    const entry = {
      id: seq,
      key,
      sessionId,
      clientId,
      eventId,
      toolName: String(toolName ?? call?.name ?? ''),
      callId: callId != null ? String(callId) : null,
      args: call ? call.args : undefined,
      argsKnown: !!call,
      reason: String(reason ?? ''),
      createdAt: now(),
      expiresAt: now() + timeoutMs,
      timer: null,
    };
    entry.timer = setTimeout(() => {
      if (entries.get(entry.id) !== entry) return;
      entries.delete(entry.id);
      void Promise.resolve(onTimeout?.(entry)).catch(() => {});
    }, timeoutMs);
    entry.timer.unref?.();
    entries.set(entry.id, entry);
    return { entry, duplicate: false, evicted };
  }

  function pendingFor(key) {
    return [...entries.values()].filter((e) => e.key === key).sort((a, b) => a.id - b.id);
  }

  /**
   * 解析 owner 回复对应哪一个审批。
   * @returns {{ok:true, entry, decision}|{ok:false, error:string}|null}  null = 不是审批回复
   */
  function resolveReply(key, text) {
    const parsed = parseApprovalReply(text);
    if (!parsed) return null;
    const list = pendingFor(key);
    if (parsed.id !== null) {
      const e = entries.get(parsed.id);
      if (!e) return { ok: false, error: `审批 #${parsed.id} 不存在或已失效（已处理/超时/会话已重建），不会对任何操作生效` };
      if (e.key !== key) return { ok: false, error: `审批 #${parsed.id} 不属于这个会话` };
      if (now() > e.expiresAt) return { ok: false, error: `审批 #${parsed.id} 已超时` };
      return { ok: true, entry: e, decision: parsed.decision };
    }
    if (list.length === 0) return null; // 没有挂起：这条「通过」只是普通聊天
    if (list.length > 1) return { ok: false, error: `当前有 ${list.length} 个待审批（${list.map((e) => `#${e.id}`).join('、')}），请回复「通过 #编号」或「拒绝 #编号」` };
    return { ok: true, entry: list[0], decision: parsed.decision };
  }

  /** 决定成功（DSH 已收到回执）后调用，移除条目。 */
  function complete(id) {
    const e = entries.get(id);
    if (!e) return null;
    clearTimeout(e.timer);
    entries.delete(id);
    return e;
  }

  function removeKey(key) {
    const removed = pendingFor(key);
    for (const e of removed) { clearTimeout(e.timer); entries.delete(e.id); }
    return removed;
  }

  function clearAll() {
    const all = [...entries.values()];
    for (const e of all) clearTimeout(e.timer);
    entries.clear();
    return all;
  }

  return {
    noteToolCall,
    lookupToolCall,
    forgetSession,
    register,
    pendingFor,
    resolveReply,
    complete,
    removeKey,
    clearAll,
    list: () => [...entries.values()].sort((a, b) => a.id - b.id),
    get lastId() { return seq; },
  };
}
