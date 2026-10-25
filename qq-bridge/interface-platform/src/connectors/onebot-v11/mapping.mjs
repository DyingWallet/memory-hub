// QQ（OneBot v11）⇄ 统一契约 的字段映射。纯函数，便于离线测试。

import { EVENT_VERSION, rawId, accountId, segmentsToText, ERR } from '../../core/model.mjs';

/** OneBot 消息段 → 统一消息段。未知段原样放进 ext，不丢。 */
export function fromOneBotSegments(message, rawMessage) {
  if (typeof message === 'string') return [{ type: 'text', text: message }];
  if (!Array.isArray(message)) return rawMessage ? [{ type: 'text', text: String(rawMessage) }] : [];
  return message.map((seg) => {
    const t = seg?.type;
    const d = seg?.data ?? {};
    switch (t) {
      case 'text': return { type: 'text', text: String(d.text ?? '') };
      case 'at': return { type: 'mention', target: String(d.qq ?? '') };
      case 'reply': return { type: 'reply', messageId: rawId(d.id) };
      case 'image': return { type: 'image', ...(d.file ? { file: String(d.file) } : {}), ...(d.url ? { url: String(d.url) } : {}), ...(d.summary ? { name: String(d.summary) } : {}) };
      case 'record': return { type: 'voice', ...(d.file ? { file: String(d.file) } : {}), ...(d.url ? { url: String(d.url) } : {}) };
      case 'video': return { type: 'video', ...(d.file ? { file: String(d.file) } : {}), ...(d.url ? { url: String(d.url) } : {}) };
      case 'file': return { type: 'file', ...(d.file ? { file: String(d.file) } : {}), ...(d.name ? { name: String(d.name) } : {}) };
      default: return { type: 'ext', platform: 'qq', kind: String(t ?? 'unknown'), data: d };
    }
  });
}

/** 只接受受控的媒体来源：base64:// 或 http(s)://。本地路径要等 M4 的受控文件引用。 */
function mediaSource(seg) {
  const src = String(seg.file ?? seg.url ?? '');
  if (/^base64:\/\//.test(src) || /^https?:\/\//i.test(src)) return src;
  throw ERR.badRequest(`${seg.type} 段的来源只能是 base64:// 或 http(s)://（本地路径需等待受控文件引用，M4）`);
}

/** 统一消息段 → OneBot 消息段。不支持的段整条拒绝。 */
export function toOneBotSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) throw ERR.badRequest('segments 不能为空');
  return segments.map((s) => {
    switch (s?.type) {
      case 'text': return { type: 'text', data: { text: String(s.text ?? '') } };
      case 'mention': return { type: 'at', data: { qq: String(s.target ?? '') } };
      case 'reply': return { type: 'reply', data: { id: String(s.messageId ?? '') } };
      case 'image': return { type: 'image', data: { file: mediaSource(s) } };
      case 'voice': return { type: 'record', data: { file: mediaSource(s) } };
      case 'video': return { type: 'video', data: { file: mediaSource(s) } };
      case 'ext':
        if (s.platform !== 'qq' || !s.kind) throw ERR.unsupportedSegment(`ext(${s.platform}/${s.kind})`);
        return { type: String(s.kind), data: s.data ?? {} };
      default: throw ERR.unsupportedSegment(String(s?.type));
    }
  });
}

/** OneBot 动作参数里的数字 ID：安全整数用 number（SnowLuma 期望数字），否则保留字符串。 */
export function oneBotId(id) {
  const s = String(id ?? '');
  if (!/^\d+$/.test(s)) throw ERR.badRequest(`QQ ID 必须是数字：「${s}」`);
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : s;
}

export function sendActionFor(conversation, segments) {
  const message = toOneBotSegments(segments);
  if (conversation?.type === 'group') return { action: 'send_group_msg', params: { group_id: oneBotId(conversation.id), message } };
  if (conversation?.type === 'private') return { action: 'send_private_msg', params: { user_id: oneBotId(conversation.id), message } };
  throw ERR.unsupported(`message.send.${conversation?.type ?? '?'}`);
}

/** OneBot 事件 → 统一事件（不含 id/seq，由总线分配）。 */
export function toUnifiedEvent(ev, { instance, now = Date.now() } = {}) {
  const account = accountId('qq', ev?.self_id);
  const base = {
    v: EVENT_VERSION,
    time: now,
    occurredAt: typeof ev?.time === 'number' ? ev.time * 1000 : null,
    platform: 'qq',
    instance,
    account,
  };
  const post = ev?.post_type;
  if (post === 'message' || post === 'message_sent') {
    const isGroup = ev.message_type === 'group';
    const isTemp = !isGroup && ev.sub_type === 'group';
    const segments = fromOneBotSegments(ev.message, ev.raw_message);
    return {
      ...base,
      kind: 'message',
      type: `message.${isGroup ? 'group' : isTemp ? 'temp' : 'private'}`,
      conversation: isGroup ? { type: 'group', id: rawId(ev.group_id) } : { type: isTemp ? 'temp' : 'private', id: rawId(ev.user_id) },
      sender: { id: rawId(ev.sender?.user_id ?? ev.user_id), name: String(ev.sender?.card || ev.sender?.nickname || '') || null },
      message: { id: rawId(ev.message_id), segments, text: segmentsToText(segments) },
      ext: { qq: { post_type: post, message_type: ev.message_type, sub_type: ev.sub_type ?? null, ...(isTemp && ev.group_id ? { group_id: rawId(ev.group_id) } : {}) } },
    };
  }
  if (post === 'notice') {
    const nt = String(ev.notice_type ?? 'unknown');
    if (nt === 'bot_status') {
      return { ...base, kind: 'meta', type: 'account.status', conversation: null, sender: null, message: null, ext: { qq: { online: ev.sub_type === 'online', sub_type: ev.sub_type ?? null } } };
    }
    return {
      ...base,
      kind: 'notice',
      type: `notice.${nt}`,
      conversation: ev.group_id != null ? { type: 'group', id: rawId(ev.group_id) } : ev.user_id != null ? { type: 'private', id: rawId(ev.user_id) } : null,
      sender: ev.user_id != null ? { id: rawId(ev.user_id), name: null } : null,
      message: null,
      ext: { qq: ev },
    };
  }
  if (post === 'request') {
    return {
      ...base,
      kind: 'request',
      type: `request.${String(ev.request_type ?? 'unknown')}`,
      conversation: ev.group_id != null ? { type: 'group', id: rawId(ev.group_id) } : null,
      sender: ev.user_id != null ? { id: rawId(ev.user_id), name: null } : null,
      message: null,
      ext: { qq: ev },
    };
  }
  if (post === 'meta_event') {
    return { ...base, kind: 'meta', type: `meta.${String(ev.meta_event_type ?? 'unknown')}`, conversation: null, sender: null, message: null, ext: { qq: { meta_event_type: ev.meta_event_type, sub_type: ev.sub_type ?? null, status: ev.status ?? null } } };
  }
  return { ...base, kind: 'notice', type: 'unknown', conversation: null, sender: null, message: null, ext: { qq: { raw: ev } } };
}
