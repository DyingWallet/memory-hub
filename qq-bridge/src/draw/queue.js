// 全局串行队列：所有 QQ 侧的出图请求都排这一条队。
//
// 为什么全局：ComfyUI 单实例，并发提交会互相抢显存；训练还可能在跑，
// 多开必然崩。所以不分群、不分私聊，一次只跑一个。

export function createSerialQueue({ maxDepth = 5, timeoutMs = 240_000 } = {}) {
  let running = false;
  let current = null;
  const waiting = [];

  function drain() {
    if (running || !waiting.length) return;
    const job = waiting.shift();
    running = true;
    current = job;

    let timer = setTimeout(() => {
      job.done?.({ ok: false, code: 'timeout' });
      finish();
    }, timeoutMs);

    Promise.resolve()
      .then(() => job.run())
      .then((r) => {
        clearTimeout(timer);
        job.done?.(r ?? { ok: true });
      })
      .catch((e) => {
        clearTimeout(timer);
        job.done?.({ ok: false, code: 'failed', error: e?.message ?? String(e) });
      })
      .finally(() => finish());
  }

  function finish() {
    running = false;
    current = null;
    queueMicrotask(drain);
  }

  /**
   * 入队。满了直接拒绝，不排队等。
   * @returns {{accepted:boolean, code?:string, position?:number, promise?:Promise}}
   */
  function push(run, meta = {}) {
    if (waiting.length >= maxDepth) {
      return { accepted: false, code: 'queue_full' };
    }
    let resolveOuter;
    const promise = new Promise((res) => {
      resolveOuter = res;
    });
    const job = { run, meta, done: (r) => resolveOuter(r) };
    waiting.push(job);
    const position = waiting.length + (running ? 1 : 0);
    drain();
    return { accepted: true, position, promise };
  }

  function stats() {
    return { running: Boolean(running), waiting: waiting.length, current: current?.meta ?? null };
  }

  /** 主人清空排队（正在跑的那张不打断）。 */
  function clear() {
    const n = waiting.length;
    for (const job of waiting.splice(0)) job.done?.({ ok: false, code: 'cancelled' });
    return n;
  }

  return { push, stats, clear };
}
