// 纯函数与小模块的离线测试：ID/JSON、映射、请求状态机、事件总线、日志脱敏、配置、发现。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeJsonParse, accountId, parseAccountId, PlatformError } from '../src/core/model.mjs';
import { toUnifiedEvent, toOneBotSegments, sendActionFor, fromOneBotSegments } from '../src/connectors/onebot-v11/mapping.mjs';
import { discoverWsEndpoints } from '../src/connectors/qq-snowluma/discovery.mjs';
import { createRequestTracker } from '../src/core/requests.mjs';
import { createEventBus } from '../src/core/event-bus.mjs';
import { createLogger, redactText } from '../src/core/logger.mjs';
import { normalizeConfig, loadTokens } from '../src/core/config.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pl-unit-'));

test('ID：超过 2^53 的整数按源文本保留为字符串，安全整数不变', () => {
  const v = safeJsonParse('{"group_id":12345678901234567890,"user_id":10001,"x":1.5}');
  assert.equal(v.group_id, '12345678901234567890');
  assert.equal(v.user_id, 10001);
  assert.equal(v.x, 1.5);
  assert.equal(accountId('qq', 10001), 'qq:10001');
  assert.deepEqual(parseAccountId('qq:10001'), { platform: 'qq', raw: '10001' });
  assert.equal(parseAccountId('10001'), null, '没有平台前缀的不是账号 ID');
});

test('映射：群消息 → 统一事件，ID 全是字符串，未知段放进 ext 不丢', () => {
  const e = toUnifiedEvent({
    time: 1700000000, self_id: 10001, post_type: 'message', message_type: 'group', sub_type: 'normal', group_id: 20001, user_id: 30001, message_id: 555,
    sender: { user_id: 30001, nickname: '昵称', card: '群名片' },
    message: [{ type: 'reply', data: { id: '444' } }, { type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' 你好' } }, { type: 'face', data: { id: '14' } }],
  }, { instance: 'snowluma-main', now: 1 });
  assert.equal(e.account, 'qq:10001');
  assert.equal(e.type, 'message.group');
  assert.deepEqual(e.conversation, { type: 'group', id: '20001' });
  assert.deepEqual(e.sender, { id: '30001', name: '群名片' });
  assert.equal(e.message.id, '555');
  assert.equal(e.message.text, '@10001 你好');
  assert.deepEqual(e.message.segments[3], { type: 'ext', platform: 'qq', kind: 'face', data: { id: '14' } });
  assert.equal(e.occurredAt, 1700000000000);
});

test('映射：临时会话、通知、bot_status、心跳、未知事件', () => {
  assert.equal(toUnifiedEvent({ self_id: 1, post_type: 'message', message_type: 'private', sub_type: 'group', user_id: 2, group_id: 3, message: 'hi' }).type, 'message.temp');
  const n = toUnifiedEvent({ self_id: 1, post_type: 'notice', notice_type: 'group_increase', group_id: 3, user_id: 4 });
  assert.equal(n.type, 'notice.group_increase');
  assert.deepEqual(n.conversation, { type: 'group', id: '3' });
  assert.equal(n.ext.qq.notice_type, 'group_increase', '平台扩展字段原样保留');
  assert.equal(toUnifiedEvent({ self_id: 1, post_type: 'notice', notice_type: 'bot_status', sub_type: 'offline' }).ext.qq.online, false);
  assert.equal(toUnifiedEvent({ self_id: 1, post_type: 'meta_event', meta_event_type: 'heartbeat', status: { good: true } }).type, 'meta.heartbeat');
  const u = toUnifiedEvent({ self_id: 1, post_type: 'weird' });
  assert.equal(u.type, 'unknown');
  assert.equal(u.ext.qq.raw.post_type, 'weird');
});

test('映射：统一发送 → OneBot 动作；不支持的段整条拒绝；本地路径媒体拒绝', () => {
  const a = sendActionFor({ type: 'group', id: '20001' }, [{ type: 'text', text: 'hi' }, { type: 'mention', target: 'all' }, { type: 'image', file: 'base64://AAAA' }]);
  assert.equal(a.action, 'send_group_msg');
  assert.equal(a.params.group_id, 20001);
  assert.deepEqual(a.params.message[1], { type: 'at', data: { qq: 'all' } });
  assert.equal(sendActionFor({ type: 'group', id: '12345678901234567890' }, [{ type: 'text', text: 'x' }]).params.group_id, '12345678901234567890', '超出安全整数的 ID 不转 number');
  assert.throws(() => toOneBotSegments([{ type: 'file', file: 'base64://AA' }]), (e) => e instanceof PlatformError && e.code === 'unsupported_segment');
  assert.throws(() => toOneBotSegments([{ type: 'image', file: 'C:\\Users\\me\\a.png' }]), /base64/);
  assert.throws(() => toOneBotSegments([{ type: 'voice', file: 'file:///etc/passwd' }]), /base64/);
  assert.throws(() => toOneBotSegments([]), /不能为空/);
  assert.throws(() => sendActionFor({ type: 'temp', id: '1' }, [{ type: 'text', text: 'x' }]), (e) => e.code === 'capability_unsupported');
  assert.throws(() => sendActionFor({ type: 'group', id: 'abc' }, [{ type: 'text', text: 'x' }]), /数字/);
  assert.deepEqual(fromOneBotSegments('纯文本'), [{ type: 'text', text: '纯文本' }]);
});

test('请求：确认 / 后端拒绝 / 结果未知 / 去重 / 队列上限 / 断开时作废排队', async () => {
  const t = createRequestTracker({ queueLimit: 2 });
  const ok = t.submit({ account: 'qq:1', execute: async ({ markSubmitted }) => { markSubmitted(); return { messageId: '9' }; } });
  assert.equal((await t.wait(ok.request.id, 1000)).state, 'confirmed');

  const rej = t.submit({ account: 'qq:1', execute: async ({ markSubmitted }) => { markSubmitted(); throw Object.assign(new PlatformError('backend_rejected', '拒绝'), { backendRejected: true }); } });
  assert.equal((await t.wait(rej.request.id, 1000)).state, 'failed');

  const unk = t.submit({ account: 'qq:1', execute: async ({ markSubmitted }) => { markSubmitted(); throw Object.assign(new Error('超时'), { outcome: 'unknown' }); } });
  const u = await t.wait(unk.request.id, 1000);
  assert.equal(u.state, 'unknown', '已提交后超时 = 结果未知');

  let runs = 0;
  const d1 = t.submit({ account: 'qq:1', clientRequestId: 'abc', execute: async () => { runs += 1; return {}; } });
  const d2 = t.submit({ account: 'qq:1', clientRequestId: 'abc', execute: async () => { runs += 1; return {}; } });
  assert.equal(d2.duplicate, true);
  assert.equal(d2.request.id, d1.request.id);
  await t.wait(d1.request.id, 1000);
  assert.equal(runs, 1, '同一 clientRequestId 只执行一次');

  let release;
  const gate = new Promise((r) => { release = r; });
  t.submit({ account: 'qq:2', execute: () => gate });
  await sleep(5);
  const q1 = t.submit({ account: 'qq:2', execute: async () => ({}) });
  t.submit({ account: 'qq:2', execute: async () => ({}) });
  assert.throws(() => t.submit({ account: 'qq:2', execute: async () => ({}) }), (e) => e.code === 'queue_full');
  assert.ok(t.submit({ account: 'qq:3', execute: async () => ({}) }), '别的账号不受影响');
  assert.equal(t.failQueued('qq:2', new PlatformError('instance_unavailable', '断开')), 2);
  assert.equal(t.get(q1.request.id).state, 'failed');
  release({});
});

test('事件总线：游标重放、窗口过期、订阅者异常不影响其他订阅者', () => {
  const bus = createEventBus({ windowSize: 3 });
  const got = [];
  bus.subscribe(() => { throw new Error('坏订阅者'); });
  bus.subscribe((e) => got.push(e.id));
  for (let i = 0; i < 5; i++) bus.publish({ type: 't', n: i });
  assert.deepEqual(got, ['evt_1', 'evt_2', 'evt_3', 'evt_4', 'evt_5']);
  assert.deepEqual(bus.since('evt_3').events.map((e) => e.id), ['evt_4', 'evt_5']);
  assert.equal(bus.since('evt_3').expired, false);
  assert.equal(bus.since('evt_1').expired, true, '游标早于窗口');
});

test('日志：令牌按值脱敏，通用凭据模式也脱敏；按级别和实例筛选', () => {
  const known = 'abcdef0123456789abcdef';
  const log = createLogger({ stdout: false, secrets: () => [known] });
  log.info('instance', `连接 ws://x?access_token=zzz123 令牌 ${known}`, { instance: 'a' });
  log.warn('core', 'Authorization: Bearer qwertyuiop');
  const all = log.query();
  assert.ok(!all[0].msg.includes(known));
  assert.ok(!all[0].msg.includes('zzz123'));
  assert.ok(!all[1].msg.includes('qwertyuiop'));
  assert.equal(log.query({ level: 'warn' }).length, 1);
  assert.equal(log.query({ instance: 'a' }).length, 1);
  assert.equal(redactText('"accessToken":"secretvalue"'), '"accessToken":"***"');
});

test('配置：默认值、非法实例 ID、重复 ID；令牌 48 位十六进制且数据/管理令牌不同', () => {
  const c = normalizeConfig(null, 'win32');
  assert.equal(c.instances[0].provider, 'snowluma');
  assert.equal(normalizeConfig(null, 'darwin').instances[0].provider, 'napcat', 'Mac 默认用 NapCat（SnowLuma 没有 Mac 版）');
  assert.equal(normalizeConfig(null, 'darwin').instances[0].id, 'napcat-main');
  assert.equal(c.instances[0].management, 'external');
  assert.throws(() => normalizeConfig({ instances: [{ id: 'Bad ID' }] }), /不合法/);
  assert.throws(() => normalizeConfig({ instances: [{ id: 'a' }, { id: 'a' }] }), /重复/);
  const d = tmp();
  const t = loadTokens(d);
  assert.match(t.data, /^[a-f0-9]{48}$/);
  assert.notEqual(t.data, t.admin);
  assert.deepEqual(loadTokens(d), t, '再次读取不变');
});

test('发现：从 SnowLuma 目录按账号读出 WS 端点；监听地址 0.0.0.0 改为回环；坏文件跳过', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'config'));
  fs.writeFileSync(path.join(d, 'config', 'onebot_10001.json'), JSON.stringify({ networks: { wsServers: [{ host: '0.0.0.0', port: 3101, accessToken: 'tok1' }], httpServers: [{ port: 3000, accessToken: 'http-tok' }] } }));
  fs.writeFileSync(path.join(d, 'config', 'onebot_10002.json'), '\uFEFF' + JSON.stringify({ networks: { wsServers: [{ port: 3102, accessToken: 'tok2' }] } }));
  fs.writeFileSync(path.join(d, 'config', 'onebot_10003.json'), '{坏');
  const eps = discoverWsEndpoints(d);
  assert.deepEqual(eps.map((e) => [e.uin, e.wsUrl, e.token]), [['10001', 'ws://127.0.0.1:3101', 'tok1'], ['10002', 'ws://127.0.0.1:3102', 'tok2']]);
  assert.deepEqual(discoverWsEndpoints(path.join(d, 'nope')), []);
});

test('NapCat 发现：onebot11_<QQ>.json（JSON5：注释、尾逗号、单引号）、只取启用的 WS 服务端、接受 config 目录或上一级', async () => {
  const { discoverNapCatEndpoints, parseLooseJson } = await import('../src/connectors/qq-napcat/discovery.mjs');
  assert.deepEqual(parseLooseJson("{ // 注释\n 'a': 'x//y', /* 块 */ \"b\": [1,2,], }"), { a: 'x//y', b: [1, 2] });
  const d = tmp();
  fs.mkdirSync(path.join(d, 'config'));
  fs.writeFileSync(path.join(d, 'config', 'onebot11_10001.json'), `{
    // NapCat 生成的配置，用户可能手改加注释
    "network": {
      "websocketServers": [
        { "name": "关掉的", "enable": false, "host": "127.0.0.1", "port": 3009, "token": "off" },
        { "name": "ws", "enable": true, "host": "0.0.0.0", "port": 3011, "token": "nap-tok", },
      ],
    },
  }`);
  fs.writeFileSync(path.join(d, 'config', 'onebot11_10002.json'), JSON.stringify({ network: { websocketServers: [{ enable: false, port: 1 }] } }));
  fs.writeFileSync(path.join(d, 'config', 'onebot_10003.json'), '{}'); // SnowLuma 的文件名不算
  const eps = discoverNapCatEndpoints(d);
  assert.deepEqual(eps.map((e) => [e.uin, e.wsUrl, e.token]), [['10001', 'ws://127.0.0.1:3011', 'nap-tok']], '没有启用 WS 服务端的账号不建链路');
  assert.deepEqual(discoverNapCatEndpoints(path.join(d, 'config')).map((e) => e.uin), ['10001'], '直接给 config 目录也行');
});

test('发现：目录不存在 = 没有账号；目录在但读不了（权限 / macOS 隐私保护）= 抛 DISCOVERY_UNREADABLE，不当成没有', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const { discoverNapCatEndpoints } = await import('../src/connectors/qq-napcat/discovery.mjs');
  const { classifyReadError } = await import('../src/connectors/discovery-errors.mjs');
  const d = tmp();
  fs.mkdirSync(path.join(d, 'config'));
  fs.writeFileSync(path.join(d, 'config', 'onebot11_10001.json'), '{"network":{"websocketServers":[{"enable":true,"port":3001}]}}');
  assert.equal(discoverNapCatEndpoints(d).length, 1);
  assert.deepEqual(discoverNapCatEndpoints(path.join(d, 'nope')), [], '不存在 → 空');
  fs.chmodSync(path.join(d, 'config'), 0o000);
  try {
    assert.throws(() => discoverNapCatEndpoints(d), (e) => e.code === 'DISCOVERY_UNREADABLE');
    assert.throws(() => discoverWsEndpoints(d), (e) => e.code === 'DISCOVERY_UNREADABLE', 'SnowLuma 发现同样处理');
  } finally { fs.chmodSync(path.join(d, 'config'), 0o755); }
  assert.equal(classifyReadError(new SyntaxError('bad json'), 'x'), false, '内容坏了不算读不了');
});

test('连接器：重扫时目录读不了 → 保留现有链路并记一次警告；恢复可读后照常；目录里真没了才关链路', async (t) => {
  const { createOneBotWsConnector } = await import('../src/connectors/onebot-v11/connector.mjs');
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  class FakeWs { constructor() { this.l = {}; } addEventListener(k, f) { this.l[k] = f; } close() {} send() {} }
  let mode = 'ok';
  const discover = () => {
    if (mode === 'unreadable') { const e = new Error('读不到 /x（EPERM）'); e.code = 'DISCOVERY_UNREADABLE'; throw e; }
    return mode === 'ok' ? [{ uin: '10001', wsUrl: 'ws://127.0.0.1:1', token: '' }] : [];
  };
  const warns = [];
  const log = { info() {}, warn: (m) => warns.push(m), error() {}, debug() {} };
  const c = createOneBotWsConnector({
    provider: { id: 'napcat', name: 'NapCat' }, discover, log, onEvent() {}, WebSocketImpl: FakeWs,
    instance: { id: 'napcat-main', provider: 'napcat', enabled: true, upstream: { homeDir: '/x' } },
  });
  c.start();
  assert.equal(c.links().length, 1);
  mode = 'unreadable';
  t.mock.timers.tick(30_000);
  t.mock.timers.tick(30_000);
  assert.equal(c.links().length, 1, '读不了时不关链路');
  assert.match(c.discoveryError(), /EPERM/);
  assert.equal(warns.filter((m) => m.includes('保留现有链路')).length, 1, '同一原因只警告一次');
  mode = 'ok';
  t.mock.timers.tick(30_000);
  assert.equal(c.discoveryError(), null);
  assert.equal(c.links().length, 1);
  mode = 'gone';
  t.mock.timers.tick(30_000);
  assert.equal(c.links().length, 0, '目录里真没了才关');
  c.stop();
});
