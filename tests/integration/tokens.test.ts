import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, disposeFixture, type Fixture } from '../helpers/fixture.js';

let fixture: Fixture;

before(async () => {
  fixture = await createFixture();
});

after(async () => {
  await disposeFixture(fixture);
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

test('root can list token metadata without hashes', async () => {
  const response = await fixture.built.app.inject({
    method: 'GET',
    url: '/v1/tokens',
    headers: bearer(fixture.tokens.main.token),
  });
  assert.equal(response.statusCode, 200, JSON.stringify(response.json()));
  const tokens = response.json().tokens as Record<string, unknown>[];
  assert.ok(tokens.length >= 5);
  assert.equal(tokens.some((token) => 'hash' in token), false);
  const group = tokens.find((token) => token.name === 'qq-group');
  assert.deepEqual(group?.scopes, [`qq:group:10001`]);
});

test('non-root token cannot list or revoke tokens', async () => {
  const list = await fixture.built.app.inject({
    method: 'GET',
    url: '/v1/tokens',
    headers: bearer(fixture.tokens.group.token),
  });
  assert.equal(list.statusCode, 403);

  const revoke = await fixture.built.app.inject({
    method: 'POST',
    url: '/v1/tokens/revoke',
    payload: { id: fixture.tokens.privateB.record.id },
    headers: bearer(fixture.tokens.group.token),
  });
  assert.equal(revoke.statusCode, 403);
});

test('revoking a token stops it from authenticating', async () => {
  const issued = fixture.built.tokens.issue({ name: 'temp-revoke', surface: 'main', scopes: ['*'], scenes: ['main'] });
  const ok = await fixture.built.app.inject({
    method: 'GET',
    url: '/v1/tokens',
    headers: bearer(issued.token),
  });
  assert.equal(ok.statusCode, 200);

  const revoke = await fixture.built.app.inject({
    method: 'POST',
    url: '/v1/tokens/revoke',
    payload: { id: issued.record.id },
    headers: bearer(fixture.tokens.main.token),
  });
  assert.equal(revoke.statusCode, 200, JSON.stringify(revoke.json()));

  const denied = await fixture.built.app.inject({
    method: 'GET',
    url: '/v1/tokens',
    headers: bearer(issued.token),
  });
  assert.equal(denied.statusCode, 401);
});

test('revoking an unknown id is a 404', async () => {
  const response = await fixture.built.app.inject({
    method: 'POST',
    url: '/v1/tokens/revoke',
    payload: { id: 'tok_missing' },
    headers: bearer(fixture.tokens.main.token),
  });
  assert.equal(response.statusCode, 404);
});
