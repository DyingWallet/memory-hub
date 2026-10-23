import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reindexAll } from '@memsvc/server/indexer';
import { createFixture, disposeFixture, type Fixture } from '../helpers/fixture.js';

let fixture: Fixture;

before(async () => {
  fixture = await createFixture();
});

after(async () => {
  await disposeFixture(fixture);
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function post(path: string, token: string, payload: unknown) {
  return fixture.built.app.inject({ method: 'POST', url: path, payload: payload as Record<string, unknown>, headers: bearer(token) });
}

test('forget by idempotency key removes the fact and survives reindex', async () => {
  const written = await post('/v1/write', fixture.tokens.main.token, {
    kind: 'note',
    text: '测试：可以被忘记的一条事实',
    idempotency_key: 'forget-test-1',
  });
  assert.equal(written.statusCode, 200);
  const id = written.json().id as string;

  const before = await post('/v1/search', fixture.tokens.main.token, { query: '可以被忘记' });
  assert.ok(before.json().results.some((hit: { id: string }) => hit.id === id));

  const forgotten = await post('/v1/forget', fixture.tokens.main.token, { idempotency_key: 'forget-test-1' });
  assert.deepEqual(forgotten.json().forgotten, [id]);

  const after = await post('/v1/search', fixture.tokens.main.token, { query: '可以被忘记' });
  assert.equal(after.json().results.some((hit: { id: string }) => hit.id === id), false);

  // A reindex must not resurrect the fact: the JSONL tombstone keeps it deleted.
  reindexAll(fixture.built.db, fixture.config);
  const reindexed = await post('/v1/search', fixture.tokens.main.token, { query: '可以被忘记' });
  assert.equal(reindexed.json().results.some((hit: { id: string }) => hit.id === id), false);

  const factsFile = join(fixture.factsDir, '2026-10.jsonl');
  assert.match(readFileSync(factsFile, 'utf8'), /"deleted":true/);
});

test('forget is scene-scoped: a group token cannot forget an owner fact', async () => {
  const ownerFact = await post('/v1/write', fixture.tokens.owner.token, {
    kind: 'note',
    text: '测试：owner 的场景事实',
    idempotency_key: 'forget-test-owner',
  });
  const id = ownerFact.json().id as string;

  const denied = await post('/v1/forget', fixture.tokens.group.token, { id });
  assert.equal(denied.statusCode, 403);
});

test('forget returns missing for unknown ids', async () => {
  const result = await post('/v1/forget', fixture.tokens.main.token, { id: 'does-not-exist' });
  assert.deepEqual(result.json(), { forgotten: [], missing: ['does-not-exist'] });
});
