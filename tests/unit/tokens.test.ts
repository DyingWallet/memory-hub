import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenStore } from '@memsvc/server/tokens';

let dir: string;
let file: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'memsvc-tokens-'));
  file = join(dir, 'tokens.json');
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('tokens issued after server start become valid without a restart', () => {
  const server = new TokenStore(file);
  assert.equal(server.verify('msv1.nope.nope'), null);

  // Another process (the admin CLI) writes the file.
  const cli = new TokenStore(file);
  const issued = cli.issue({ name: 'late', surface: 'main', scopes: ['*'] });

  const verified = server.verify(issued.token);
  assert.ok(verified, 'server should pick up tokens written by another process');
  assert.equal(verified?.id, issued.record.id);
});

test('revocation written by another process is picked up', () => {
  const server = new TokenStore(file);
  const cli = new TokenStore(file);
  const issued = cli.issue({ name: 'to-revoke', surface: 'main', scopes: ['*'] });
  assert.ok(server.verify(issued.token));

  cli.revoke(issued.record.id);
  assert.equal(server.verify(issued.token), null);
});

test('a missing token file behaves like an empty store', () => {
  const store = new TokenStore(join(dir, 'missing.json'));
  assert.equal(store.hasTokens(), false);
  assert.equal(store.verify('msv1.x.y'), null);
});
