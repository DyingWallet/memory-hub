import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { purgeExpired } from '@memsvc/server/db';
import { createFixture, disposeFixture, type Fixture } from '../helpers/fixture.js';

let fixture: Fixture;

before(async () => {
  fixture = await createFixture();
});

after(async () => {
  await disposeFixture(fixture);
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function post(path: string, token: string, payload: unknown) {
  return fixture.built.app.inject({
    method: 'POST',
    url: path,
    payload: payload as Record<string, unknown>,
    headers: bearer(token),
  });
}

test('ordinary chat is ingested as short-term memory and can be recalled', async () => {
  const ingested = await post('/v1/ingest', fixture.tokens.main.token, {
    messages: [{ message_id: 'm-1', role: 'user', text: '我今天去取了快递，放在门口' }],
  });
  assert.equal(ingested.statusCode, 200, JSON.stringify(ingested.json()));
  assert.equal(ingested.json().written, 1);

  const search = await post('/v1/search', fixture.tokens.main.token, { query: '快递' });
  const hit = search.json().results[0] as { id: string; stage: string; expires_at?: string };
  assert.ok(hit, JSON.stringify(search.json()));
  assert.equal(hit.stage, 'short');
  assert.ok(hit.expires_at, 'short memories carry an expiry');
});

test('expired short-term memories disappear from search and are purged', async () => {
  const past = new Date(Date.now() - 3_600_000).toISOString();
  const written = await post('/v1/write', fixture.tokens.main.token, {
    kind: 'chat',
    text: '这条短期记忆已经过期',
    stage: 'short',
    expires_at: past,
  });
  assert.equal(written.statusCode, 200);

  const search = await post('/v1/search', fixture.tokens.main.token, { query: '已经过期' });
  assert.equal(search.json().results.length, 0);

  const dropped = purgeExpired(fixture.built.db);
  assert.ok(dropped >= 1);
  const row = fixture.built.db.prepare('SELECT 1 FROM docs WHERE id = ?').get(written.json().id);
  assert.equal(row, undefined);
});

test('recall extends the TTL of a short-term memory (spacing effect)', async () => {
  await post('/v1/ingest', fixture.tokens.main.token, {
    messages: [{ message_id: 'm-3', role: 'user', text: '周末去看樱花' }],
    ttl_hours: 0.2,
  });
  const before = await post('/v1/search', fixture.tokens.main.token, { query: '樱花' });
  // 不能用 results[0]：短期记忆被降权后，同词的长期记忆（fixture 里的群话题）可能排在前面。
  const results = before.json().results as { id: string; expires_at: string; stage: string; render: { text: string } }[];
  const first = results.find((item) => item.stage === 'short' && item.render.text.includes('樱花'));
  assert.ok(first, '刚写入的短期记忆应该被召回');

  await post('/v1/recall', fixture.tokens.main.token, {
    messages: [{ role: 'user', text: '樱花那事还去吗' }],
    k: 3,
  });

  const after = await post('/v1/get', fixture.tokens.main.token, { id: first.id });
  const updated = after.json().memory as { expires_at?: string };
  assert.ok(updated.expires_at);
  assert.ok(
    Date.parse(updated.expires_at) > Date.parse(first.expires_at),
    `expected extended expiry: ${first.expires_at} -> ${updated.expires_at}`,
  );
});

test('group-scoped short-term chat stays inside the group', async () => {
  await post('/v1/ingest', fixture.tokens.group.token, {
    messages: [{ message_id: 'g-1', role: 'user', text: '群里约了周六打球' }],
  });
  const inGroup = await post('/v1/search', fixture.tokens.group.token, { query: '打球' });
  assert.ok(inGroup.json().results.length >= 1);

  const privateB = await post('/v1/search', fixture.tokens.privateB.token, { query: '打球' });
  assert.equal(privateB.json().results.length, 0);
});

