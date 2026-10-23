import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { archiveOldFacts } from '@memsvc/server/archive';
import { forgetFact, reindexAll } from '@memsvc/server/indexer';
import { createFixture, disposeFixture, type Fixture } from '../helpers/fixture.js';

let fixture: Fixture;

before(async () => {
  fixture = await createFixture();
});

after(async () => {
  await disposeFixture(fixture);
});

test('facts in archived months stay indexed and can still be forgotten', () => {
  const factsDir = fixture.config.factsDir;
  mkdirSync(factsDir, { recursive: true });
  const record = {
    schema_version: 1,
    id: 'f_archived_1',
    ts: '2026-09-10T00:00:00.000Z',
    kind: 'note',
    text: '九月的一条旧事实',
    audience: ['main'],
    privacy: 'normal',
    source: 'main',
    scene: 'main',
  };
  writeFileSync(join(factsDir, '2026-09.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');

  const result = archiveOldFacts(factsDir, Date.parse('2026-10-15T00:00:00Z'));
  assert.deepEqual(result.archived, ['2026-09.jsonl']);
  reindexAll(fixture.built.db, fixture.config, { force: true });

  const doc = fixture.built.db.prepare('SELECT path FROM docs WHERE id = ?').get('f_archived_1') as
    | { path: string }
    | undefined;
  assert.ok(doc, 'archived fact is indexed');
  assert.ok(doc.path.endsWith('.gz'), doc.path);

  assert.equal(forgetFact(fixture.built.db, fixture.config, 'f_archived_1'), true);
  reindexAll(fixture.built.db, fixture.config, { force: true });
  assert.equal(fixture.built.db.prepare('SELECT 1 FROM docs WHERE id = ?').get('f_archived_1'), undefined);

  // Tombstone went to the active month shard, not the read-only archive.
  const active = join(factsDir, '2026-10.jsonl');
  assert.equal(existsSync(active), true);
  const lines = readFileSync(active, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(lines.some((line) => line.id === 'f_archived_1' && line.deleted === true));
});
