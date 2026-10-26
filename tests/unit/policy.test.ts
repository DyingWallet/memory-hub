import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  audienceForWrite,
  canRead,
  canWriteAudience,
  DEFAULT_POLICY,
  defaultAudience,
  defaultPrivacy,
  normalizeAudience,
  type MemoryView,
  type PrivacyPolicy,
  type TokenView,
} from '@memsvc/core';

const groupToken: TokenView = {
  surface: 'qq:group:10001',
  scopes: ['qq:group:10001'],
  scenes: ['qq:group:10001'],
};
const ownerToken: TokenView = { surface: 'qq:owner', scopes: ['*', 'sensitive:read'], scenes: ['qq:owner'] };
const mainToken: TokenView = { surface: 'main', scopes: ['*', 'sensitive:read'], scenes: ['main'] };
const mainNoSensitive: TokenView = { surface: 'main', scopes: ['*'], scenes: ['main'] };

function memory(overrides: Partial<MemoryView> = {}): MemoryView {
  return { kind: 'note', privacy: 'normal', audience: ['main'], ...overrides };
}

test('default audiences follow the kind', () => {
  assert.deepEqual(defaultAudience('identity'), ['shared']);
  assert.deepEqual(defaultAudience('journal'), ['main']);
  assert.deepEqual(defaultAudience('decision'), ['main']);
  assert.deepEqual(defaultAudience('knowledge'), ['main']);
  assert.deepEqual(defaultAudience('qq-topic', 'qq:group:1'), ['qq:group:1']);
  assert.deepEqual(defaultAudience('qq-topic'), ['main']);
  assert.deepEqual(defaultAudience('note'), ['main']);
});

test('normalizeAudience never widens what was given', () => {
  assert.deepEqual(normalizeAudience([], 'identity'), ['shared']);
  assert.deepEqual(normalizeAudience(['qq:group:1'], 'identity'), ['qq:group:1']);
  assert.deepEqual(normalizeAudience(['shared', 'shared'], 'note'), ['shared']);
});

test('default privacy: work source becomes sensitive', () => {
  assert.equal(defaultPrivacy('qq-impression'), 'personal');
  assert.equal(defaultPrivacy('note'), 'normal');
  assert.equal(defaultPrivacy('event', 'work'), 'sensitive');
});

test('root tokens read everything including secret', () => {
  assert.equal(canRead(memory({ audience: ['main'] }), mainToken, 'main'), true);
  assert.equal(canRead(memory({ privacy: 'sensitive', audience: ['main', 'qq:owner'] }), mainToken, 'main'), true);
  assert.equal(canRead(memory({ privacy: 'secret', audience: ['main'] }), mainToken, 'main'), true);
});

test('sensitive needs the scope even for root tokens', () => {
  const sensitive = memory({ privacy: 'sensitive', audience: ['main'] });
  assert.equal(canRead(sensitive, mainNoSensitive, 'main'), false);
  assert.equal(canRead(sensitive, mainToken, 'main'), true);
});

test('group tokens read shared and their own scope only', () => {
  assert.equal(canRead(memory({ audience: ['shared'] }), groupToken, groupToken.surface), true);
  assert.equal(canRead(memory({ audience: ['qq:group:10001'] }), groupToken, groupToken.surface), true);
  assert.equal(canRead(memory({ audience: ['main'] }), groupToken, groupToken.surface), false);
  assert.equal(canRead(memory({ audience: ['qq:group:999'] }), groupToken, groupToken.surface), false);
});

test('sensitive memories stay on owner surfaces even for scoped tokens', () => {
  const sensitive = memory({ privacy: 'sensitive', audience: ['main', 'qq:owner'] });
  assert.equal(canRead(sensitive, ownerToken, 'qq:owner'), true);
  assert.equal(canRead(sensitive, groupToken, 'qq:group:10001'), false);
  const sensitiveGroupToken: TokenView = { ...groupToken, scopes: ['qq:group:10001', 'sensitive:read'] };
  assert.equal(canRead(sensitive, sensitiveGroupToken, 'qq:group:10001'), false);
});

test('a token cannot read outside its allowed scenes', () => {
  assert.equal(canRead(memory({ audience: ['shared'] }), groupToken, 'qq:owner'), false);
});

test('write audience pins sensitive material to owner surfaces', () => {
  assert.deepEqual(audienceForWrite(undefined, 'note', 'sensitive', 'qq:group:1'), ['main', 'qq:owner']);
  assert.deepEqual(audienceForWrite(['main', 'qq:owner'], 'note', 'sensitive', 'main'), ['main', 'qq:owner']);
  assert.deepEqual(audienceForWrite(undefined, 'note', 'normal', 'qq:group:1'), ['qq:group:1']);
});

test('custom sensitive/owner audiences are honored', () => {
  const policy: PrivacyPolicy = {
    sensitiveScope: 'sensitive:read',
    sensitiveAudiences: ['main', 'wx:owner'],
    secretAudiences: ['main'],
    ownerAudiences: ['main', 'wx:owner'],
  };
  const wxOwner: TokenView = { surface: 'wx:owner', scopes: ['*', 'sensitive:read'], scenes: ['wx:owner'] };
  const sensitive = memory({ privacy: 'sensitive', audience: ['main', 'wx:owner'] });
  assert.equal(canRead(sensitive, wxOwner, 'wx:owner', policy), true);
  assert.deepEqual(audienceForWrite(undefined, 'note', 'sensitive', 'wx:owner', policy), ['wx:owner']);
});

test('non-root tokens can only write what they can read', () => {
  assert.equal(canWriteAudience(groupToken, ['qq:group:10001']), true);
  assert.equal(canWriteAudience(groupToken, ['main']), false);
  assert.equal(canWriteAudience(groupToken, ['shared']), true);
  assert.equal(canWriteAudience(mainToken, ['main']), true);
});

test('legacy work labels are treated as sensitive (fail closed)', () => {
  const legacy = memory({ privacy: 'work', audience: ['main'] });
  assert.equal(canRead(legacy, mainNoSensitive, 'main'), false);
  assert.equal(canRead(legacy, mainToken, 'main'), true);
});
