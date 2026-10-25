// 引用合并转发：短等待不阻塞、后台补齐、引用里的转发 id 登记为本会话可见、读合并转发带缓存与长超时。
// 全部离线、假数据（群号 456、QQ 号 123 / 777 都是夹具里的假号）。
//   ① 模块：waitAtMost / 慢取缓存（并发去重、TTL、负缓存、还在加载、后台完成后命中）/ 占位文字 / 合并 id；
//   ② 引用解析：等不到返回 pending 且不负缓存；后台完成后再查命中，并把被引用消息里的转发 id 登记到本会话；
//      其它群的消息不登记、不返回；
//   ③ 收消息：引用一条合并转发 → 这条消息带上被引用的转发 id；原消息慢时先放占位、不卡住整条消息；
//   ④ AI 工具：消息详情对加载中的 id 明确说「稍后再查」；之后能用 qq_get_forward_msg 打开引用里的转发，第二次读走缓存；
//   ⑤ 接口平台：get_msg / get_forward_msg 用长超时，发送类动作仍按默认超时；
//   ⑥ 源码约束：发送引用时「加载中」不算确认归属。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  waitAtMost, createSlowFetchCache, pendingReplyText, mergeForwardIds, StillLoadingError,
  REPLY_INGEST_WAIT_MS, SLOW_FETCH_TIMEOUT_MS,
} from '../src/quote-forward.js';
import { createOneBotWsConnector, SLOW_READ_ACTIONS } from '../interface-platform/src/connectors/onebot-v11/connector.mjs';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GROUP = '456';
const forwardMsg = (id, groupId = GROUP) => ({
  message_id: id, group_id: Number(groupId), user_id: 777,
  sender: { user_id: 777, nickname: '转发的人', card: '转发的人' },
  message: [{ type: 'forward', data: { id: `fw-${id}` } }],
});

test('① 模块：等待上限、慢取缓存、占位文字、合并 id', async () => {
  assert.equal(await waitAtMost(Promise.resolve(1), 50), 1);
  await assert.rejects(waitAtMost(new Promise(() => {}), 20), (e) => e instanceof StillLoadingError && e.code === 'still-loading');
  await assert.rejects(waitAtMost(Promise.reject(new Error('boom')), 50), /boom/);

  let now = 0;
  let calls = 0;
  const gates = [];
  const cache = createSlowFetchCache({
    now: () => now, ttlMs: 1000, negativeTtlMs: 100,
    fetch: (k) => { calls += 1; return new Promise((resolve, reject) => gates.push({ k, resolve, reject })); },
  });
  const p1 = cache.get('a', { waitMs: 10 });
  const p2 = cache.get('a', { waitMs: 10 });
  await assert.rejects(p1, /还在加载/);
  await assert.rejects(p2, /还在加载/);
  assert.equal(calls, 1, '并发去重：同一个 key 只发一个请求');
  assert.equal(gates.length, 1);
  assert.equal(cache.isLoading('a'), true);
  gates[0].resolve({ v: 1 });
  await sleep(0);
  assert.deepEqual(await cache.get('a', { waitMs: 10 }), { v: 1 }, '后台完成后命中缓存');
  assert.equal(calls, 1);
  assert.deepEqual(cache.peek('a'), { v: 1 });
  now = 2000;
  const p3 = cache.get('a', { waitMs: 1000 });
  await sleep(0);
  assert.equal(calls, 2, 'TTL 过后重新取');
  gates[1].reject(new Error('上游超时'));
  await assert.rejects(p3, /上游超时/);
  await sleep(0);
  await assert.rejects(cache.get('a'), /上游超时/, '失败短暂负缓存');
  now = 2200;
  cache.get('a').catch(() => {});
  await sleep(0);
  assert.equal(calls, 3, '负缓存过期后重试');
  gates[2].resolve(null);

  assert.match(pendingReplyText('12345'), /\[引用消息 id=12345（原消息加载较慢，稍后可用 qq_get_message_detail 查看这个 id）\]/);
  assert.ok(!pendingReplyText('1<script>').includes('<'), 'id 只保留安全字符');
  assert.deepEqual(mergeForwardIds(['a', 'b'], ['b', '', null, 'c'], undefined), ['a', 'b', 'c']);
  assert.ok(REPLY_INGEST_WAIT_MS <= 5000, '收消息时最多等几秒');
  assert.ok(SLOW_FETCH_TIMEOUT_MS >= 100_000, '后台请求的超时要盖住 NapCat 实测的七十多秒');
});

test('② 引用解析：等不到返回 pending；后台完成后命中并登记转发 id；其它群的不登记', async () => {
  const h = await bridgeHarness();
  try {
    const release = new Map();
    let getCalls = 0;
    h.bot.getMessage = (id, opts) => {
      getCalls += 1;
      assert.ok(opts?.timeoutMs >= 100_000, '后台用长超时去取');
      return new Promise((resolve) => release.set(String(id), resolve));
    };
    const waitRelease = async (id) => { for (let i = 0; i < 100 && !release.has(id); i += 1) await sleep(1); return release.get(id); };
    const first = await h.resolveReplyInfo('group', GROUP, '1001', null, { waitMs: 20 });
    assert.deepEqual(JSON.parse(JSON.stringify(first)), { pending: true, messageId: '1001' });
    const again = await h.resolveReplyInfo('group', GROUP, '1001', null, { waitMs: 20 });
    assert.equal(again.pending, true, '还没回来时仍是 pending（没有被负缓存成 null）');
    assert.equal(getCalls, 1, '同一条只发一次请求');
    (await waitRelease('1001'))(forwardMsg(1001));
    await sleep(0);
    const done = await h.resolveReplyInfo('group', GROUP, '1001', null, { waitMs: 20 });
    assert.equal(done.pending, undefined);
    assert.equal(done.sender, '转发的人');
    assert.match(done.text, /\[转发消息 id=fw-1001\]/);
    assert.deepEqual([...done.forwardIds], ['fw-1001']);
    assert.ok(h.seenForwardIds.get(`group:${GROUP}`)?.has('fw-1001'), '被引用的转发登记为本会话可见');

    // 其它群的消息：归属校验不过，既不返回内容，也不登记
    const p = h.resolveReplyInfo('group', GROUP, '1002', null, { waitMs: 200 });
    (await waitRelease('1002'))(forwardMsg(1002, '789'));
    assert.equal(await p, null);
    assert.ok(!h.seenForwardIds.get(`group:${GROUP}`)?.has('fw-1002'), '跨群的转发 id 不登记');
  } finally { await h.close(); }
});

function request(port, pathName, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathName, method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch {} resolve({ status: res.statusCode, json }); });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('request hung')));
    req.end();
  });
}
const listenPort = (server) => new Promise((resolve) => { if (server.listening) resolve(server.address().port); else server.once('listening', () => resolve(server.address().port)); });
const groupEvent = (messageId, replyTo, text) => ({
  self_id: 999, user_id: 123, group_id: Number(GROUP), message_id: messageId,
  message: [{ type: 'reply', data: { id: String(replyTo) } }, { type: 'text', data: { text } }],
  raw_message: text, sender: { nickname: '测试群友', card: '测试群友' },
});

test('③④ 收消息不被慢引用卡住；之后 AI 能查详情并打开引用里的转发，第二次读走缓存', async () => {
  const h = await bridgeHarness({ config: { socialV2: { wake: { batchWindowMs: 60000 } } } });
  const server = h.startConsoleServer();
  try {
    h.setMode('reserved2');
    // 快的引用：这条消息直接带上被引用转发的 id
    h.bot.getMessage = async (id) => forwardMsg(Number(id));
    await h.handleIncoming('group', GROUP, groupEvent(5001, 3001, '这个转发太好笑了'), h.cfg);
    const st = h.getSocialV2State(`group:${GROUP}`);
    const fast = st.unread.find((m) => String(m.messageId) === '5001');
    assert.ok(fast, '消息进了未读');
    assert.deepEqual([...fast.forwardIds], ['fw-3001'], '引用里的转发 id 记到这条消息上');
    assert.match(fast.text, /\[引用 转发的人：\[转发消息 id=fw-3001\]\]/);

    // 慢的引用：最多等几秒就放占位，不卡住整条消息
    let releaseSlow;
    h.bot.getMessage = (id) => new Promise((resolve) => { releaseSlow = () => resolve(forwardMsg(Number(id))); });
    const t0 = Date.now();
    await h.handleIncoming('group', GROUP, groupEvent(5002, 3002, '最难绷'), h.cfg);
    const spent = Date.now() - t0;
    assert.ok(spent < REPLY_INGEST_WAIT_MS + 2000, `收消息最多等 ${REPLY_INGEST_WAIT_MS}ms，实际 ${spent}ms`);
    const slow = st.unread.find((m) => String(m.messageId) === '5002');
    assert.ok(slow, '慢引用的消息照样进了未读');
    assert.match(slow.text, /\[引用消息 id=3002（原消息加载较慢/);

    const port = await listenPort(server);
    const hdr = { 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken, 'x-agent-call': '1' };
    const detail = (mid) => request(port, `/api/socialV2/message-detail?key=${encodeURIComponent(`group:${GROUP}`)}&messageId=${mid}`, hdr);
    const loading = await detail(3002);
    assert.equal(loading.status, 200);
    assert.equal(loading.json.info.pending, true);
    assert.match(loading.json.info.note, /稍后再查/);
    // 打开引用里的转发之前：id 还没登记，拒绝
    const fwd = (fid) => request(port, `/api/socialV2/forward-message?key=${encodeURIComponent(`group:${GROUP}`)}&id=${fid}`, hdr);
    assert.equal((await fwd('fw-3002')).status, 404, '没见过的转发 id 不能读');

    releaseSlow();
    await sleep(0);
    const ready = await detail(3002);
    assert.equal(ready.json.info.sender, '转发的人');
    assert.deepEqual([...ready.json.info.forwardIds], ['fw-3002']);

    let rawCalls = 0;
    h.bot.raw = async (action, params, opts) => {
      assert.equal(action, 'get_forward_msg');
      assert.ok(opts?.timeoutMs >= 100_000, '读合并转发用长超时');
      rawCalls += 1;
      if (params.id === 'fw-3002') {
        return { messages: [
          { sender: { nickname: '甲' }, message: [{ type: 'text', data: { text: '第一条' } }] },
          { sender: { nickname: '乙' }, message: [{ type: 'forward', data: { id: 'fw-nested' } }] },
        ] };
      }
      return { messages: [{ sender: { nickname: '丙' }, message: [{ type: 'text', data: { text: '嵌套里的话' } }] }] };
    };
    const opened = await fwd('fw-3002');
    assert.equal(opened.status, 200, '引用里的转发能打开');
    assert.equal(opened.json.messages[0].text, '第一条');
    assert.equal(opened.json.nestedPreviews[0].id, 'fw-nested');
    assert.equal(opened.json.nestedPreviews[0].messages[0].text, '嵌套里的话', '嵌套转发带预览');
    assert.equal(rawCalls, 2);
    const nested = await fwd('fw-nested');
    assert.equal(nested.status, 200, '嵌套 id 登记过，能继续打开');
    await fwd('fw-3002');
    assert.equal(rawCalls, 2, '第二次读走缓存，不再请求 QQ 后端');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
});

test('⑤ 接口平台：只给 get_msg / get_forward_msg 放宽超时，发送类仍按默认', async () => {
  assert.deepEqual([...SLOW_READ_ACTIONS], ['get_msg', 'get_forward_msg']);
  class FakeWs {
    constructor() { this.l = {}; setTimeout(() => this.l.open?.(), 0); }
    addEventListener(k, f) { this.l[k] = f; }
    send() {} // 永远不回执：用来量超时
    close() {}
  }
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  const c = createOneBotWsConnector({
    provider: 'qq-test', discover: () => [],
    instance: { id: 'inst-1', upstream: { wsUrl: 'ws://127.0.0.1:1/', accessToken: '' } },
    limits: { requestTimeoutMs: 40, slowReadTimeoutMs: 300 }, log, onEvent() {}, WebSocketImpl: FakeWs,
  });
  c.start();
  await sleep(20);
  const timed = async (action) => {
    const t0 = Date.now();
    const err = await c.callAction(null, action, {}).then(() => null, (e) => e);
    return { err, ms: Date.now() - t0 };
  };
  const [slow, fast] = await Promise.all([timed('get_forward_msg'), timed('send_group_msg')]);
  assert.match(String(fast.err?.message), /秒内没有回执/);
  assert.match(String(slow.err?.message), /秒内没有回执/);
  assert.ok(fast.ms < 200, `发送类按默认超时（40ms），实际 ${fast.ms}ms`);
  assert.ok(slow.ms >= 250, `get_forward_msg 按放宽后的超时（300ms），实际 ${slow.ms}ms`);
  const getMsg = await timed('get_msg');
  assert.ok(getMsg.ms >= 250, 'get_msg 也放宽');
  c.stop();
  // 源码层兜底：callAction 按动作选超时
  const src = fs.readFileSync(new URL('../interface-platform/src/connectors/onebot-v11/connector.mjs', import.meta.url), 'utf8');
  assert.match(src, /call\(L, action, params, \{ timeoutMs: timeoutFor\(action\), \.\.\.opts \}\)/);
  assert.match(fs.readFileSync(new URL('../interface-platform/src/core/config.mjs', import.meta.url), 'utf8'), /slowReadTimeoutMs: 120000/);
});

test('⑥ 源码约束：发送引用时「加载中」不算确认归属；收消息用短等待', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../src/bridge.js', import.meta.url)), 'utf8');
  const v = src.slice(src.indexOf('async function verifiedReplyInfo('), src.indexOf('async function resolveReplyTargetV2('));
  assert.match(v, /return info\?\.pending \? null : info;/);
  const target = src.slice(src.indexOf('async function resolveReplyTargetV2('), src.indexOf('// 判断当前消息是否“引用/回复了机器人自己”'));
  assert.ok(!/await resolveReplyInfo\(/.test(target), '发送引用只走 verifiedReplyInfo');
  assert.match(src, /resolveReplyInfo\(kind, id, k, event\.self_id, \{ waitMs: REPLY_INGEST_WAIT_MS \}\)/);
  assert.match(src, /isQuoteTargetSelf\(event\.message \?\? \[\], kind, id, event\.self_id, resolveReply\)/, '判断引用自己复用同一次解析');
});
