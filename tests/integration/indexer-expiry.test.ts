import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFact, reindexAll } from '@memsvc/server/indexer';
import { purgeExpired } from '@memsvc/server/db';
import { createFixture, disposeFixture, type Fixture } from '../helpers/fixture.js';

let fixture: Fixture;

before(async () => {
  fixture = await createFixture();
});

after(async () => {
  await disposeFixture(fixture);
});

const PAST = () => new Date(Date.now() - 3_600_000).toISOString();
const FUTURE = () => new Date(Date.now() + 3_600_000).toISOString();

/** 一条短期 chat 事实；默认已过期。 */
function shortFact(id: string, expiresAt = PAST()): Record<string, unknown> {
  return {
    schema_version: 1,
    id,
    ts: new Date().toISOString(),
    kind: 'chat',
    text: `测试：${id}`,
    audience: ['main'],
    privacy: 'normal',
    source: 'main',
    scene: 'main',
    stage: 'short',
    expires_at: expiresAt,
    recall_count: 0,
  };
}

const has = (id: string): boolean =>
  Boolean(fixture.built.db.prepare('SELECT 1 FROM docs WHERE id = ?').get(id));

test('purged expired short-term memories do not come back on reindex', () => {
  const id = 'chat:main:expiry-purged';
  appendFact(fixture.built.db, fixture.config, shortFact(id) as never);
  assert.equal(has(id), true, 'appendFact indexes the record directly');

  purgeExpired(fixture.built.db);
  assert.equal(has(id), false, 'purge removes it');

  // 这是本次修复的核心：watch 触发的 reindex 会把 JSONL 里的过期记录重新插回来。
  reindexAll(fixture.built.db, fixture.config);
  assert.equal(has(id), false, 'reindex must not resurrect an expired short-term memory');
});

test('a short fact persisted to long survives reindex after its TTL passed', () => {
  const id = 'chat:main:expiry-persisted';
  appendFact(fixture.built.db, fixture.config, shortFact(id) as never);

  // persist 的效果：索引里变 long、expires_at 清空；JSONL 里仍留着 short + 原过期时间。
  fixture.built.db.prepare("UPDATE docs SET stage='long', expires_at=NULL WHERE id=?").run(id);
  fixture.built.db.prepare("UPDATE chunks SET stage='long', expires_at=NULL WHERE doc_id=?").run(id);

  reindexAll(fixture.built.db, fixture.config);
  const row = fixture.built.db.prepare('SELECT stage FROM docs WHERE id=?').get(id) as
    | { stage?: string }
    | undefined;
  assert.equal(row?.stage, 'long', 'persisted memory must not be cleaned up as stale');
});

test('a live short fact is still indexed and survives purge', () => {
  const id = 'chat:main:expiry-live';
  appendFact(fixture.built.db, fixture.config, shortFact(id, FUTURE()) as never);

  purgeExpired(fixture.built.db);
  reindexAll(fixture.built.db, fixture.config);
  assert.equal(has(id), true);
});
