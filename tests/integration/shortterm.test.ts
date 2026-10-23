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

test('review lists short-term candidates and persists them as long-term', async () => {
  const review = await post('/v1/review', fixture.tokens.main.token, {});
  const body = review.json();
  assert.equal(body.should_review, true);
  const candidate = (body.results as { id: string; render: { text: string } }[]).find((item) =>
    item.render.text.includes('快递'),
  );
  assert.ok(candidate, JSON.stringify(body));

  const persisted = await post('/v1/persist', fixture.tokens.main.token, { ids: [candidate.id] });
  assert.deepEqual(persisted.json().persisted, [candidate.id]);

  const search = await post('/v1/search', fixture.tokens.main.token, { query: '快递' });
  assert.equal(search.json().results[0].stage, 'long');
  assert.equal(search.json().results[0].expires_at, undefined);

  const afterReview = await post('/v1/review', fixture.tokens.main.token, {});
  assert.equal(afterReview.json().counts.short, 0);
});

test('status_only reports counts without item payload', async () => {
  await post('/v1/ingest', fixture.tokens.main.token, {
    messages: [{ message_id: 'm-2', role: 'user', text: '明天要记得回复邮件' }],
  });
  const review = await post('/v1/review', fixture.tokens.main.token, { status_only: true });
  assert.equal(review.json().should_review, false, 'just reviewed, so not due yet');
  assert.ok(review.json().counts.short >= 1);
  assert.deepEqual(review.json().results, []);
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
  const first = before.json().results[0] as { id: string; expires_at: string };

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

test('persisting a duplicate short memory folds it into the existing long fact', async () => {
  const text = '周六去美术馆看展';
  await post('/v1/ingest', fixture.tokens.main.token, {
    messages: [{ message_id: 'fold-1', role: 'user', text }],
  });
  const firstReview = await post('/v1/review', fixture.tokens.main.token, {});
  const first = (firstReview.json().results as { id: string; render: { text: string } }[]).find((item) =>
    item.render.text.includes('美术馆'),
  );
  assert.ok(first);
  const firstPersist = await post('/v1/persist', fixture.tokens.main.token, { ids: [first.id] });
  assert.deepEqual(firstPersist.json().persisted, [first.id]);

  await post('/v1/ingest', fixture.tokens.main.token, {
    messages: [{ message_id: 'fold-2', role: 'user', text: `  ${text} ` }],
  });
  const secondReview = await post('/v1/review', fixture.tokens.main.token, {});
  const second = (secondReview.json().results as { id: string; render: { text: string } }[]).find((item) =>
    item.render.text.includes('美术馆'),
  );
  assert.ok(second);
  assert.notEqual(second.id, first.id);

  const secondPersist = await post('/v1/persist', fixture.tokens.main.token, { ids: [second.id] });
  assert.deepEqual(secondPersist.json().persisted, []);
  assert.deepEqual(secondPersist.json().merged, [{ from: second.id, into: first.id }]);

  const search = await post('/v1/search', fixture.tokens.main.token, { query: '美术馆' });
  const hits = (search.json().results as { id: string; stage: string }[]).filter((hit) => hit.stage === 'long');
  assert.equal(hits.length, 1, JSON.stringify(search.json().results));
  const only = hits[0];
  assert.ok(only);
  assert.equal(only.id, first.id);
});
