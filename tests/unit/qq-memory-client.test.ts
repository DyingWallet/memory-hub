import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error plain-JS bundle (the bridge client ships without declarations)
import { createQQMemoryClient, sceneForConvKey } from '@memsvc/adapter-qq';

interface Captured {
  path: string;
  body: Record<string, unknown>;
  authorization?: string;
}

const tokenFile = join(mkdtempSync(join(tmpdir(), 'memsvc-qq-')), 'memory.token');
writeFileSync(tokenFile, 'msv1.test.token\n', 'utf8');

function fakeFetch(calls: Captured[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ path: url.pathname, body, authorization: (init?.headers as Record<string, string>)?.authorization });
    const json = (value: unknown): Response =>
      new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/v1/recall') {
      return json({
        keywords: ['体检'],
        results: [{ id: 'f_1', title: '体检', kind: 'event', render: { text: '周六去取体检报告' }, path: 'facts', updated_at: new Date().toISOString(), score: 1, stage: 'long' }],
        review: { should_review: true, reminder_since: '2026-10-24T00:00:00Z' },
      });
    }
    if (url.pathname === '/v1/search' || url.pathname === '/v1/recent') return json({ results: [] });
    return json({ ok: true });
  }) as typeof fetch;
}

test('conv keys map to platform scenes', () => {
  assert.equal(sceneForConvKey('group:10001', '10000'), 'qq:group:10001');
  assert.equal(sceneForConvKey('private:10000', '10000'), 'qq:owner');
  assert.equal(sceneForConvKey('private:10002', '10000'), 'qq:private:10002');
  assert.equal(sceneForConvKey('weird', '10000'), 'qq:unknown');
});

test('recall sends the scene + token and appends the review hint', async () => {
  const calls: Captured[] = [];
  const client = createQQMemoryClient({ endpoint: 'http://127.0.0.1:8787', tokenFile, fetchImpl: fakeFetch(calls) });
  const block = await client.recallBlock('group:10001', '10000', [{ role: 'user', text: '体检报告在哪' }]);
  assert.ok(block, 'recall block');
  assert.ok(block.includes('体检报告'));
  assert.ok(block.includes('【记忆回顾】'), 'should_review=true must surface the reminder');

  const call = calls.find((item) => item.path === '/v1/recall');
  assert.ok(call);
  assert.equal(call.authorization, 'Bearer msv1.test.token');
  assert.equal(call.body.scene, 'qq:group:10001');
  assert.equal((call.body.messages as { text: string }[])[0]?.text, '体检报告在哪');
});

test('mirror writes and forgets use the same idempotency key', async () => {
  const calls: Captured[] = [];
  const client = createQQMemoryClient({ endpoint: 'http://127.0.0.1:8787', tokenFile, fetchImpl: fakeFetch(calls) });
  await client.mirrorWrite({ kind: 'qq-topic', text: '周末看展', scene: 'qq:owner', idempotencyKey: 'k1' });
  await client.forget({ idempotencyKey: 'k1' });

  const write = calls.find((item) => item.path === '/v1/write');
  const forget = calls.find((item) => item.path === '/v1/forget');
  assert.ok(write && forget);
  assert.equal(write.body.idempotency_key, 'k1');
  assert.equal(forget.body.idempotency_key, 'k1');
});

test('recall can ask for the owner group scope and write digests', async () => {
  const calls: Captured[] = [];
  const client = createQQMemoryClient({ endpoint: 'http://127.0.0.1:8787', tokenFile, fetchImpl: fakeFetch(calls) });
  await client.recallBlock('private:10000', '10000', [{ role: 'user', text: '今天群聊了什么' }], {
    scope: 'groups',
    sinceHours: 48,
  });
  const recall = calls.find((item) => item.path === '/v1/recall');
  assert.ok(recall);
  assert.equal(recall.body.scope, 'groups');
  assert.equal(recall.body.since_hours, 48);

  calls.length = 0;
  await client.writeFact({ kind: 'note', text: '[群摘要] …', scene: 'qq:group:1', tags: ['digest'], idempotencyKey: 'd1' });
  const write = calls.find((item) => item.path === '/v1/write');
  assert.ok(write);
  assert.deepEqual(write.body.tags, ['digest']);
  assert.equal(write.body.idempotency_key, 'd1');
});

test('search passes stage/expires_at through so QQ can tell short from long', async () => {
  const fake = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname !== '/v1/search') throw new Error(`unexpected ${url.pathname}`);
    return new Response(
      JSON.stringify({
        results: [
          { id: 'f_1', title: '体检', kind: 'event', render: { text: '周六去取体检报告' }, stage: 'long' },
          { id: 'f_2', title: '随口一句', kind: 'chat', render: { text: '今天好困' }, stage: 'short', expires_at: '2026-10-26T00:00:00.000Z' },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  const client = createQQMemoryClient({ endpoint: 'http://127.0.0.1:8787', tokenFile, fetchImpl: fake });
  const items = await client.search('体检', 'qq:owner', 5);
  assert.equal(items.length, 2);
  assert.equal(items[0]?.stage, 'long');
  assert.equal(items[1]?.stage, 'short');
  assert.equal(items[1]?.expires_at, '2026-10-26T00:00:00.000Z');
});

test('a disabled client never calls fetch', async () => {
  const calls: Captured[] = [];
  const client = createQQMemoryClient({ endpoint: 'http://127.0.0.1:8787', tokenFile, enabled: false, fetchImpl: fakeFetch(calls) });
  assert.equal(await client.recallBlock('group:1', '1', [{ role: 'user', text: 'x' }]), null);
  assert.equal(await client.mirrorWrite({ kind: 'qq-topic', text: 'y', scene: 'qq:group:1' }), false);
  assert.equal(calls.length, 0);
});
test('groups recall still runs with no messages (owner asking about the group)', async () => {
  const calls: Captured[] = [];
  const client = createQQMemoryClient({ endpoint: 'http://127.0.0.1:8787', tokenFile, fetchImpl: fakeFetch(calls), recallK: 3 });

  // 消息为空时只有 scope=groups 继续：主人问「群里聊了什么」不该因为
  // 这一轮没有最近消息就拿不到任何群内容。
  const block = await client.recallBlock('private:10000', '10000', [], { scope: 'groups', sinceHours: 24 });
  assert.ok(block && block.includes('相关记忆'), 'groups recall should return a block');
  const recall = calls.filter((item) => item.path === '/v1/recall').at(-1);
  assert.ok(recall, 'groups recall must hit /v1/recall');
  assert.equal(recall.body.scope, 'groups');
  assert.equal(recall.body.since_hours, 24);

  // 普通场景召回没有消息时仍然是 null，且不发请求。
  calls.length = 0;
  assert.equal(await client.recallBlock('private:10000', '10000', []), null);
  assert.equal(calls.filter((item) => item.path === '/v1/recall').length, 0);
});