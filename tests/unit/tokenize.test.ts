import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFtsQuery, extractKeywords, isKeywordless, tokenize, tokenizeQuery } from '@memsvc/core';

test('tokenize splits Chinese into bigrams plus unigrams', () => {
  const tokens = tokenize('记忆简报');
  for (const expected of ['记忆', '忆简', '简报', '记', '忆', '简', '报']) {
    assert.ok(tokens.includes(expected), `missing ${expected} in ${tokens.join(',')}`);
  }
});

test('tokenizeQuery keeps bigrams only for runs of two or more', () => {
  assert.deepEqual(tokenizeQuery('记忆简报'), ['记忆', '忆简', '简报']);
  assert.deepEqual(tokenizeQuery('桌宠'), ['桌宠']);
  assert.deepEqual(tokenizeQuery('助手'), ['助手']);
});

test('latin words and digits are lowercased tokens', () => {
  const tokens = tokenizeQuery('QQ 桥接 8787');
  assert.ok(tokens.includes('qq'));
  assert.ok(tokens.includes('8787'));
  assert.ok(tokens.includes('桥接'));
});

test('buildFtsQuery quotes tokens and joins with AND/OR', () => {
  assert.equal(buildFtsQuery(['记忆', '桌宠'], 'and'), '"记忆" AND "桌宠"');
  assert.equal(buildFtsQuery(['记忆', '桌宠'], 'or'), '"记忆" OR "桌宠"');
  assert.equal(buildFtsQuery(['a"b']), '"a""b"');
  assert.equal(buildFtsQuery([]), '');
});

test('extractKeywords drops stopwords and keeps content words', () => {
  const keywords = extractKeywords('上次桌宠接入的事情怎么样了？');
  assert.ok(keywords.includes('桌宠'), keywords.join(','));
  assert.ok(!keywords.includes('的'));
  assert.ok(keywords.length <= 8);
});

test('extractKeywords returns nothing for pure filler', () => {
  assert.equal(isKeywordless('的了呢啊'), true);
  assert.equal(isKeywordless(''), true);
  assert.equal(isKeywordless('桌宠'), false);
});
