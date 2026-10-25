// 发送请求状态机：accepted → submitted → confirmed / failed / unknown（见 docs/CONTRACT.md §6）。
//
// · 每个账号一条 FIFO 队列，有上限；不同账号互不阻塞。
// · clientRequestId 在去重窗口内只执行一次。
// · 已提交后超时或连接中断 → unknown，绝不自动重发。

import crypto from 'node:crypto';
import { ERR, PlatformError } from './model.mjs';

export function createRequestTracker({ queueLimit = 200, dedupWindowMs = 10 * 60_000, keepMs = 30 * 60_000, now = Date.now } = {}) {
  const byId = new Map();
  const byClientId = new Map(); // `${account}|${clientRequestId}` -> id
  const queues = new Map(); // account -> { items: [], running: false }
  const waiters = new Map(); // id -> Set<resolve>

  function prune() {
    const t = now();
    for (const [id, r] of byId) {
      if (isFinal(r) && t - r.updatedAt > keepMs) {
        byId.delete(id);
        if (r.clientRequestId) byClientId.delete(`${r.account}|${r.clientRequestId}`);
      }
    }
    for (const [k, id] of byClientId) {
      const r = byId.get(id);
      if (!r || t - r.createdAt > dedupWindowMs) byClientId.delete(k);
    }
  }

  const isFinal = (r) => r.state === 'confirmed' || r.state === 'failed' || r.state === 'unknown';

  function set(r, state, patch = {}) {
    Object.assign(r, patch, { state, updatedAt: now() });
    if (isFinal(r)) {
      for (const w of waiters.get(r.id) ?? []) w(view(r));
      waiters.delete(r.id);
    }
  }

  function view(r) {
    const { execute, ...rest } = r;
    return { ...rest };
  }

  /**
   * @param {object} o
   * @param {string} o.account
   * @param {string} o.kind                    'message' | 'action'
   * @param {string} [o.clientRequestId]
   * @param {(ctx:{markSubmitted:()=>void})=>Promise<object>} o.execute
   *        成功返回结果对象；抛 PlatformError 表示明确失败；抛带 outcome:'unknown' 的错误表示结果不可知。
   */
  function submit({ account, kind = 'message', clientRequestId = null, execute, summary = null }) {
    prune();
    if (clientRequestId) {
      const prev = byClientId.get(`${account}|${clientRequestId}`);
      if (prev && byId.has(prev)) return { request: view(byId.get(prev)), duplicate: true };
    }
    let q = queues.get(account);
    if (!q) { q = { items: [], running: false }; queues.set(account, q); }
    if (q.items.length >= queueLimit) throw ERR.queueFull(account);
    const r = {
      id: `req_${crypto.randomBytes(9).toString('base64url')}`,
      account,
      kind,
      clientRequestId,
      summary,
      state: 'accepted',
      createdAt: now(),
      updatedAt: now(),
      result: null,
      error: null,
      execute,
    };
    byId.set(r.id, r);
    if (clientRequestId) byClientId.set(`${account}|${clientRequestId}`, r.id);
    q.items.push(r);
    void drain(account);
    return { request: view(r), duplicate: false };
  }

  async function drain(account) {
    const q = queues.get(account);
    if (!q || q.running) return;
    q.running = true;
    try {
      while (q.items.length) {
        const r = q.items.shift();
        let submitted = false;
        try {
          const result = await r.execute({ markSubmitted: () => { submitted = true; set(r, 'submitted'); } });
          set(r, 'confirmed', { result });
        } catch (error) {
          const e = error instanceof PlatformError ? error.toJSON() : { code: error?.code ?? 'backend_error', message: String(error?.message ?? error), ...(error?.detail ? { detail: error.detail } : {}) };
          if (error?.outcome === 'unknown' || (submitted && !(error instanceof PlatformError) && !error?.backendRejected)) set(r, 'unknown', { error: e });
          else set(r, 'failed', { error: e });
        }
      }
    } finally {
      q.running = false;
    }
  }

  return {
    submit,
    get: (id) => (byId.has(id) ? view(byId.get(id)) : null),
    /** 等待请求结束，最多 ms 毫秒；超时返回当前状态。 */
    wait(id, ms) {
      const r = byId.get(id);
      if (!r) return Promise.resolve(null);
      if (isFinal(r)) return Promise.resolve(view(r));
      return new Promise((resolve) => {
        const t = setTimeout(() => { waiters.get(id)?.delete(done); resolve(view(r)); }, ms);
        const done = (v) => { clearTimeout(t); resolve(v); };
        if (!waiters.has(id)) waiters.set(id, new Set());
        waiters.get(id).add(done);
      });
    },
    /** 放弃某账号排队中（尚未提交）的请求：实例断开时调用。 */
    failQueued(account, error) {
      const q = queues.get(account);
      if (!q) return 0;
      const items = q.items.splice(0);
      for (const r of items) set(r, 'failed', { error: error.toJSON() });
      return items.length;
    },
    queueLength: (account) => queues.get(account)?.items.length ?? 0,
  };
}
