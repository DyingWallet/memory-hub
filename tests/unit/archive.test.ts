import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveOldFacts, listFactFiles, readFactLines } from '@memsvc/server/archive';

function tempFacts(): string {
  const dir = mkdtempSync(join(tmpdir(), 'memsvc-archive-'));
  writeFileSync(join(dir, '2026-09.jsonl'), '{"id":"a","text":"九月"}\n{"id":"b","text":"九月二"}\n', 'utf8');
  writeFileSync(join(dir, '2026-10.jsonl'), '{"id":"c","text":"十月"}\n', 'utf8');
  return dir;
}

test('finished months are gzipped, verified, and removed', () => {
  const dir = tempFacts();
  const now = Date.parse('2026-10-15T00:00:00Z');
  const result = archiveOldFacts(dir, now);
  assert.deepEqual(result.archived, ['2026-09.jsonl']);
  assert.deepEqual(result.skipped, []);
  assert.equal(existsSync(join(dir, '2026-09.jsonl')), false);
  assert.equal(existsSync(join(dir, '2026-10.jsonl')), true);

  const gz = gunzipSync(readFileSync(join(dir, 'archive', '2026-09.jsonl.gz'))).toString('utf8');
  assert.equal(gz, '{"id":"a","text":"九月"}\n{"id":"b","text":"九月二"}\n');
});

test('the current month is never archived', () => {
  const dir = tempFacts();
  const result = archiveOldFacts(dir, Date.parse('2026-10-01T00:00:00Z'));
  assert.deepEqual(result.archived, ['2026-09.jsonl']);
  const again = archiveOldFacts(dir, Date.parse('2026-10-01T00:00:00Z'));
  assert.deepEqual(again.archived, [], 'idempotent');
});

test('keepMonths leaves recent finished months plain', () => {
  const dir = tempFacts();
  writeFileSync(join(dir, '2026-07.jsonl'), '{"id":"j","text":"七月"}\n', 'utf8');
  writeFileSync(join(dir, '2026-08.jsonl'), '{"id":"h","text":"八月"}\n', 'utf8');
  const now = Date.parse('2026-10-15T00:00:00Z');
  const result = archiveOldFacts(dir, now, 2);
  assert.deepEqual(result.archived.sort(), ['2026-07.jsonl']);
  assert.equal(existsSync(join(dir, '2026-08.jsonl')), true);
  assert.equal(existsSync(join(dir, '2026-09.jsonl')), true);
});

test('archived files are read chronologically before active ones', () => {
  const dir = tempFacts();
  archiveOldFacts(dir, Date.parse('2026-10-15T00:00:00Z'));
  const files = listFactFiles(dir);
  assert.equal(files.length, 2);
  const first = files[0];
  const second = files[1];
  assert.ok(first);
  assert.ok(second);
  assert.ok(first.includes('archive') && first.endsWith('2026-09.jsonl.gz'), first);
  assert.ok(second.endsWith('2026-10.jsonl'), second);
  const lines = readFactLines(dir);
  assert.deepEqual(lines.map((line) => JSON.parse(line).id), ['a', 'b', 'c']);
});
