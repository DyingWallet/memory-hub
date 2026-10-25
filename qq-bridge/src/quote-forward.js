// 引用消息与合并转发的「慢取」处理。
//
// 背景（macOS NapCat 4.18 实测）：读一条较早的合并转发消息，get_msg 和 get_forward_msg 都要七十多秒才回，
// 而 SDK 与接口平台默认只等 30 秒——于是引用一条合并转发时，桥接卡住整条消息 30 秒，最后 AI 只看到「[引用消息]」。
//
// 这里的做法：
// - 真正的请求用长超时（默认 120 秒）在后台跑，同一个 key 同时只发一个（并发去重）；
// - 调用方只「等一会儿」：收消息时最多等几秒，等不到就先用占位文字，不阻塞这条消息；
// - 后台请求完成后写进缓存，AI 之后再查（qq_get_message_detail / qq_get_forward_msg）直接命中。

/** 后台真正请求的超时：NapCat 读旧合并转发实测约 76 秒，留余量。 */
export const SLOW_FETCH_TIMEOUT_MS = 120_000;
/** 收消息时解析引用最多等多久：等不到先放占位，不让整条消息卡住。 */
export const REPLY_INGEST_WAIT_MS = 4_000;
/** AI 用工具查消息详情时最多等多久（MCP 端默认 15 秒超时，留余量）。 */
export const REPLY_TOOL_WAIT_MS = 10_000;
/** 读合并转发（主层）最多等多久；嵌套预览各自最多等多久（并行）。 */
export const FORWARD_MAIN_WAIT_MS = 120_000;
export const FORWARD_NESTED_WAIT_MS = 30_000;

/** 表示「还在后台取，先别等了」的错误。 */
export class StillLoadingError extends Error {
  constructor(message = '还在加载') {
    super(message);
    this.code = 'still-loading';
  }
}

/**
 * 最多等 waitMs：期间完成就返回结果（或抛它的错误），等不到抛 StillLoadingError。
 * 不取消底层 promise——它继续跑，由调用方的缓存接住结果。
 */
export function waitAtMost(promise, waitMs) {
  if (!(waitMs > 0)) return promise;
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new StillLoadingError()), waitMs); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * 带缓存与并发去重的慢取器。
 * @param {{ fetch: (key: string) => Promise<any>, ttlMs?: number, negativeTtlMs?: number, max?: number, now?: () => number }} opts
 *   fetch 失败（含超时）只短暂负缓存，避免一次抖动长时间读不到；成功缓存 ttlMs。
 */
export function createSlowFetchCache({ fetch, ttlMs = 30 * 60_000, negativeTtlMs = 5_000, max = 300, now = Date.now } = {}) {
  const cache = new Map(); // key -> { ok, value, error, at }
  const inflight = new Map(); // key -> Promise
  function prune() {
    const t = now();
    for (const [k, v] of cache) {
      if (t - v.at > (v.ok ? ttlMs : negativeTtlMs)) cache.delete(k);
    }
    while (cache.size > max) cache.delete(cache.keys().next().value);
  }
  function start(key) {
    if (inflight.has(key)) return inflight.get(key);
    const p = Promise.resolve()
      .then(() => fetch(key))
      .then((value) => { cache.set(key, { ok: true, value, at: now() }); return value; },
        (error) => { cache.set(key, { ok: false, error, at: now() }); throw error; })
      .finally(() => { inflight.delete(key); prune(); });
    // 后台跑的请求没人等时，失败不能变成未处理的 rejection
    p.catch(() => {});
    inflight.set(key, p);
    return p;
  }
  return {
    /** 取值：命中缓存直接返回；否则发起（或复用）后台请求，最多等 waitMs。 */
    async get(key, { waitMs = 0 } = {}) {
      const k = String(key);
      const hit = cache.get(k);
      if (hit && now() - hit.at <= (hit.ok ? ttlMs : negativeTtlMs)) {
        if (hit.ok) return hit.value;
        throw hit.error;
      }
      return waitAtMost(start(k), waitMs);
    },
    /** 只看缓存，不发请求（undefined = 没有）。 */
    peek(key) {
      const hit = cache.get(String(key));
      return hit?.ok && now() - hit.at <= ttlMs ? hit.value : undefined;
    },
    isLoading: (key) => inflight.has(String(key)),
    set(key, value) { cache.set(String(key), { ok: true, value, at: now() }); prune(); },
    delete(key) { cache.delete(String(key)); },
    size: () => cache.size,
  };
}

/** 引用还在加载时给 AI 看的占位文字（带被引用消息的 id，AI 可以稍后用工具查）。 */
export function pendingReplyText(messageId) {
  const id = String(messageId ?? '').replace(/[^\w-]/g, '').slice(0, 40);
  return `[引用消息${id ? ` id=${id}` : ''}（原消息加载较慢，稍后可用 qq_get_message_detail 查看${id ? '这个 id' : ''}）]`;
}

/** 合并若干 forward id 列表（去重、保序、丢空值）。 */
export function mergeForwardIds(...lists) {
  const out = [];
  for (const list of lists) {
    for (const v of Array.isArray(list) ? list : []) {
      const s = String(v ?? '').trim();
      if (s && !out.includes(s)) out.push(s);
    }
  }
  return out;
}
