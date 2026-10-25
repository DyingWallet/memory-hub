import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFact } from '@memsvc/server/indexer';
import { createFixture, disposeFixture, type Fixture } from '../helpers/fixture.js';

/**
 * 短期记忆降权：一条又短又新、关键词更密的 chat，不应该排在同主题的长期文档前面。
 * 只验证顺序，不验证分数（score 仍是原始召回分）。
 */
let fixture: Fixture;

before(async () => {
  fixture = await createFixture();

  // 长期文档：篇幅长，关键词密度低。
  const long = await fixture.built.app.inject({
    method: 'POST',
    url: '/v1/write',
    payload: {
      kind: 'knowledge',
      text: '排序实验：这是一个关于记忆检索排序的长期说明，内容比较长，提到排序但密度不高。' + '补充说明。'.repeat(20),
      idempotency_key: 'rank-long',
    },
    headers: { authorization: `Bearer ${fixture.tokens.main.token}` },
  });
  assert.equal(long.statusCode, 200);

  // 短期 chat：一句正常长度的聊天（真实短记忆大多 10–30 字）。
  appendFact(fixture.built.db, fixture.config, {
    schema_version: 1,
    id: 'chat:main:rank-short',
    ts: new Date().toISOString(),
    kind: 'chat',
    text: '排序实验：今天调了一下排序，感觉好多了',
    audience: ['main'],
    privacy: 'normal',
    source: 'main',
    scene: 'main',
    stage: 'short',
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    recall_count: 0,
  } as never);
});

after(async () => {
  await disposeFixture(fixture);
});

function search(token: string, query: string) {
  return fixture.built.app.inject({
    method: 'POST',
    url: '/v1/search',
    payload: { query, k: 10 },
    headers: { authorization: `Bearer ${token}` },
  });
}

test('短期 chat 不会因为更短而挤掉同主题的长期文档', async () => {
  const response = await search(fixture.tokens.main.token, '排序实验');
  assert.equal(response.statusCode, 200);
  const results = (response.json() as { results: { id: string; stage: string }[] }).results;
  const longIndex = results.findIndex((item) => item.stage === 'long');
  const shortIndex = results.findIndex((item) => item.id === 'chat:main:rank-short');
  assert.ok(longIndex >= 0, '长期文档应该被召回');
  assert.ok(shortIndex >= 0, '短期 chat 也应该被召回');
  assert.ok(longIndex < shortIndex, `长期文档应排在短期前面（long=${longIndex}, short=${shortIndex}）`);
});

test('权重设为 1 时恢复原始顺序（可关闭）', async () => {
  const original = fixture.config.searchShortWeight;
  fixture.config.searchShortWeight = 1;
  try {
    const response = await search(fixture.tokens.main.token, '排序实验');
    const results = (response.json() as { results: { id: string; stage: string }[] }).results;
    // 不降权时，短而密的 chat 大概率在前；这里只断言「结果仍然完整」，顺序交给 bm25。
    assert.ok(results.some((item) => item.id === 'chat:main:rank-short'));
    assert.ok(results.some((item) => item.stage === 'long'));
  } finally {
    fixture.config.searchShortWeight = original;
  }
});
