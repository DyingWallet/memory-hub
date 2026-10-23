import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, disposeFixture, type Fixture } from '../helpers/fixture.js';
import type { PrivacyPolicy } from '@memsvc/core';

/**
 * The sensitivity model has exactly one configurable bit: the token scope and
 * the audiences that count as the owner's own. This suite proves a deployment
 * can rename both without touching the source.
 */
const customPolicy: PrivacyPolicy = {
  sensitiveScope: 'private:read',
  sensitiveAudiences: ['main'],
  ownerAudiences: ['main'],
};

let fixture: Fixture;
let customMain: { token: string };

before(async () => {
  fixture = await createFixture({ privacy: customPolicy });
  customMain = fixture.built.tokens.issue({
    name: 'custom-main',
    surface: 'main',
    scopes: ['*', 'private:read'],
    scenes: ['main'],
  });
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

test('a token with the configured scope can write and read sensitive memories', async () => {
  const written = await post('/v1/write', customMain.token, {
    kind: 'note',
    text: '体检报告出来了，医生说没问题。',
    privacy: 'sensitive',
  });
  assert.equal(written.statusCode, 200, JSON.stringify(written.json()));

  const search = await post('/v1/search', customMain.token, { query: '体检报告' });
  assert.ok(search.json().results.length >= 1);
});

test('a token without the configured scope cannot read sensitive memories', async () => {
  const issued = fixture.built.tokens.issue({
    name: 'no-scope',
    surface: 'main',
    scopes: ['*'],
    scenes: ['main'],
  });
  const search = await post('/v1/search', issued.token, { query: '体检报告' });
  assert.equal(search.json().results.length, 0);
});

test('sensitive memories do not appear in the group scene', async () => {
  const search = await post('/v1/search', fixture.tokens.group.token, { query: '体检报告' });
  assert.equal(search.json().results.length, 0);
});

test('a scene outside sensitiveAudiences cannot read it even with the scope', async () => {
  const ownerToken = fixture.built.tokens.issue({
    name: 'owner-custom',
    surface: 'qq:owner',
    scopes: ['qq:owner', 'private:read'],
    scenes: ['qq:owner'],
  });
  const search = await post('/v1/search', ownerToken.token, { query: '体检报告', scene: 'qq:owner' });
  assert.equal(search.json().results.length, 0, 'sensitive is pinned to main in this policy');
});

test('unknown privacy values are rejected on write', async () => {
  const written = await post('/v1/write', fixture.tokens.main.token, {
    kind: 'note',
    text: '随便写的',
    privacy: 'nonsense',
  });
  assert.equal(written.statusCode, 400);
  assert.equal(written.json().error.code, 'invalid_request');
});
