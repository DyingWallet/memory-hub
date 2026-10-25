// v0.4.1 回归：SnowLuma WebSocket 握手被拒「只发 error、不发 close」时，SDK 不会自己重连；
// 连接看门狗（src/lib/ws-watchdog.mjs）必须能把连接救回来。用真实 @snowluma/sdk + 假 WebSocket，不连任何服务。
import test from 'node:test';
import assert from 'node:assert/strict';
import { SnowLumaWebSocketClient } from '@snowluma/sdk';
import { createReconnectWatchdog } from '../src/lib/ws-watchdog.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 假 WebSocket：前 failCount 次连接只触发 error（模拟握手被拒且不发 close），之后正常 open。 */
function fakeSocketFactory({ failCount, emitCloseOnFail = false }) {
  const state = { created: 0, urls: [] };
  class FakeWS {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.listeners = {};
      state.created += 1;
      state.urls.push(url);
      const n = state.created;
      setTimeout(() => {
        if (n <= failCount) {
          this.emit('error', { message: 'Received network error or non-101 status code.' });
          if (emitCloseOnFail) { this.readyState = 3; this.emit('close', { code: 1006, reason: '' }); }
        } else {
          this.readyState = 1;
          this.emit('open', {});
        }
      }, 5);
    }
    addEventListener(ev, fn) { (this.listeners[ev] ??= []).push(fn); }
    removeEventListener(ev, fn) { this.listeners[ev] = (this.listeners[ev] ?? []).filter((f) => f !== fn); }
    emit(ev, payload) { for (const fn of [...(this.listeners[ev] ?? [])]) fn(payload); }
    send() {}
    close() { if (this.readyState !== 3) { this.readyState = 3; this.emit('close', { code: 1000, reason: 'client' }); } }
  }
  return { FakeWS, state };
}

test('复现：握手只发 error 不发 close 时，SDK 自己不会重连', async () => {
  const { FakeWS, state } = fakeSocketFactory({ failCount: 1 });
  const bot = new SnowLumaWebSocketClient({ url: 'ws://127.0.0.1:3001', webSocket: FakeWS, reconnect: { minDelayMs: 10, maxDelayMs: 20 } });
  bot.on('error', () => {});
  bot.connect().catch(() => {});
  await sleep(200);
  assert.equal(state.created, 1, 'SDK 只尝试了一次');
  assert.equal(bot.isConnected, false);
  bot.close();
});

test('看门狗：未连接时重连，连上后不再动作', async () => {
  const { FakeWS, state } = fakeSocketFactory({ failCount: 2 });
  const bot = new SnowLumaWebSocketClient({ url: 'ws://127.0.0.1:3001', webSocket: FakeWS, reconnect: { minDelayMs: 10, maxDelayMs: 20 } });
  bot.on('error', () => {});
  const logs = [];
  const dog = createReconnectWatchdog({
    isConnected: () => bot.isConnected,
    log: (m) => logs.push(m),
    minMs: 20,
    maxMs: 60,
    reconnect: () => { try { bot.close(1000, 'watchdog'); } catch {} bot.connect().catch(() => {}); },
  });
  bot.on('open', () => dog.onConnected());
  bot.connect().catch(() => {});
  dog.start();
  await sleep(400);
  assert.equal(bot.isConnected, true, `看门狗应把连接救回来（共创建 ${state.created} 个 socket）`);
  assert.ok(state.created >= 3);
  const createdWhenConnected = state.created;
  await sleep(200);
  assert.equal(state.created, createdWhenConnected, '已连接时看门狗不再重连');
  assert.ok(logs.some((l) => l.includes('看门狗')));
  dog.stop();
  bot.close();
});

test('看门狗：重连间隔指数退避且有上限；连上后重置', async () => {
  let connected = false;
  let calls = 0;
  const timers = [];
  const dog = createReconnectWatchdog({
    isConnected: () => connected,
    reconnect: () => { calls += 1; },
    minMs: 10_000,
    maxMs: 60_000,
    setTimer: (fn, ms) => { timers.push(ms); return { fn }; },
    clearTimer: () => {},
  });
  dog.start();
  for (let i = 0; i < 5; i++) await dog.tick();
  assert.equal(calls, 5);
  assert.deepEqual(timers.slice(0, 6), [10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  connected = true;
  dog.onConnected();
  assert.equal(dog.nextDelayMs, 10_000);
  await dog.tick();
  assert.equal(calls, 5, '已连接时不调用 reconnect');
  dog.stop();
});

test('正常的 close 路径不受影响：SDK 仍然自己重连', async () => {
  const { FakeWS, state } = fakeSocketFactory({ failCount: 1, emitCloseOnFail: true });
  const bot = new SnowLumaWebSocketClient({ url: 'ws://127.0.0.1:3001', webSocket: FakeWS, reconnect: { minDelayMs: 10, maxDelayMs: 20 } });
  bot.on('error', () => {});
  bot.on('close', () => {});
  bot.connect().catch(() => {});
  await sleep(200);
  assert.equal(bot.isConnected, true);
  assert.equal(state.created, 2);
  bot.close();
});
