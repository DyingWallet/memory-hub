import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBackup } from '@memsvc/server/backup';

function sourceTree(): { memoriesDir: string; dataDir: string; configFile: string; dest: string } {
  const root = mkdtempSync(join(tmpdir(), 'memsvc-backup-'));
  const memories = join(root, 'memories');
  const data = join(root, 'data');
  mkdirSync(join(memories, 'facts'), { recursive: true });
  mkdirSync(join(memories, '10-journal'), { recursive: true });
  mkdirSync(data, { recursive: true });
  writeFileSync(join(memories, 'facts', '2026-10.jsonl'), '{"id":"a"}\n', 'utf8');
  writeFileSync(join(memories, '10-journal', 'note.md'), '# 日志\n', 'utf8');
  writeFileSync(join(data, 'tokens.json'), '{"tokens":[]}\n', 'utf8');
  writeFileSync(join(root, 'config.json'), '{"port":8787}\n', 'utf8');
  return { memoriesDir: memories, dataDir: data, configFile: join(root, 'config.json'), dest: join(root, 'backups') };
}

test('backup copies memories + tokens + config with a manifest', () => {
  const tree = sourceTree();
  const result = runBackup({ ...tree, destDir: tree.dest, keepDays: 14, now: Date.parse('2026-10-24T04:00:00Z') });
  assert.equal(existsSync(join(result.dir, 'memories', 'facts', '2026-10.jsonl')), true);
  assert.equal(existsSync(join(result.dir, 'memories', '10-journal', 'note.md')), true);
  assert.equal(existsSync(join(result.dir, 'tokens.json')), true);
  assert.equal(existsSync(join(result.dir, 'config.json')), true);

  const manifest = JSON.parse(readFileSync(join(result.dir, 'manifest.json'), 'utf8')) as { files: number; bytes: number };
  assert.ok(manifest.files >= 3);
  assert.ok(manifest.bytes > 0);
});

test('one snapshot per day, and old snapshots are pruned', () => {
  const tree = sourceTree();
  const day1 = Date.parse('2026-10-01T04:00:00Z');
  runBackup({ ...tree, destDir: tree.dest, keepDays: 3, now: day1 });

  // Same day again: replaces, does not duplicate.
  runBackup({ ...tree, destDir: tree.dest, keepDays: 3, now: day1 + 3_600_000 });
  const base = join(tree.dest);
  assert.deepEqual(readdirSync(base).sort(), ['2026-10-01']);

  // Four days later: the first snapshot is older than keepDays=3 and goes away.
  const result = runBackup({ ...tree, destDir: tree.dest, keepDays: 3, now: Date.parse('2026-10-05T04:00:00Z') });
  assert.deepEqual(result.pruned, ['2026-10-01']);
  const dirs = readdirSync(base).sort();
  assert.deepEqual(dirs, ['2026-10-05']);
});
