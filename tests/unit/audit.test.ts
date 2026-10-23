import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog } from '@memsvc/server/audit';

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'memsvc-audit-'));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('prune drops entries older than the retention window and keeps recent ones', () => {
  const file = join(dir, 'audit.jsonl');
  const now = Date.now();
  const old = new Date(now - 40 * 24 * 3600 * 1000).toISOString();
  const recent = new Date(now - 2 * 24 * 3600 * 1000).toISOString();
  writeFileSync(
    file,
    [
      JSON.stringify({ ts: old, token: 'tok_old', surface: 'main', route: 'search' }),
      JSON.stringify({ ts: recent, token: 'tok_new', surface: 'main', route: 'recall' }),
      'not-json',
    ].join('\n') + '\n',
    'utf8',
  );

  new AuditLog(file, 30).prune(now);

  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  const line = lines[0] ?? '';
  assert.match(line, /tok_new/);
  assert.doesNotMatch(line, /tok_old/);
});
