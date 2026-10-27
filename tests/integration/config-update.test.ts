import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('root token can update shortTerm, privacy, and archive', async () => {
  const response = await post('/v1/config', fixture.tokens.main.token, {
    shortTerm: { ttlHours: 12, reviewIntervalHours: 6 },
    privacy: { sensitiveAudiences: ['main', 'qq:owner', 'wx:owner'], ownerAudiences: ['main', 'wx:owner'] },
    archive: { enabled: true, keepMonths: 6 },
  });
  assert.equal(response.statusCode, 200, JSON.stringify(response.json()));
  assert.deepEqual(response.json().applied.sort(), [
    'archive.enabled',
    'archive.keepMonths',
    'privacy.ownerAudiences',
    'privacy.sensitiveAudiences',
    'shortTerm.ttlHours',
  ]);

  assert.equal(fixture.config.shortTerm.ttlHours, 12);
  assert.deepEqual(fixture.config.privacy.sensitiveAudiences, ['main', 'qq:owner', 'wx:owner']);
  assert.deepEqual(fixture.config.privacy.ownerAudiences, ['main', 'wx:owner']);
  assert.deepEqual(fixture.config.archive, { enabled: true, keepMonths: 6 });

  const file = JSON.parse(readFileSync(fixture.config.configFile, 'utf8')) as {
    shortTerm?: { ttlHours?: number };
    privacy?: { sensitiveAudiences?: string[] };
    archive?: { enabled?: boolean; keepMonths?: number };
  };
  assert.equal(file.shortTerm?.ttlHours, 12);
  assert.deepEqual(file.privacy?.sensitiveAudiences, ['main', 'qq:owner', 'wx:owner']);
  assert.deepEqual(file.archive, { enabled: true, keepMonths: 6 });
});

test('non-root token cannot change config', async () => {
  const response = await post('/v1/config', fixture.tokens.group.token, { shortTerm: { ttlHours: 2 } });
  assert.equal(response.statusCode, 403);
});

test('invalid shortTerm patch is rejected and leaves the file untouched', async () => {
  const before = readFileSync(fixture.config.configFile, 'utf8');
  const response = await post('/v1/config', fixture.tokens.main.token, {
    shortTerm: { ttlHours: 100, maxTtlHours: 10 },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(readFileSync(fixture.config.configFile, 'utf8'), before);
});

test('config-state exposes the new privacy shape', async () => {
  const state = await fixture.built.app.inject({
    method: 'GET',
    url: '/v1/config-state',
    headers: bearer(fixture.tokens.main.token),
  });
  const privacy = state.json().privacy as { sensitiveScope: string; sensitiveAudiences: string[]; ownerAudiences: string[] };
  assert.equal(privacy.sensitiveScope, 'sensitive:read');
  assert.deepEqual(privacy.sensitiveAudiences, ['main', 'qq:owner', 'wx:owner']);
  assert.deepEqual(privacy.ownerAudiences, ['main', 'wx:owner']);
});
