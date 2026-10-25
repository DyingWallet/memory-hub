import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendFact, reindexAll } from '@memsvc/server/indexer';
import { createFixture, disposeFixture, type Fixture } from '../helpers/fixture.js';

let fixture: Fixture;

before(async () => {
  fixture = await createFixture();
});

after(async () => {
  await disposeFixture(fixture);
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

test('persist writes a long row into JSONL so an index rebuild keeps it', async () => {
  const id = 'chat:main:persist-jsonl';
  appendFact(fixture.built.db, fixture.config, {
    schema_version: 1,
    id,
    ts: new Date().toISOString(),
    kind: 'chat',
    text: '测试：持久化之后应该能在 JSONL 里看到 long 标记',
    audience: ['main'],
    privacy: 'normal',
    source: 'main',
    scene: 'main',
    stage: 'short',
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    recall_count: 0,
  } as never);

  const res = await fixture.built.app.inject({
    method: 'POST',
    url: '/v1/persist',
    payload: { ids: [id] },
    headers: bearer(fixture.tokens.main.token),
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().persisted, [id]);

  const rows = readFileSync(join(fixture.factsDir, '2026-10.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const longRow = rows.find((row) => row.id === id && row.stage === 'long');
  assert.ok(longRow, 'JSONL 里应该有一行 stage=long');
  assert.equal(longRow.expires_at, undefined, 'long 行不携带过期时间');
  assert.ok(longRow.persisted_at, 'long 行要记下 persisted_at');

  // 模拟「从备份恢复」：备份不含 index.db，索引只能由 memories/ 重建。
  reindexAll(fixture.built.db, fixture.config, { force: true });
  const rebuilt = fixture.built.db.prepare('SELECT stage, expires_at FROM docs WHERE id = ?').get(id) as
    | { stage?: string; expires_at?: number | null }
    | undefined;
  assert.equal(rebuilt?.stage, 'long', '重建后仍然是长期记忆');
  assert.equal(rebuilt?.expires_at ?? null, null);
});

test('persisting an already-long memory does not append a duplicate row', async () => {
  const id = 'chat:main:persist-twice';
  appendFact(fixture.built.db, fixture.config, {
    schema_version: 1,
    id,
    ts: new Date().toISOString(),
    kind: 'chat',
    text: '测试：同一条只应该写一行 long',
    audience: ['main'],
    privacy: 'normal',
    source: 'main',
    scene: 'main',
    stage: 'short',
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    recall_count: 0,
  } as never);

  const once = await fixture.built.app.inject({
    method: 'POST',
    url: '/v1/persist',
    payload: { ids: [id] },
    headers: bearer(fixture.tokens.main.token),
  });
  assert.equal(once.statusCode, 200);
  const twice = await fixture.built.app.inject({
    method: 'POST',
    url: '/v1/persist',
    payload: { ids: [id] },
    headers: bearer(fixture.tokens.main.token),
  });
  assert.equal(twice.statusCode, 200);

  const rows = readFileSync(join(fixture.factsDir, '2026-10.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row.id === id && row.stage === 'long');
  assert.equal(rows.length, 1, '第二次 persist 时索引已经是 long，不应再写一行');
});
