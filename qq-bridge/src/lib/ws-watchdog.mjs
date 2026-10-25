// SnowLuma WebSocket 连接看门狗。
//
// 为什么需要（v0.4.1，部署实测 + 对照 @snowluma/sdk 源码 websocket-client.js 的 connect()）：
//   SDK 在连接阶段**只在 socket 触发 'close' 时**结束这次连接并安排重连。而 Node 内置 WebSocket 在
//   握手被拒（例如拿 HTTP token 去连 WS 端口，non-101）时实测只触发 'error'、不触发 'close'，于是：
//     · 桥接挂在 'close' 上的 token 自愈不会执行；
//     · SDK 自己也永远不会重连 —— 桥接一直停在「未连接」，QQ 侧收不到任何消息。
//   典型触发场景：在控制中心里**先启动桥接、后启动 SnowLuma**，或者首次启动时 WS token 不对。
//
// 做法：未连接时按退避间隔（默认 10 秒起、最长 60 秒）调用 reconnect()；连上后重置间隔。
// reconnect() 由调用方实现（桥接里是「先尝试 token 自愈，没触发重连就关闭并重新连接」）。
// 连接一直正常时看门狗什么都不做，不会打断 SDK 自己的正常重连流程（首次检查至少等 minMs）。

/**
 * @param {object} o
 * @param {() => boolean} o.isConnected
 * @param {() => Promise<void>|void} o.reconnect
 * @param {(m:string)=>void} [o.log]
 * @param {number} [o.minMs]
 * @param {number} [o.maxMs]
 * @param {(fn:()=>void, ms:number)=>any} [o.setTimer]
 * @param {(t:any)=>void} [o.clearTimer]
 */
export function createReconnectWatchdog({ isConnected, reconnect, log = () => {}, minMs = 10_000, maxMs = 60_000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let delay = minMs;
  let timer = null;
  let stopped = true;
  let running = false;
  let attempts = 0;

  function schedule() {
    if (stopped) return;
    if (timer) clearTimer(timer);
    timer = setTimer(() => { timer = null; void tick(); }, delay);
    timer?.unref?.();
  }

  async function tick() {
    if (stopped || running) return;
    if (isConnected()) {
      delay = minMs;
      attempts = 0;
      schedule();
      return;
    }
    running = true;
    attempts += 1;
    try {
      log(`SnowLuma 仍未连接，看门狗第 ${attempts} 次尝试重新连接（下次间隔 ${Math.round(Math.min(maxMs, delay * 2) / 1000)} 秒）`);
      await reconnect();
    } catch (error) {
      log(`看门狗重连出错：${error?.message ?? error}`);
    } finally {
      running = false;
    }
    delay = Math.min(maxMs, delay * 2);
    schedule();
  }

  return {
    start() { if (!stopped) return; stopped = false; delay = minMs; schedule(); },
    stop() { stopped = true; if (timer) clearTimer(timer); timer = null; },
    /** 连接成功时调用：重置退避。 */
    onConnected() { delay = minMs; attempts = 0; },
    get attempts() { return attempts; },
    get nextDelayMs() { return delay; },
    tick, // 测试用
  };
}
