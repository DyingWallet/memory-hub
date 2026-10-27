import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFixture, disposeFixture, GROUP_ID, type Fixture } from '../helpers/fixture.js';

let fixture: Fixture;

before(async () => {
  fixture = await createFixture();
});

after(async () => {
  await disposeFixture(fixture);
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function post(path: string, token: string | null, payload: unknown) {
  return fixture.built.app.inject({
    method: 'POST',
    url: path,
    payload: payload as Record<string, unknown>,
    headers: token ? bearer(token) : {},
  });
}

test('health is public and reports index statistics', async () => {
  const response = await fixture.built.app.inject({ method: 'GET', url: '/v1/health' });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.ok, true);
  assert.equal(body.version, '0.1.0');
  assert.ok(body.index.docs >= 2, JSON.stringify(body.index));
  assert.equal(body.index.facts, 5);
  assert.ok(body.index.chunks >= 5);
  assert.match(response.headers['x-request-id'] as string, /.+/);
});

test('capabilities needs a token and advertises v1 limits', async () => {
  const anonymous = await fixture.built.app.inject({ method: 'GET', url: '/v1/capabilities' });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.json().error.code, 'unauthorized');

  const response = await fixture.built.app.inject({
    method: 'GET',
    url: '/v1/capabilities',
    headers: bearer(fixture.tokens.main.token),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.protocol, 'v1');
  assert.deepEqual(body.features, { images: false, documents: false, semantic: false, offline: false, short_term: true });
  assert.equal(body.limits.search_default_k, 5);
  assert.equal(body.limits.search_max_k, 10);
  assert.ok(body.tools.includes('memory_search'));
});

test('config-schema is served for the settings page', async () => {
  const response = await fixture.built.app.inject({
    method: 'GET',
    url: '/v1/config-schema',
    headers: bearer(fixture.tokens.main.token),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.schema.type, 'object');
  assert.ok(body.schema.properties.endpoint);
});

test('bootstrap returns identity, audience face, recent titles, counts', async () => {
  const response = await post('/v1/bootstrap', fixture.tokens.main.token, { scene: 'main' });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.match(body.identity, /助手/);
  assert.equal(body.audience.id, 'main');
  assert.ok(Array.isArray(body.recent));
  assert.ok(body.recent.length > 0);
  assert.equal(body.counts.facts, 5);
  assert.match(body.instructions, /memory_search/);
});

test('bootstrap for the group uses its audience card', async () => {
  const response = await post('/v1/bootstrap', fixture.tokens.group.token, {});
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.audience.id, `qq:group:${GROUP_ID}`);
  assert.match(body.audience.face, /群友/);
});

test('search finds Chinese two-character queries', async () => {
  const response = await post('/v1/search', fixture.tokens.main.token, { query: '桌宠', k: 5 });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.ok(body.results.length >= 1, JSON.stringify(body));
  // The word may only appear in the H1 title, so assert on title + text together.
  assert.match(`${body.results[0].title}\n${body.results[0].render.text}`, /桌宠/);
  assert.equal(body.results[0].render.type, 'text');
});

test('search matches a longer phrase via bigrams', async () => {
  const response = await post('/v1/search', fixture.tokens.main.token, { query: '记忆简报' });
  assert.equal(response.statusCode, 200);
  assert.ok(response.json().results.length >= 1);
});

test('get returns the chunk behind a search hit', async () => {
  const search = await post('/v1/search', fixture.tokens.main.token, { query: '桌宠' });
  const id = search.json().results[0].id as string;
  const response = await post('/v1/get', fixture.tokens.main.token, { id });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().memory.id, id);
});

test('get on an unknown id is a stable 404', async () => {
  const response = await post('/v1/get', fixture.tokens.main.token, { id: 'doc:nope.md' });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, 'not_found');
});

test('recent lists newest visible memories', async () => {
  const response = await post('/v1/recent', fixture.tokens.main.token, { k: 3 });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.ok(body.results.length > 0 && body.results.length <= 3);
});

test('recall extracts keywords from the last messages', async () => {
  const response = await post('/v1/recall', fixture.tokens.main.token, {
    messages: [{ role: 'user', text: '上次桌宠接入那事怎么样了？' }],
    k: 3,
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.ok(body.keywords.length > 0, JSON.stringify(body));
  assert.ok(body.results.length >= 1);
});

test('QQ group write is appended to JSONL and becomes searchable in that scene', async () => {
  const before = readFileSync(join(fixture.factsDir, '2026-10.jsonl'), 'utf8').split('\n').filter(Boolean).length;
  const response = await post('/v1/write', fixture.tokens.group.token, {
    kind: 'qq-topic',
    text: '群里决定周六去看樱花。',
    scene: `qq:group:${GROUP_ID}`,
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.match(body.id, /^fact-qq-group-/);

  const after = readFileSync(join(fixture.factsDir, '2026-10.jsonl'), 'utf8').split('\n').filter(Boolean).length;
  assert.equal(after, before + 1);

  const search = await post('/v1/search', fixture.tokens.group.token, { query: '樱花' });
  assert.ok(search.json().results.length >= 1);
});

test('group token cannot write sensitive or secret material', async () => {
  const work = await post('/v1/write', fixture.tokens.group.token, {
    kind: 'note',
    text: '工资 1280',
    privacy: 'sensitive',
    audience: ['main', 'qq:owner'],
  });
  assert.equal(work.statusCode, 403);
  assert.equal(work.json().error.code, 'forbidden');

  const secret = await post('/v1/write', fixture.tokens.group.token, { kind: 'note', text: 'x', privacy: 'secret' });
  assert.equal(secret.statusCode, 403);
});

test('idempotency_key makes retries safe', async () => {
  const payload = { kind: 'note', text: '幂等测试写入。', scene: 'main', idempotency_key: 'test-idem-1' };
  const first = await post('/v1/write', fixture.tokens.main.token, payload);
  const second = await post('/v1/write', fixture.tokens.main.token, payload);
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(first.json().id, second.json().id);
  assert.equal(second.json().duplicate, true);
});

test('validation errors use the documented envelope', async () => {
  const response = await post('/v1/search', fixture.tokens.main.token, { k: 3 });
  assert.equal(response.statusCode, 400);
  const body = response.json();
  assert.equal(body.error.code, 'invalid_request');
  assert.ok(body.error.requestId);
});

test('unknown route is a JSON 404', async () => {
  const response = await fixture.built.app.inject({ method: 'GET', url: '/v1/nope' });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, 'not_found');
});

test('revoked token stops working', async () => {
  const issued = fixture.built.tokens.issue({ name: 'temp', surface: 'main', scopes: ['*'] });
  const before = await fixture.built.app.inject({
    method: 'GET',
    url: '/v1/capabilities',
    headers: bearer(issued.token),
  });
  assert.equal(before.statusCode, 200);
  fixture.built.tokens.revoke(issued.record.id);
  const afterwards = await fixture.built.app.inject({
    method: 'GET',
    url: '/v1/capabilities',
    headers: bearer(issued.token),
  });
  assert.equal(afterwards.statusCode, 401);
});

test('audit log records ids and hashes but no body text', async () => {
  const log = readFileSync(fixture.config.auditFile, 'utf8');
  assert.ok(log.split('\n').filter(Boolean).length > 0);
  assert.ok(!log.includes('樱花'));
  assert.ok(log.includes('query_hash'));
});

test('writing the same fact twice reuses the existing id', async () => {
  const payload = {
    kind: 'note',
    text: '  重复的事实   只写一次 ',
    audience: ['main'],
    privacy: 'normal',
    tags: ['dedupe'],
  };
  const first = await post('/v1/write', fixture.tokens.main.token, payload);
  assert.equal(first.statusCode, 200, JSON.stringify(first.json()));
  assert.equal(first.json().duplicate, false);

  const second = await post('/v1/write', fixture.tokens.main.token, payload);
  assert.equal(second.statusCode, 200, JSON.stringify(second.json()));
  assert.equal(second.json().duplicate, true);
  assert.equal(second.json().id, first.json().id, 'same content, same id');
});

test('the same text in a different audience stays a separate fact', async () => {
  const text = '同文不同 audience';
  const main = await post('/v1/write', fixture.tokens.main.token, { kind: 'note', text, audience: ['main'] });
  const owner = await post('/v1/write', fixture.tokens.owner.token, {
    kind: 'note',
    text,
    audience: ['qq:owner'],
    scene: 'qq:owner',
  });
  assert.notEqual(main.json().id, owner.json().id);
});
