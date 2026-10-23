import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asStringArray, parseFrontMatter } from '@memsvc/core';

test('parses inline arrays and scalars', () => {
  const { data, body, present } = parseFrontMatter(`---\ndate: 2026-10-23\nkind: decision\ntags: [memory, privacy]\naudience: [shared]\n---\n\n# 标题\n正文\n`);
  assert.equal(present, true);
  assert.equal(data.date, '2026-10-23');
  assert.equal(data.kind, 'decision');
  assert.deepEqual(data.tags, ['memory', 'privacy']);
  assert.deepEqual(data.audience, ['shared']);
  assert.ok(body.startsWith('# 标题'));
});

test('parses dash lists', () => {
  const { data } = parseFrontMatter(`---\nboundaries:\n  - 工作\n  - 股票\n---\nx\n`);
  assert.deepEqual(data.boundaries, ['工作', '股票']);
});

test('handles files without front matter', () => {
  const { data, body, present } = parseFrontMatter('# 只有正文\n');
  assert.equal(present, false);
  assert.deepEqual(data, {});
  assert.equal(body, '# 只有正文\n');
});

test('strips quotes and keeps empty lists', () => {
  const { data } = parseFrontMatter(`---\nname: "朋友群"\nempty: []\n---\n`);
  assert.equal(data.name, '朋友群');
  assert.deepEqual(data.empty, []);
});

test('asStringArray accepts comma strings', () => {
  assert.deepEqual(asStringArray('shared, main'), ['shared', 'main']);
  assert.equal(asStringArray(''), undefined);
});
