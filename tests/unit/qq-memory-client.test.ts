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

test('a disabled client never calls fetch', async () => {
  const calls: Captured[] = [];
  const client = createQQMemoryClient({ endpoint: 'http://127.0.0.1:8787', tokenFile, enabled: false, fetchImpl: fakeFetch(calls) });
  assert.equal(await client.recallBlock('group:1', '1', [{ role: 'user', text: 'x' }]), null);
  assert.equal(await client.mirrorWrite({ kind: 'qq-topic', text: 'y', scene: 'qq:group:1' }), false);
  assert.equal(calls.length, 0);
});
