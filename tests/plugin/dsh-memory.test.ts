// @ts-nocheck
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const plugin = await import('../../../plugins/dsh-memory/lib/index.js');

let dir;
let tokenFile;
const calls = [];
const realFetch = globalThis.fetch;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-memory-plugin-'));
  tokenFile = join(dir, 'token');
  writeFileSync(tokenFile, 'msv1.test.secret\n', 'utf8');
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ written: 1, skipped: 0 }), text: async () => '' };
  };
});

after(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

function harness(config = {}) {
  const handlers = [];
  const ctx = { on: (event, handler) => handlers.push({ event, handler }) };
  plugin.apply(ctx, { endpoint: 'http://memd.test', tokenFile, scene: 'main', ...config });
  assert.equal(handlers.length, 1);
  const run = async (messages, turn = 1, step = 1, sessionId = 'session-abc') => {
    const handler = handlers[0].handler;
    return handler(
      {
        agent: { session: { header: { id: sessionId } } },
        messages,
        turn,
        step,
        signal: { aborted: false },
      },
      async () => ({ kind: 'enter', messages }),
    );
  };
  return { run };
}

const userMessage = (text) => ({ content: [{ type: 'text', text }] });

test('ingests user messages of a normal DSH session', async () => {
  calls.length = 0;
  const { run } = harness();
  await run([userMessage('我今天去取了快递')]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1\/ingest$/);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.messages.length, 1);
  assert.match(body.messages[0].message_id, /^session-abc:1:1:/);
  assert.equal(body.messages[0].text, '我今天去取了快递');
  assert.equal(body.scene, 'main');
});

test('has no message cap for DSH sessions; it batches in 50s', async () => {
  calls.length = 0;
  const { run } = harness();
  const many = Array.from({ length: 120 }, (_, i) => userMessage(`消息 ${i}`));
  await run(many);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls.length, 3, '120 messages -> 50 + 50 + 20');
  const counts = calls.map((call) => JSON.parse(call.init.body).messages.length);
  assert.deepEqual(counts, [50, 50, 20]);
});

test('a failing memd must not produce an unhandled rejection', async () => {
  const rejections = [];
  const onRejection = (error) => rejections.push(error);
  process.on('unhandledRejection', onRejection);
  globalThis.fetch = async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:8787');
  };
  try {
    const { run } = harness();
    await run([userMessage('这条会失败')]);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(rejections, [], 'fetch rejection must be swallowed (DSH exits on unhandledRejection)');
  } finally {
    process.off('unhandledRejection', onRejection);
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ written: 1, skipped: 0 }), text: async () => '' };
    };
  }
});

test('skips QQ bridge sessions (bridge already ingests them)', async () => {
  calls.length = 0;
  const { run } = harness();
  await run([userMessage('【会话令牌】abc123\n【唤醒】group:10001')]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 0);
});

test('does nothing when disabled', () => {
  const handlers = [];
  const ctx = { on: (event, handler) => handlers.push({ event, handler }) };
  plugin.apply(ctx, { enabled: false, endpoint: 'http://memd.test', tokenFile });
  assert.equal(handlers.length, 0);
  assert.equal(calls.length, 0);
});

test('textOf merges text parts and ignores non-text', () => {
  assert.equal(plugin.textOf({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(plugin.textOf({ content: 'plain' }), 'plain');
  assert.equal(plugin.textOf({}), '');
});

test('isBridgeSession detects the session-token line', () => {
  assert.equal(plugin.isBridgeSession([{ content: [{ type: 'text', text: '【会话令牌】x' }] }]), true);
  assert.equal(plugin.isBridgeSession([{ content: [{ type: 'text', text: '普通消息' }] }]), false);
});
