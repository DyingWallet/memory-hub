// 升级路径：已有的索引库没有新列时，openDb 必须能补齐并保留旧行。
// 2026-10-24 踩过：把 `CREATE INDEX ... docs(subject)` 放在 SCHEMA 里，
// 旧库在 migrate 之前执行 SCHEMA 就报 "no such column: subject"，memd 起不来。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '@memsvc/server/db';

test('旧库（没有 subject 列）打开时自动补列，旧行按 owner 读', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memd-migrate-'));
  const file = join(dir, 'index.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE docs (
      id TEXT PRIMARY KEY, doc_type TEXT NOT NULL, path TEXT NOT NULL, title TEXT NOT NULL,
      kind TEXT NOT NULL, audience TEXT NOT NULL, privacy TEXT NOT NULL, source TEXT NOT NULL,
      scene TEXT, hash TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE chunks (
      rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, doc_id TEXT NOT NULL, path TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '', heading TEXT, text TEXT NOT NULL, tokens TEXT NOT NULL,
      kind TEXT NOT NULL, audience TEXT NOT NULL, privacy TEXT NOT NULL, scene TEXT, updated_at INTEGER NOT NULL
    );
    INSERT INTO docs VALUES ('f_old','fact','facts/x.jsonl','旧记忆','note','["main"]','normal','main','main','h',1);
    INSERT INTO chunks (id, doc_id, path, title, heading, text, tokens, kind, audience, privacy, scene, updated_at)
      VALUES ('f_old','f_old','facts/x.jsonl','旧记忆','','旧记忆','旧 记忆','note','["main"]','normal','main',1);
  `);
  old.close();

  const db = openDb(file);
  try {
    const doc = db.prepare("SELECT subject FROM docs WHERE id = 'f_old'").get() as { subject: string };
    assert.equal(doc.subject, 'owner');
    const chunk = db.prepare("SELECT subject FROM chunks WHERE id = 'f_old'").get() as { subject: string };
    assert.equal(chunk.subject, 'owner');
    // 索引也建好了：能直接按 subject 过滤。
    const hits = db.prepare("SELECT id FROM chunks WHERE subject = 'self'").all() as { id: string }[];
    assert.deepEqual(hits, []);
  } finally {
    db.close();
  }
});
