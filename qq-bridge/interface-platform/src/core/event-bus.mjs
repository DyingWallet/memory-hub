// 事件总线：内存重放窗口 + 单调游标 + 同步投递给订阅者。
//
// 慢订阅者不阻塞热路径：投递是同步回调，写出由订阅者自己负责；订阅者发现自己积压过多
// （例如 SSE 的写缓冲超过上限）应主动断开，客户端带游标重连后从窗口里补齐，超出窗口会收到 expired。

export function createEventBus({ windowSize = 2000 } = {}) {
  let seq = 0;
  const ring = [];
  const subs = new Set();

  function publish(event) {
    seq += 1;
    const e = { ...event, id: `evt_${seq}`, seq };
    ring.push(e);
    if (ring.length > windowSize) ring.splice(0, ring.length - windowSize);
    for (const s of subs) {
      if (s.filter && !s.filter(e)) continue;
      s.deliver(e);
    }
    return e;
  }

  function seqOf(cursor) {
    const m = /^evt_(\d+)$/.exec(String(cursor ?? ''));
    return m ? Number(m[1]) : null;
  }

  /** 游标之后的事件；游标早于窗口时 expired=true。 */
  function since(cursor, filter = null) {
    const n = seqOf(cursor);
    if (n === null) return { events: [], expired: cursor != null && cursor !== '' };
    const first = ring[0]?.seq ?? seq + 1;
    const expired = n < first - 1;
    const events = ring.filter((e) => e.seq > n && (!filter || filter(e)));
    return { events, expired };
  }

  /** 订阅。onEvent 同步调用，抛错不影响其他订阅者。 */
  function subscribe(onEvent, { filter = null } = {}) {
    const s = {
      filter,
      deliver(e) {
        try { onEvent(e); } catch {}
      },
    };
    subs.add(s);
    return { unsubscribe: () => subs.delete(s) };
  }

  return {
    publish,
    since,
    subscribe,
    get lastId() { return seq ? `evt_${seq}` : null; },
    get subscriberCount() { return subs.size; },
  };
}
