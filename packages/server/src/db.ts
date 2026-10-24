import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

export const SCHEMA_VERSION = 3;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS docs (
  id         TEXT PRIMARY KEY,
  doc_type   TEXT NOT NULL,              -- 'doc' | 'fact'
  path       TEXT NOT NULL,
  title      TEXT NOT NULL,
  kind       TEXT NOT NULL,
  audience   TEXT NOT NULL,              -- JSON array
  privacy    TEXT NOT NULL,
  source     TEXT NOT NULL,
  scene      TEXT,
  hash       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  stage      TEXT NOT NULL DEFAULT 'long', -- 'short' | 'long'
  expires_at INTEGER,                     -- epoch ms for short memories
  recall_count INTEGER NOT NULL DEFAULT 0,
  persisted_at INTEGER,
  subject    TEXT NOT NULL DEFAULT 'owner', -- 'owner' | 'self' | 'other'
  supersedes TEXT                        -- id of the memory this one replaced
);

CREATE INDEX IF NOT EXISTS docs_path ON docs(path);
CREATE INDEX IF NOT EXISTS docs_updated ON docs(updated_at DESC);

CREATE TABLE IF NOT EXISTS chunks (
  rowid      INTEGER PRIMARY KEY,
  id         TEXT NOT NULL UNIQUE,
  doc_id     TEXT NOT NULL,
  path       TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  heading    TEXT,
  text       TEXT NOT NULL,
  tokens     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  audience   TEXT NOT NULL,              -- JSON array (mirror of docs.audience)
  privacy    TEXT NOT NULL,
  scene      TEXT,
  updated_at INTEGER NOT NULL,
  stage      TEXT NOT NULL DEFAULT 'long',
  expires_at INTEGER,
  subject    TEXT NOT NULL DEFAULT 'owner' -- mirror of docs.subject
);

CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(doc_id);
CREATE INDEX IF NOT EXISTS chunks_updated ON chunks(updated_at DESC);

-- Normalized audience membership: the only place visibility is decided in SQL.
CREATE TABLE IF NOT EXISTS chunk_scopes (
  chunk_id TEXT NOT NULL,
  scope    TEXT NOT NULL,
  PRIMARY KEY (chunk_id, scope)
);
CREATE INDEX IF NOT EXISTS chunk_scopes_scope ON chunk_scopes(scope);

-- Standalone FTS index (tokens are pre-bigrammed by @memsvc/core).
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  tokens,
  text,
  tokenize = 'unicode61'
);
`;

export function openDb(indexFile: string): Db {
  if (indexFile !== ':memory:') mkdirSync(dirname(indexFile), { recursive: true });
  // allowExtension：语义检索要 load sqlite-vec（可选功能）。加载是显式的，
  // 关掉语义检索时不会有任何扩展被加载。
  const db = new DatabaseSync(indexFile, { allowExtension: true });
  db.exec(SCHEMA);
  migrateColumns(db);
  // Indexes over migrated columns must come after the migration: on an existing
  // database SCHEMA runs first, and `docs.subject` does not exist yet there.
  db.exec('CREATE INDEX IF NOT EXISTS docs_subject ON docs(subject);');

  // The index is disposable; on a schema bump just drop and rebuild it.
  const stored = getMeta(db, 'schema_version');
  if (stored !== undefined && stored !== String(SCHEMA_VERSION)) {
    clearIndex(db);
  }
  setMeta(db, 'schema_version', String(SCHEMA_VERSION));
  return db;
}

/**
 * `CREATE TABLE IF NOT EXISTS` never adds columns to an existing index, so new
 * columns are migrated explicitly. Idempotent; safe on a fresh database.
 */
function migrateColumns(db: Db): void {
  const add = (table: string, column: string, ddl: string): void => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some((entry) => entry.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  };
  add('docs', 'stage', "TEXT NOT NULL DEFAULT 'long'");
  add('docs', 'expires_at', 'INTEGER');
  add('docs', 'recall_count', 'INTEGER NOT NULL DEFAULT 0');
  add('docs', 'persisted_at', 'INTEGER');
  // Old rows get the column default 'owner', which is exactly right: everything
  // written before `subject` existed is about the owner.
  add('docs', 'subject', "TEXT NOT NULL DEFAULT 'owner'");
  add('docs', 'supersedes', 'TEXT');
  add('chunks', 'stage', "TEXT NOT NULL DEFAULT 'long'");
  add('chunks', 'expires_at', 'INTEGER');
  add('chunks', 'subject', "TEXT NOT NULL DEFAULT 'owner'");
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function getMeta(db: Db, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined;
  return row?.value;
}

export interface IndexStats {
  docs: number;
  facts: number;
  chunks: number;
  built_at?: string;
}

export function readStats(db: Db): IndexStats {
  const docs = (db.prepare("SELECT COUNT(*) AS n FROM docs WHERE doc_type = 'doc'").get() as { n: number }).n;
  const facts = (db.prepare("SELECT COUNT(*) AS n FROM docs WHERE doc_type = 'fact'").get() as { n: number }).n;
  const chunks = (db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n;
  const builtAt = getMeta(db, 'built_at');
  return builtAt ? { docs, facts, chunks, built_at: builtAt } : { docs, facts, chunks };
}

export function clearIndex(db: Db): void {
  db.exec('DELETE FROM chunks_fts; DELETE FROM chunk_scopes; DELETE FROM chunks; DELETE FROM docs;');
}

/**
 * Drops expired short-term memories. Their JSONL lines stay (append-only log),
 * but the index hides them; a reindex is filtered by `expires_at` as well.
 */
export function purgeExpired(db: Db, now: number = Date.now()): number {
  const rows = db
    .prepare("SELECT id FROM docs WHERE stage = 'short' AND expires_at IS NOT NULL AND expires_at <= ?")
    .all(now) as { id: string }[];
  if (rows.length === 0) return 0;
  const drop = db.prepare('DELETE FROM docs WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      const chunks = db.prepare('SELECT rowid, id FROM chunks WHERE doc_id = ?').all(row.id) as { rowid: number; id: string }[];
      const dropFts = db.prepare('DELETE FROM chunks_fts WHERE rowid = ?');
      const dropScopes = db.prepare('DELETE FROM chunk_scopes WHERE chunk_id = ?');
      const dropChunk = db.prepare('DELETE FROM chunks WHERE rowid = ?');
      for (const chunk of chunks) {
        dropFts.run(chunk.rowid);
        dropScopes.run(chunk.id);
        dropChunk.run(chunk.rowid);
      }
      drop.run(row.id);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return rows.length;
}
