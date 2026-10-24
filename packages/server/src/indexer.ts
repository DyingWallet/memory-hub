import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import {
  chunkMarkdown,
  classifyPrivacy,
  defaultAudience,
  defaultPrivacy,
  normalizeAudience,
  parseFrontMatter,
  sha256Hex,
  titleFrom,
  asString,
  asStringArray,
  monthShard,
  type RestrictedPolicy,
} from '@memsvc/core';
import type { MemoryKind, Privacy, TFactRecord } from '@memsvc/protocol';
import type { ServerConfig } from './config.js';
import type { Db } from './db.js';
import { clearIndex, readStats, setMeta } from './db.js';
import { listFactFiles, readFactFileLines } from './archive.js';
import { scopesForAudience } from './visibility.js';
import { tokensForText } from './search.js';

export type FactRecord = TFactRecord;

const SKIP_DIRS = new Set(['.meta', '90-tools', 'facts', 'audiences', 'node_modules']);

const KIND_BY_PREFIX: { prefix: string; kind: MemoryKind }[] = [
  { prefix: '10-journal', kind: 'journal' },
  { prefix: '20-people', kind: 'person' },
  { prefix: '30-projects', kind: 'project' },
  { prefix: '40-decisions', kind: 'decision' },
  { prefix: '50-knowledge', kind: 'knowledge' },
  { prefix: 'user/identity', kind: 'identity' },
  { prefix: 'user/profile', kind: 'profile' },
  { prefix: 'user/preferences', kind: 'preference' },
  { prefix: '00-inbox', kind: 'note' },
];

const VALID_KINDS = new Set<string>([
  'note',
  'event',
  'stance',
  'promise',
  'person',
  'identity',
  'qq-topic',
  'qq-impression',
  'journal',
  'decision',
  'knowledge',
  'audience',
  'project',
  'profile',
  'preference',
]);

export interface ReindexResult {
  docs: number;
  facts: number;
  chunks: number;
  changed: number;
}

export function reindexAll(db: Db, config: ServerConfig, options: { force?: boolean } = {}): ReindexResult {
  if (options.force) clearIndex(db);
  let changed = 0;

  const files = listMarkdownFiles(config.memoriesDir);
  const livePaths = new Set<string>();

  for (const absPath of files) {
    const rel = toPosix(relative(config.memoriesDir, absPath));
    livePaths.add(rel);
    try {
      if (indexDocFile(db, config, absPath, rel)) changed += 1;
    } catch (error) {
      console.error(`[indexer] failed to index ${rel}: ${(error as Error).message}`);
    }
  }

  // Drop documents whose files disappeared.
  const docRows = db.prepare("SELECT id, path FROM docs WHERE doc_type = 'doc'").all() as { id: string; path: string }[];
  for (const row of docRows) {
    if (!livePaths.has(row.path)) {
      deleteDoc(db, row.id);
      changed += 1;
    }
  }

  changed += indexFacts(db, config);

  setMeta(db, 'built_at', new Date().toISOString());
  const stats = readStats(db);
  return { docs: stats.docs, facts: stats.facts, chunks: stats.chunks, changed };
}

function listMarkdownFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith('.md')) continue;
      if (entry.name === 'index.md' && dir === root) continue;
      out.push(abs);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

export function indexDocFile(db: Db, config: ServerConfig, absPath: string, relPath?: string): boolean {
  const rel = relPath ?? toPosix(relative(config.memoriesDir, absPath));
  const raw = readFileSync(absPath, 'utf8');
  const hash = sha256Hex(raw);
  const docId = `doc:${rel}`;

  const existing = db.prepare('SELECT hash FROM docs WHERE id = ?').get(docId) as { hash?: string } | undefined;
  if (existing?.hash === hash) return false;

  const { data, body } = parseFrontMatter(raw);
  const kind = resolveKind(rel, asString(data.kind));
  const tags = asStringArray(data.tags);
  const privacy = resolvePrivacy(asString(data.privacy), kind, 'main', body, tags, config.privacy, 'doc');
  const scene = asString(data.scene);
  const audience = normalizeAudience(asStringArray(data.audience), kind, scene);
  const source = asString(data.source) ?? (kind.startsWith('qq-') ? 'qq' : 'main');
  const title =
    asString(data.title) ?? firstHeading(body) ?? rel.split('/').pop()?.replace(/\.md$/i, '') ?? rel;
  const updatedAt = Math.floor(statSync(absPath).mtimeMs);

  const chunks = chunkMarkdown(body, { maxChars: 600, overlap: 80, includeHeadingInText: false });
  replaceDoc(db, {
    id: docId,
    docType: 'doc',
    path: rel,
    title,
    kind,
    audience,
    privacy,
    source,
    scene,
    hash,
    updatedAt,
    chunks,
  });
  return true;
}

interface ReplaceDocInput {
  id: string;
  docType: 'doc' | 'fact';
  path: string;
  title: string;
  kind: string;
  audience: string[];
  privacy: string;
  source: string;
  scene?: string;
  hash: string;
  updatedAt: number;
  stage?: 'short' | 'long';
  expiresAt?: number | null;
  recallCount?: number;
  persistedAt?: number | null;
  /** 'owner' | 'self' | 'other'; defaults to 'owner'. */
  subject?: string;
  chunks: { heading: string; text: string }[];
}

function replaceDoc(db: Db, input: ReplaceDocInput): void {
  db.exec('BEGIN');
  try {
    deleteDocRows(db, input.id);
    db.prepare(
      `INSERT INTO docs(id, doc_type, path, title, kind, audience, privacy, source, scene, hash, updated_at, stage, expires_at, recall_count, persisted_at, subject)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         doc_type=excluded.doc_type, path=excluded.path, title=excluded.title, kind=excluded.kind,
         audience=excluded.audience, privacy=excluded.privacy, source=excluded.source,
         scene=excluded.scene, hash=excluded.hash, updated_at=excluded.updated_at,
         stage=excluded.stage, expires_at=excluded.expires_at, recall_count=excluded.recall_count,
         persisted_at=excluded.persisted_at, subject=excluded.subject`,
    ).run(
      input.id,
      input.docType,
      input.path,
      input.title,
      input.kind,
      JSON.stringify(input.audience),
      input.privacy,
      input.source,
      input.scene ?? null,
      input.hash,
      input.updatedAt,
      input.stage ?? 'long',
      input.expiresAt ?? null,
      input.recallCount ?? 0,
      input.persistedAt ?? null,
      input.subject ?? 'owner',
    );

    const insertChunk = db.prepare(
      `INSERT INTO chunks(id, doc_id, path, title, heading, text, tokens, kind, audience, privacy, scene, updated_at, stage, expires_at, subject)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertScope = db.prepare('INSERT OR IGNORE INTO chunk_scopes(chunk_id, scope) VALUES(?, ?)');
    const insertFts = db.prepare('INSERT INTO chunks_fts(rowid, tokens, text) VALUES(?, ?, ?)');
    const scopes = scopesForAudience(input.audience);
    // The H1/title is searchable through the first chunk (a query like 「桌宠」
    // must hit a doc whose only mention is the title) without letting the title
    // outrank real body text in every other chunk.
    const indexedChunks = input.chunks.map((chunk, index) =>
      index === 0 && input.docType === 'doc' && input.title.length > 0
        ? { ...chunk, text: `${input.title}\n${chunk.text}` }
        : chunk,
    );

    indexedChunks.forEach((chunk, index) => {
      const chunkId = input.docType === 'fact' ? input.id : `${input.id}#${index}`;
      const tokens = tokensForText(`${chunk.heading}\n${chunk.text}`);
      const result = insertChunk.run(
        chunkId,
        input.id,
        input.path,
        input.title,
        chunk.heading,
        chunk.text,
        tokens,
        input.kind,
        JSON.stringify(input.audience),
        input.privacy,
        input.scene ?? null,
        input.updatedAt,
        input.stage ?? 'long',
        input.expiresAt ?? null,
        input.subject ?? 'owner',
      );
      const rowid = Number(result.lastInsertRowid);
      insertFts.run(rowid, tokens, chunk.text);
      for (const scope of scopes) insertScope.run(chunkId, scope);
    });

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function deleteDoc(db: Db, docId: string): void {
  db.exec('BEGIN');
  try {
    deleteDocRows(db, docId);
    db.prepare('DELETE FROM docs WHERE id = ?').run(docId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function deleteDocRows(db: Db, docId: string): void {
  const rows = db.prepare('SELECT rowid, id FROM chunks WHERE doc_id = ?').all(docId) as { rowid: number; id: string }[];
  const dropFts = db.prepare('DELETE FROM chunks_fts WHERE rowid = ?');
  const dropScopes = db.prepare('DELETE FROM chunk_scopes WHERE chunk_id = ?');
  const dropChunk = db.prepare('DELETE FROM chunks WHERE rowid = ?');
  for (const row of rows) {
    dropFts.run(row.rowid);
    dropScopes.run(row.id);
    dropChunk.run(row.rowid);
  }
}

/* ------------------------------------------------------------------ */
/* facts                                                              */
/* ------------------------------------------------------------------ */

function indexFacts(db: Db, config: ServerConfig): number {
  if (!existsSync(config.factsDir)) return 0;
  const liveIds = new Set<string>();
  let changed = 0;

  for (const filePath of listFactFiles(config.factsDir)) {
    const relPath = `facts/${relative(config.factsDir, filePath).replaceAll('\\', '/')}`;
    let lineNo = 0;
    for (const line of readFactFileLines(filePath)) {
      lineNo += 1;
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let record: FactRecord;
      try {
        record = JSON.parse(trimmed) as FactRecord;
      } catch {
        console.error(`[indexer] bad JSON in ${relPath}:${lineNo}`);
        continue;
      }
      if (!record.id || !record.text) continue;
      // Tombstone: a later line with the same id and deleted:true removes the fact
      // from the index; the JSONL stays append-only and reindex must not resurrect it.
      if ((record as FactRecord & { deleted?: boolean }).deleted === true) {
        if (liveIds.delete(record.id)) {
          deleteDoc(db, record.id);
          changed += 1;
        }
        continue;
      }
      liveIds.add(record.id);
      if (upsertFact(db, config, record, relPath)) changed += 1;
    }
  }

  const stale = db.prepare("SELECT id FROM docs WHERE doc_type = 'fact'").all() as { id: string }[];
  for (const row of stale) {
    if (!liveIds.has(row.id)) {
      deleteDoc(db, row.id);
      changed += 1;
    }
  }
  return changed;
}

/** Writes one fact into the monthly JSONL shard and indexes it immediately. */
export function appendFact(db: Db, config: ServerConfig, record: FactRecord): { path: string; indexed: boolean } {
  const relPath = `facts/${monthShard(record.ts)}.jsonl`;
  const absPath = join(config.factsDir, `${monthShard(record.ts)}.jsonl`);
  mkdirSync(config.factsDir, { recursive: true });
  appendFileSync(absPath, `${JSON.stringify(record)}\n`, 'utf8');
  const indexed = upsertFact(db, config, record, relPath);
  return { path: relPath, indexed };
}

/**
 * Forget one fact: append a tombstone line (JSONL stays append-only) and drop
 * its index rows. Returns false when the id is not an indexed fact.
 */
export function forgetFact(db: Db, config: ServerConfig, id: string): boolean {
  const row = db.prepare("SELECT path FROM docs WHERE id = ? AND doc_type = 'fact'").get(id) as { path?: string } | undefined;
  if (!row?.path) return false;
  // Archived shards are read-only; tombstones go to the current active shard,
  // which reindex visits after every archive month.
  const archived = row.path.endsWith('.gz');
  const relPath = archived ? `facts/${monthShard(new Date().toISOString())}.jsonl` : row.path;
  const absPath = join(config.memoriesDir, relPath);
  const tombstone = {
    schema_version: 1,
    id,
    ts: new Date().toISOString(),
    deleted: true,
    kind: 'note',
    text: 'deleted',
    audience: ['main'],
    privacy: 'normal',
    source: 'main',
  };
  mkdirSync(dirname(absPath), { recursive: true });
  appendFileSync(absPath, `${JSON.stringify(tombstone)}\n`, 'utf8');
  deleteDoc(db, id);
  return true;
}

function upsertFact(db: Db, config: ServerConfig, record: FactRecord, relPath: string): boolean {
  const hash = sha256Hex(JSON.stringify(record));
  const existing = db.prepare('SELECT hash FROM docs WHERE id = ?').get(record.id) as { hash?: string } | undefined;
  const audience = normalizeAudience(record.audience, record.kind, record.scene);
  const privacy = resolvePrivacy(record.privacy, record.kind, record.source, record.text, record.tags, config.privacy, 'fact');
  const chunks = record.text.trim().length > 0 ? [{ heading: '', text: record.text.trim() }] : [];
  if (chunks.length === 0) return false;
  if (existing?.hash === hash) return false;

  replaceDoc(db, {
    id: record.id,
    docType: 'fact',
    path: relPath,
    title: titleFrom(record.text),
    kind: record.kind,
    audience,
    privacy,
    source: record.source ?? 'main',
    scene: record.scene,
    hash,
    updatedAt: Math.floor(Date.parse(record.ts) || Date.now()),
    stage: record.stage === 'short' ? 'short' : 'long',
    expiresAt: record.expires_at ? Date.parse(record.expires_at) : null,
    recallCount: record.recall_count ?? 0,
    persistedAt: record.persisted_at ? Date.parse(record.persisted_at) : null,
    subject: record.subject ?? 'owner',
    chunks,
  });
  return true;
}

/* ------------------------------------------------------------------ */
/* identity / audience cards                                          */
/* ------------------------------------------------------------------ */

export function loadIdentity(config: ServerConfig): string {
  if (!existsSync(config.identityFile)) return config.identityFallback;
  try {
    const raw = readFileSync(config.identityFile, 'utf8');
    const { body } = parseFrontMatter(raw);
    const paragraphs = body
      .split(/\n\s*\n/)
      .map((p) => p.replace(/^#{1,6}\s+.*$/gm, '').trim())
      .filter((p) => p.length > 0);
    const text = paragraphs.slice(0, 2).join('\n').trim();
    return text.length > 0 ? text.slice(0, 600) : config.identityFallback;
  } catch {
    return config.identityFallback;
  }
}

export interface AudienceCard {
  id: string;
  face: string;
  name?: string;
  kind?: string;
  relationship?: string;
  boundaries?: string[];
  known?: string[];
}

/**
 * Audience cards live in `memories/audiences/<scene>.md`. Windows forbids `:`
 * in filenames, so `qq:group:10001` is stored as `qq-group-10001.md`.
 */
export function loadAudienceCard(config: ServerConfig, scene: string): AudienceCard {
  const candidates = [scene, scene.replaceAll(':', '-'), scene.replaceAll(':', '_')];
  for (const candidate of candidates) {
    const path = join(config.audiencesDir, `${candidate}.md`);
    if (!existsSync(path)) continue;
    try {
      const { data } = parseFrontMatter(readFileSync(path, 'utf8'));
      return {
        id: asString(data.id) ?? scene,
        face: asString(data.face) ?? '',
        name: asString(data.name),
        kind: asString(data.kind),
        relationship: asString(data.relationship),
        boundaries: asStringArray(data.boundaries),
        known: asStringArray(data.known),
      };
    } catch {
      break;
    }
  }

  if (scene === 'main') {
    return { id: 'main', face: loadIdentity(config), kind: 'owner', name: '主会话' };
  }
  return {
    id: scene,
    face: '（暂无受众卡：未知对象，按最低披露处理）',
    kind: scene.startsWith('qq:group') ? 'group' : 'private',
  };
}

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function resolveKind(rel: string, declared?: string): MemoryKind {
  if (declared && VALID_KINDS.has(declared)) return declared as MemoryKind;
  for (const rule of KIND_BY_PREFIX) {
    if (rel.startsWith(rule.prefix)) return rule.kind;
  }
  return 'note';
}

function resolvePrivacy(
  declared: string | undefined,
  kind: MemoryKind,
  source: string | undefined,
  _text: string,
  _tags: readonly string[] | undefined,
  _policy: RestrictedPolicy,
  _target: 'doc' | 'fact',
): Privacy {
  const value = typeof declared === 'string' ? declared.trim() : '';
  if (value === 'normal' || value === 'personal' || value === 'sensitive' || value === 'secret') return value;
  // Legacy labels are mapped to the single sensitivity bit; the original name
  // is preserved as a tag by the migration script / caller.
  if (value.length > 0) return 'sensitive';
  return defaultPrivacy(kind, source);
}

function firstHeading(body: string): string | undefined {
  for (const line of body.split('\n')) {
    const match = /^#{1,2}\s+(.*)$/.exec(line.trim());
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

export function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

export function defaultAudienceForKind(kind: MemoryKind, scene?: string): string[] {
  return [...defaultAudience(kind, scene)];
}
