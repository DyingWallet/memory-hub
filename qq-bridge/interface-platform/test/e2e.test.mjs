// 端到端离线测试：假 SnowLuma 上游 ⇄ 接口平台 ⇄（真实 @snowluma/sdk 客户端 / HTTP / SSE）。
// 所有 QQ 号、群号、令牌都是假数据。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createFakeSnowLuma } from './fixtures/fake-snowluma.mjs';
import { startPlatform } from '../src/index.mjs';

const T15 = { timeout: 15000 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000, what = '条件') {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(20); }
  throw new Error(`等待超时：${what}`);
}

// 真实 SDK（桥接用的同一个客户端）。先按常规解析；平台与桥接是平行目录，再到同级的 qq-bridge-enhanced 里找
// （或用 SNOWLUMA_SDK_DIR 指定）。都没有时跳过相关测试 —— 那是「跳过」，不是「通过」。
let SDK = null;
try { SDK = await import('@snowluma/sdk'); } catch {}
if (!SDK) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // 平台在仓库里（interface-platform/）：SDK 在仓库根目录的 node_modules；旧布局（与仓库平行的目录）也认
  const dirs = [process.env.SNOWLUMA_SDK_DIR, path.resolve(here, '..', '..', 'node_modules', '@snowluma', 'sdk'), path.resolve(here, '..', '..', 'qq-bridge-enhanced', 'node_modules', '@snowluma', 'sdk')].filter(Boolean);
  for (const d of dirs) {
    try {
      const main = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')).main ?? 'dist/index.js';
      SDK = await import(pathToFileURL(path.join(d, main)).href);
      break;
    } catch {}
  }
}

async function setup({ upstreams = null, instances = null, compat = null, limits = {} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-e2e-'));
  const fakes = upstreams ?? [await createFakeSnowLuma()];
  const cfg = {
    port: 0,
    instances: instances ?? [{ id: 'snowluma-main', provider: 'snowluma', upstream: { wsUrl: fakes[0].url, accessToken: fakes[0].token } }],
    recovery: { reconnect: true, reconnectMinMs: 40, reconnectMaxMs: 200 },
    limits: { requestTimeoutMs: 1500, ...limits },
    ...(compat ? { compat } : {}),
  };
  fs.writeFileSync(path.join(dataDir, 'platform.json'), JSON.stringify(cfg));
  const p = await startPlatform({ dataDir, stdoutLogs: false, installSignalHandlers: false, exitOnShutdown: false });
  const base = `http://127.0.0.1:${p.port}`;
  const T = p.platform.tokens;
  const cleanup = async () => { await p.shutdown('test'); for (const f of fakes) await f.close(); };
  return { ...p, fakes, fake: fakes[0], base, T, dataDir, cleanup };
}

async function j(method, url, { body, token, admin, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(admin ? { 'x-platform-admin-token': admin } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function ready(s, account = 'qq:10001') {
  await until(() => s.platform.accounts().find((a) => a.account === account && a.health.loggedIn), 3000, `账号 ${account} 登录`);
  s.fakes.forEach((f) => f.heartbeat());
  await until(() => s.platform.accounts().find((a) => a.account === account)?.health.ioReady, 3000, `账号 ${account} 收发就绪`);
}

test('健康阶梯：连上游 → 识别账号 → 心跳 good 后才算收发就绪；离线心跳回落', T15, async () => {
  const s = await setup();
  try {
    const acc = await until(() => s.platform.accounts().find((a) => a.account === 'qq:10001'));
    assert.equal(acc.health.backendReachable, true);
    assert.equal(acc.health.loggedIn, true);
    assert.equal(acc.health.ioReady, false, '没有心跳之前不能说收发就绪');
    assert.equal(acc.health.reason, 'awaiting_heartbeat');
    assert.equal(acc.nickname, '测试机器人');
    s.fake.heartbeat({ online: true, good: true });
    await until(() => s.platform.accounts()[0].health.ioReady);
    s.fake.heartbeat({ online: false, good: false });
    await until(() => s.platform.accounts()[0].health.loggedIn === false);
    assert.equal(s.platform.accounts()[0].health.reason, 'awaiting_login');
  } finally { await s.cleanup(); }
});

test('OneBot 兼容（真实 SDK 客户端）：事件原文转发、动作 echo 改写后配对、令牌错误被拒', { ...T15, skip: !SDK && '没有 @snowluma/sdk' }, async () => {
  const s = await setup();
  try {
    await ready(s);
    // Node 内置 WebSocket 握手被拒时只发 error、不发 close（SDK 的 connect() 因此不会结束），这里直接用底层客户端断言
    const rejected = await new Promise((resolve) => {
      const w = new WebSocket(`ws://127.0.0.1:${s.port}/onebot/v11/ws?access_token=wrong`);
      w.onopen = () => { w.close(); resolve(false); };
      w.onerror = () => resolve(true);
    });
    assert.equal(rejected, true, '错误令牌握手被拒');
    const bot = new SDK.SnowLumaWebSocketClient({ url: `ws://127.0.0.1:${s.port}/onebot/v11/ws`, accessToken: s.T.data, reconnect: false });
    const groupMsgs = [];
    bot.onGroupMessage((e) => groupMsgs.push(e));
    await bot.connect();
    await until(() => s.platform.compatClients.size === 1);

    const login = await bot.getLoginInfo();
    assert.equal(login.user_id, 10001);

    // 事件：含平台扩展字段与大整数的原文要原样到达
    s.fake.pushRaw('{"time":1700000000,"self_id":10001,"post_type":"message","message_type":"group","sub_type":"normal","group_id":20001,"user_id":30001,"message_id":12345678901234567890,"message":[{"type":"text","data":{"text":"你好"}}],"raw_message":"你好","sender":{"user_id":30001,"nickname":"甲"},"snowluma_extra":{"k":1}}');
    await until(() => groupMsgs.length === 1);
    assert.equal(groupMsgs[0].group_id, 20001);
    assert.deepEqual(groupMsgs[0].snowluma_extra, { k: 1 }, '平台扩展字段不丢');

    // 动作：上游看到的是平台改写过的 echo
    const before = s.fake.actions.length;
    const sent = await bot.sendGroupMessage(20001, SDK.text('回复'));
    assert.ok(sent.message_id > 0);
    const upstreamFrame = s.fake.actions.slice(before).find((a) => a.action === 'send_group_msg');
    assert.equal(upstreamFrame.params.group_id, 20001);
    assert.match(String(upstreamFrame.echo), /^pl:snowluma-main:\d+$/);
    bot.close();
  } finally { await s.cleanup(); }
});

test('OneBot 兼容 HTTP：Bearer 或 access_token 鉴权；管理令牌不能当数据令牌；上游失败原样回报', T15, async () => {
  const s = await setup();
  try {
    await ready(s);
    const ok = await j('POST', `${s.base}/onebot/v11/get_status`, { body: {}, token: s.T.data });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.status, 'ok');
    assert.equal(ok.body.data.good, true);
    assert.equal(ok.body.echo, undefined, '内部 echo 不外露');
    const q = await j('GET', `${s.base}/onebot/v11/get_login_info?access_token=${s.T.data}`);
    assert.equal(q.body.data.user_id, 10001);
    assert.equal((await j('POST', `${s.base}/onebot/v11/get_status`, { body: {}, token: s.T.admin })).status, 401);
    assert.equal((await j('POST', `${s.base}/onebot/v11/get_status`, { body: {} })).status, 401);
    const unknown = await j('POST', `${s.base}/onebot/v11/no_such_action`, { body: {}, token: s.T.data });
    assert.equal(unknown.body.status, 'failed');
    assert.equal(unknown.body.retcode, 1404);
  } finally { await s.cleanup(); }
});

test('统一发送：confirmed 带消息 ID；后端拒绝 = failed；后端不回执 = unknown 且不重发；clientRequestId 去重', T15, async () => {
  const s = await setup();
  try {
    await ready(s);
    const msg = (extra = {}) => ({ account: 'qq:10001', conversation: { type: 'group', id: '20001' }, segments: [{ type: 'text', text: '你好' }], ...extra });
    const ok = await j('POST', `${s.base}/v1/messages`, { body: msg(), token: s.T.data });
    assert.equal(ok.body.request.state, 'confirmed');
    assert.match(ok.body.request.result.messageId, /^\d+$/);

    s.fake.setResponder((f) => (f.action === 'send_group_msg' ? { status: 'failed', retcode: 100, data: null, wording: '被禁言' } : null));
    const rej = await j('POST', `${s.base}/v1/messages`, { body: msg(), token: s.T.data });
    assert.equal(rej.body.request.state, 'failed');
    assert.equal(rej.body.request.error.code, 'backend_rejected');
    assert.equal(rej.body.request.error.detail.retcode, 100);

    s.fake.setResponder(() => null);
    const before = s.fake.actions.filter((a) => a.action === 'send_group_msg').length;
    const unk = await j('POST', `${s.base}/v1/messages?wait=4000`, { body: msg(), token: s.T.data });
    assert.equal(unk.body.request.state, 'unknown');
    await sleep(300);
    assert.equal(s.fake.actions.filter((a) => a.action === 'send_group_msg').length, before + 1, '结果未知时不自动重发');

    s.fake.setResponder(null);
    const d1 = await j('POST', `${s.base}/v1/messages`, { body: msg({ clientRequestId: 'same-1' }), token: s.T.data });
    const d2 = await j('POST', `${s.base}/v1/messages`, { body: msg({ clientRequestId: 'same-1' }), token: s.T.data });
    assert.equal(d2.body.duplicate, true);
    assert.equal(d2.body.request.id, d1.body.request.id);
    const r = await j('GET', `${s.base}/v1/requests/${d1.body.request.id}`, { token: s.T.data });
    assert.equal(r.body.request.state, 'confirmed');

    const unsup = await j('POST', `${s.base}/v1/messages`, { body: msg({ segments: [{ type: 'file', file: 'base64://AA' }] }), token: s.T.data });
    assert.equal(unsup.status, 422, '不支持的段明确报错');
    const temp = await j('POST', `${s.base}/v1/messages`, { body: msg({ conversation: { type: 'temp', id: '1' } }), token: s.T.data });
    assert.equal(temp.body.error.code, 'capability_unsupported');
  } finally { await s.cleanup(); }
});

function sse(url, token) {
  const events = [];
  const req = http.get(url, { headers: { authorization: `Bearer ${token}` } }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = {};
        for (const line of block.split('\n')) {
          const m = /^(id|event|data): (.*)$/.exec(line);
          if (m) ev[m[1]] = m[1] === 'data' ? JSON.parse(m[2]) : m[2];
        }
        if (ev.event) events.push(ev);
      }
    });
  });
  return { events, close: () => req.destroy() };
}

test('SSE 事件流：统一事件实时推送；带游标重连补齐；过期游标明确告知', T15, async () => {
  const s = await setup();
  try {
    await ready(s);
    const a = sse(`${s.base}/v1/events?account=qq:10001`, s.T.data);
    await until(() => s.platform.sseClients.size === 1);
    s.fake.push({ post_type: 'message', message_type: 'private', sub_type: 'friend', user_id: 30001, message_id: 1, message: [{ type: 'text', data: { text: '一' } }], sender: { user_id: 30001 } });
    const e1 = await until(() => a.events.find((e) => e.event === 'message.private'));
    assert.equal(e1.data.message.text, '一');
    assert.deepEqual(e1.data.conversation, { type: 'private', id: '30001' });
    a.close();
    s.fake.push({ post_type: 'notice', notice_type: 'group_increase', group_id: 20001, user_id: 30002 });
    await sleep(50);
    const b = sse(`${s.base}/v1/events?after=${e1.id}`, s.T.data);
    const e2 = await until(() => b.events.find((e) => e.event === 'notice.group_increase'));
    assert.equal(e2.data.ext.qq.user_id, 30002);
    b.close();
    const c = sse(`${s.base}/v1/events?after=evt_0`, s.T.data);
    await sleep(100);
    assert.ok(!c.events.some((e) => e.event === 'cursor_expired'), '窗口内不过期');
    c.close();
  } finally { await s.cleanup(); }
});

test('停用账号的桥接：账号仍在线，但兼容客户端收不到事件、动作被拒；再启用恢复', { ...T15, skip: !SDK && '没有 @snowluma/sdk' }, async () => {
  const s = await setup();
  try {
    await ready(s);
    const bot = new SDK.SnowLumaWebSocketClient({ url: `ws://127.0.0.1:${s.port}/onebot/v11/ws`, accessToken: s.T.data, reconnect: false });
    const got = [];
    bot.onPrivateMessage((e) => got.push(e));
    await bot.connect();
    const off = await j('POST', `${s.base}/v1/admin/accounts/qq:10001/bridge`, { body: { enabled: false }, admin: s.T.admin });
    assert.equal(off.body.bridgeEnabled, false);
    s.fake.push({ post_type: 'message', message_type: 'private', user_id: 30001, message_id: 2, message: 'x', sender: { user_id: 30001 } });
    await sleep(150);
    assert.equal(got.length, 0);
    assert.equal(s.platform.accounts()[0].health.loggedIn, true, '账号仍在线');
    await assert.rejects(bot.getLoginInfo());
    await j('POST', `${s.base}/v1/admin/accounts/qq:10001/bridge`, { body: { enabled: true }, admin: s.T.admin });
    s.fake.push({ post_type: 'message', message_type: 'private', user_id: 30001, message_id: 3, message: 'y', sender: { user_id: 30001 } });
    await until(() => got.length === 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.dataDir, 'platform.json'), 'utf8')).accounts['qq:10001'].bridgeEnabled, true, '开关持久化');
    bot.close();
  } finally { await s.cleanup(); }
});

test('实例断开/连接只影响该实例；上游掉线自动重连；在途动作以「未知」结束', T15, async () => {
  const s = await setup();
  try {
    await ready(s);
    const dis = await j('POST', `${s.base}/v1/admin/instances/snowluma-main/disconnect`, { body: {}, admin: s.T.admin });
    assert.deepEqual(dis.body.accounts, ['qq:10001']);
    await until(() => s.fake.connections === 0);
    await sleep(200);
    assert.equal(s.fake.connections, 0, '用户断开后不自动重连');
    const fail = await j('POST', `${s.base}/v1/messages`, { body: { account: 'qq:10001', conversation: { type: 'group', id: '1' }, segments: [{ type: 'text', text: 'x' }] }, token: s.T.data });
    assert.equal(fail.body.error.code, 'instance_unavailable', '断开期间发送冻结');
    await j('POST', `${s.base}/v1/admin/instances/snowluma-main/connect`, { body: {}, admin: s.T.admin });
    await ready(s);

    s.fake.setSilent(true);
    const inflight = j('POST', `${s.base}/onebot/v11/get_status`, { body: {}, token: s.T.data });
    await sleep(50);
    s.fake.dropAll();
    const r = await inflight;
    assert.equal(r.body.status, 'failed');
    assert.equal(r.body.retcode, 1504, '掉线时在途动作 = 结果未知');
    s.fake.setSilent(false);
    await until(() => s.fake.connections === 1, 3000, '自动重连');
    await until(() => s.platform.accounts()[0]?.health.backendReachable);
  } finally { await s.cleanup(); }
});

test('多账号：按 SnowLuma 目录发现两个账号各建链路；auto 无法确定目标时明确报错；路径 @账号 可指定', T15, async () => {
  const f1 = await createFakeSnowLuma({ token: 'tok-a', selfId: 10001 });
  const f2 = await createFakeSnowLuma({ token: 'tok-b', selfId: 10002 });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-home-'));
  fs.mkdirSync(path.join(home, 'config'));
  for (const [uin, f] of [['10001', f1], ['10002', f2]]) {
    fs.writeFileSync(path.join(home, 'config', `onebot_${uin}.json`), JSON.stringify({ networks: { wsServers: [{ host: '0.0.0.0', port: f.port, accessToken: f.token }] } }));
  }
  const s = await setup({ upstreams: [f1, f2], instances: [{ id: 'snowluma-main', provider: 'snowluma', upstream: { homeDir: home } }] });
  try {
    await ready(s, 'qq:10001');
    await ready(s, 'qq:10002');
    assert.equal(s.platform.accounts().length, 2);
    assert.equal(s.platform.accounts()[0].instance, 'snowluma-main', '一个实例提供两个账号');
    const auto = await j('POST', `${s.base}/onebot/v11/get_login_info`, { body: {}, token: s.T.data });
    assert.equal(auto.body.status, 'failed');
    assert.match(auto.body.wording, /auto 无法确定/);
    const pick = await j('POST', `${s.base}/onebot/v11/@qq:10002/get_login_info`, { body: {}, token: s.T.data });
    assert.equal(pick.body.data.user_id, 10002, '按路径路由到指定账号');
    assert.equal(f1.actions.filter((a) => a.action === 'get_login_info').length, 1, '账号 A 的链路不处理账号 B 的动作');
  } finally { await s.cleanup(); }
});

test('管理接口：只认管理令牌；概览含实例/账号/支持范围；未提供的提供方不能建实例；Host 校验', T15, async () => {
  const s = await setup();
  try {
    await ready(s);
    assert.equal((await j('GET', `${s.base}/v1/admin/overview`, { token: s.T.data })).status, 401, '数据令牌不能调管理接口');
    const ov = await j('GET', `${s.base}/v1/admin/overview`, { admin: s.T.admin });
    assert.equal(ov.body.counts.accountsReady, 1);
    assert.equal(ov.body.instances[0].upstream.hasToken, true);
    assert.ok(!JSON.stringify(ov.body).includes(s.fake.token), '概览不外露上游令牌');
    const pv = await j('GET', `${s.base}/v1/admin/providers`, { admin: s.T.admin });
    assert.equal(pv.body.providers.find((p) => p.id === 'qq-mac-native').available, false);
    const bad = await j('POST', `${s.base}/v1/admin/instances`, { body: { id: 'mac', provider: 'qq-mac-native' }, admin: s.T.admin });
    assert.match(bad.body.error.message, /尚未提供/);
    const logs = await j('GET', `${s.base}/v1/admin/logs?instance=snowluma-main`, { admin: s.T.admin });
    assert.ok(logs.body.lines.length > 0);
    assert.ok(!JSON.stringify(logs.body).includes(s.fake.token), '日志脱敏');
    // fetch 不允许改 Host 头，用 http.request 模拟 DNS 重绑定
    const evil = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: s.port, path: '/v1/health', headers: { host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); }));
    assert.equal(evil, 403);
    assert.equal((await j('GET', `${s.base}/v1/health`)).body.ok, true);
  } finally { await s.cleanup(); }
});

test('静态边界：平台代码不启停任何进程、不含 SnowLuma 进程控制', () => {
  // fileURLToPath 而不是 URL.pathname：Windows 上 pathname 是 /C:/…，拼出来会变成 C:\C:\…
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.mjs')) files.push(p); } };
  walk(root);
  for (const f of files) {
    const code = fs.readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    for (const bad of ['child_process', 'launcher.bat', 'process.kill', 'spawn(', 'execFile']) {
      assert.ok(!code.includes(bad), `${path.relative(root, f)} 不得包含「${bad}」`);
    }
  }
});

test('WebSocket 大帧：客户端 → 平台 → 上游 200KB 动作、上游 → 平台 → 客户端 200KB 事件都完整', T15, async () => {
  const s = await setup();
  try {
    await ready(s);
    const big = '字'.repeat(70_000); // UTF-8 约 210KB，走 64 位长度帧
    const w = new WebSocket(`ws://127.0.0.1:${s.port}/onebot/v11/ws?access_token=${s.T.data}`);
    const got = [];
    w.onmessage = (m) => got.push(JSON.parse(m.data));
    await new Promise((r, x) => { w.onopen = r; w.onerror = x; });
    w.send(JSON.stringify({ action: 'send_group_msg', params: { group_id: 20001, message: big }, echo: 'e1' }));
    const reply = await until(() => got.find((g) => g.echo === 'e1'));
    assert.equal(reply.status, 'ok');
    assert.equal(s.fake.actions.find((a) => a.action === 'send_group_msg').params.message, big);
    s.fake.push({ post_type: 'message', message_type: 'group', group_id: 20001, user_id: 30001, message_id: 7, message: big, sender: { user_id: 30001 } });
    const ev = await until(() => got.find((g) => g.post_type === 'message'));
    assert.equal(ev.message, big);
    w.close();
  } finally { await s.cleanup(); }
});

test('启动方交来的管理令牌可用于管理接口、不能当数据令牌；bridge-link 只对管理令牌开放', T15, async () => {
  const extra = 'cc'.repeat(24);
  process.env.INTERFACE_PLATFORM_ADMIN_TOKEN = extra;
  let s;
  try { s = await setup(); } finally { delete process.env.INTERFACE_PLATFORM_ADMIN_TOKEN; }
  try {
    assert.equal((await j('GET', `${s.base}/v1/admin/overview`, { admin: extra })).status, 200);
    assert.equal((await j('POST', `${s.base}/onebot/v11/get_status`, { body: {}, token: extra })).status, 401);
    const link = await j('GET', `${s.base}/v1/admin/bridge-link`, { admin: extra });
    assert.equal(link.body.dataToken, s.T.data);
    assert.equal(link.body.wsUrl, `ws://127.0.0.1:${s.port}/onebot/v11/ws`);
    assert.equal((await j('GET', `${s.base}/v1/admin/bridge-link`, { token: s.T.data })).status, 401);
    const short = (await import('../src/core/config.mjs')).extraAdminToken('short');
    assert.equal(short, null, '过短的令牌被忽略');
  } finally { await s.cleanup(); }
});

test('NapCat 连接器：按 NapCat 配置目录发现账号并收发；令牌错误（先接受再回 1403）识别为 auth_failed', T15, async () => {
  const f = await createFakeSnowLuma({ token: 'nap-ok', selfId: 10001, authStyle: 'napcat' });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-napcat-'));
  fs.mkdirSync(path.join(home, 'config'));
  const writeCfg = (tok) => fs.writeFileSync(path.join(home, 'config', 'onebot11_10001.json'), `{ // 假 NapCat 配置\n "network": { "websocketServers": [ { "enable": true, "host": "127.0.0.1", "port": ${f.port}, "token": "${tok}" } ] } }`);
  writeCfg('nap-ok');
  const s = await setup({ upstreams: [f], instances: [{ id: 'napcat-main', provider: 'napcat', upstream: { homeDir: home } }] });
  try {
    await ready(s);
    const a = s.platform.accounts()[0];
    assert.equal(a.provider, 'napcat');
    assert.equal(a.instance, 'napcat-main');
    const ok = await j('POST', `${s.base}/v1/messages`, { body: { account: 'qq:10001', conversation: { type: 'private', id: '30001' }, segments: [{ type: 'text', text: '你好' }] }, token: s.T.data });
    assert.equal(ok.body.request.state, 'confirmed');
    assert.equal(f.actions.find((x) => x.action === 'send_private_msg').params.user_id, 30001);
    const compat = await j('POST', `${s.base}/onebot/v11/get_login_info`, { body: {}, token: s.T.data });
    assert.equal(compat.body.data.user_id, 10001, '兼容入口对 NapCat 后端同样可用');
    // 后端自报的程序与版本（get_version_info）出现在链路快照里，供控制中心显示
    await until(() => s.platform.instancesView()[0].links[0]?.backend?.appVersion, 5000, '后端版本');
    assert.deepEqual(s.platform.instancesView()[0].links[0].backend, { appName: 'NapCat.Onebot', appVersion: '4.0.0-test', protocolVersion: 'v11' });

    // 换成错误令牌后重连：识别为鉴权失败而不是普通掉线
    writeCfg('nap-wrong');
    f.dropAll();
    await until(() => s.platform.instancesView()[0].links[0]?.reason === 'auth_failed', 5000, '识别 auth_failed');
    assert.equal(s.platform.accounts()[0].health.backendReachable, false);
  } finally { await s.cleanup(); }
});

test('后端晚于平台启动：连接被拒（Node 只发 error）后仍按退避重试，后端起来后自动连上', T15, async () => {
  const net = await import('node:net');
  const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-late-'));
  fs.writeFileSync(path.join(dataDir, 'platform.json'), JSON.stringify({ port: 0, instances: [{ id: 'late', provider: 'napcat', upstream: { wsUrl: `ws://127.0.0.1:${port}`, accessToken: 'late-tok' } }], recovery: { reconnectMinMs: 50, reconnectMaxMs: 200 } }));
  const p = await startPlatform({ dataDir, stdoutLogs: false, installSignalHandlers: false, exitOnShutdown: false });
  let f = null;
  try {
    await until(() => p.platform.instancesView()[0].links[0]?.reason === 'connect_failed', 3000, '第一次连接失败被识别');
    // 后端这时才起来，用刚才那个端口
    const http2 = await import('node:http');
    const { acceptWebSocket } = await import('../src/net/ws-server.mjs');
    const srv = http2.createServer();
    srv.on('upgrade', (req, sock, head) => {
      const c = acceptWebSocket(req, sock, head);
      c?.on('message', (t) => { const fr = JSON.parse(t); c.sendText(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 10009, nickname: '晚到' }, echo: fr.echo })); });
    });
    await new Promise((r) => srv.listen(port, '127.0.0.1', r));
    f = srv;
    await until(() => p.platform.accounts().find((a) => a.account === 'qq:10009' && a.health.loggedIn), 5000, '后端起来后自动连上');
  } finally {
    await p.shutdown('test');
    if (f) { f.closeAllConnections?.(); await new Promise((r) => f.close(r)); }
  }
});
