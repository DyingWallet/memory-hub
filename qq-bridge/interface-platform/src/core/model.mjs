// 统一契约的公共部分：ID 规则、安全 JSON 解析、能力声明、错误码。见 docs/CONTRACT.md。

export const EVENT_VERSION = 1;

/** 平台原始 ID 一律按不透明字符串处理。null/undefined/'' → null。 */
export function rawId(v) {
  if (v === null || v === undefined || v === '') return null;
  return String(v);
}

/** 逻辑账号 ID：<platform>:<平台原始账号>。 */
export function accountId(platform, raw) {
  const r = rawId(raw);
  return r ? `${platform}:${r}` : null;
}

export function parseAccountId(id) {
  const m = /^([a-z][a-z0-9-]*):(.+)$/.exec(String(id ?? ''));
  return m ? { platform: m[1], raw: m[2] } : null;
}

/**
 * 解析上游 JSON，超出安全整数范围的整数保留为源文本字符串（避免 QQ 号/消息 ID 被截断）。
 * 依赖 JSON.parse reviver 的 context.source（Node ≥ 21）。
 */
export function safeJsonParse(text) {
  return JSON.parse(text, (_k, v, ctx) => (typeof v === 'number' && Number.isInteger(v) && !Number.isSafeInteger(v) && ctx?.source ? ctx.source : v));
}

/** 平台统一错误：code 是稳定的机器可读码，message 给人看（中文），detail 带脱敏后的后端上下文。 */
export class PlatformError extends Error {
  constructor(code, message, { status = 400, detail = null } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
  toJSON() { return { code: this.code, message: this.message, ...(this.detail ? { detail: this.detail } : {}) }; }
}

export const ERR = {
  unauthorized: (m = '需要有效的令牌') => new PlatformError('unauthorized', m, { status: 401 }),
  notFound: (m = '不存在') => new PlatformError('not_found', m, { status: 404 }),
  badRequest: (m) => new PlatformError('bad_request', m, { status: 400 }),
  unsupported: (cap) => new PlatformError('capability_unsupported', `连接器不支持该能力：${cap}`, { status: 422 }),
  unsupportedSegment: (t) => new PlatformError('unsupported_segment', `连接器不支持该消息段：${t}`, { status: 422 }),
  accountNotReady: (a, reason) => new PlatformError('account_not_ready', `账号 ${a} 当前不能发送（${reason}）`, { status: 409 }),
  instanceUnavailable: (i, reason) => new PlatformError('instance_unavailable', `实例 ${i} 不可用（${reason}）`, { status: 503 }),
  queueFull: (a) => new PlatformError('queue_full', `账号 ${a} 的发送队列已满`, { status: 429 }),
  bridgeDisabled: (a) => new PlatformError('bridge_disabled', `账号 ${a} 已停用桥接`, { status: 403 }),
};

/** 能力声明：declared（连接器宣称）与 verified（真实验收）分开。 */
export function cap(declared, extra = {}) {
  return { declared: !!declared, verified: false, ...extra };
}

/** 统一消息段的类型白名单。 */
export const SEGMENT_TYPES = new Set(['text', 'mention', 'reply', 'image', 'voice', 'video', 'file', 'ext']);

export function segmentsToText(segments) {
  return (segments ?? []).map((s) => (s.type === 'text' ? s.text : s.type === 'mention' ? `@${s.target}` : '')).join('');
}
