import { buildFtsQuery, extractKeywords, titleFrom, tokenize, tokenizeQuery, truncate } from '@memsvc/core';
import type { Restriction, TokenView } from '@memsvc/core';
import type { Db } from './db.js';
import { visibilityClause } from './visibility.js';

export interface SearchHit {
  id: string;
  path: string;
  title: string;
  heading: string;
  text: string;
  kind: string;
  updated_at: number;
  stage: 'short' | 'long';
  expires_at: number | null;
  score: number;
}

interface ChunkRow {
  id: string;
  path: string;
  title: string;
  heading: string | null;
  text: string;
  kind: string;
  updated_at: number;
  stage: string | null;
  expires_at: number | null;
  rank: number;
}

export interface SearchParams {
  query: string;
  k: number;
  maxChars: number;
  token: TokenView;
  scene: string;
  kinds?: readonly string[];
  pathPrefix?: string;
  /** Allow the owner's own memories when the owner brought the topic up here. */
  ownerDisclosure?: boolean;
  /** Sensitivity policy resolved for this request. */
  restriction?: Restriction;
}

export interface SearchOutcome {
  hits: SearchHit[];
  weak: boolean;
  scanned: number;
  keywords: string[];
}

const RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Two-pass keyword search: AND first (precise), OR when recall is weak.
 * Results are re-scored in JS because bm25 knows nothing about titles,
 * freshness, or scene proximity.
 */
export function searchChunks(db: Db, params: SearchParams): SearchOutcome {
  const keywords = extractKeywords(params.query, 10);
  const tokens = tokenizeQuery(params.query);
  if (tokens.length === 0) return { hits: [], weak: true, scanned: 0, keywords };

  const visibility = visibilityClause(params.token, params.scene, 'c', {
    ownerDisclosure: params.ownerDisclosure === true,
    ...(params.restriction ? { restriction: params.restriction } : {}),
  });
  const limit = Math.max(params.k * 4, 20);

  const andExpr = buildFtsQuery(tokens, 'and');
  let rows = runMatch(db, andExpr, visibility.where, visibility.params, params, limit);
  let weak = false;

  if (rows.length < params.k && tokens.length > 1) {
    weak = true;
    const orExpr = buildFtsQuery(tokens, 'or');
    const orRows = runMatch(db, orExpr, visibility.where, visibility.params, params, limit);
    const seen = new Set(rows.map((row) => row.id));
    rows = [...rows, ...orRows.filter((row) => !seen.has(row.id))];
  } else if (rows.length < params.k) {
    weak = true;
  }

  const now = Date.now();
  const scored = rows.map((row) => {
    let score = -row.rank;
    const heading = row.heading ?? '';
    const title = row.title ?? '';
    if (heading && tokens.some((token) => heading.toLowerCase().includes(token))) score += 0.35;
    else if (title && tokens.some((token) => title.toLowerCase().includes(token))) score += 0.2;
    if (now - row.updated_at <= RECENT_WINDOW_MS) score += 0.08;
    return {
      id: row.id,
      path: row.path,
      title,
      heading,
      text: truncate(row.text, params.maxChars),
      kind: row.kind,
      updated_at: row.updated_at,
      stage: row.stage === 'short' ? 'short' : 'long',
      expires_at: row.expires_at ?? null,
      score,
    } satisfies SearchHit;
  });

  scored.sort((a, b) => b.score - a.score || b.updated_at - a.updated_at);
  return { hits: scored.slice(0, params.k), weak, scanned: rows.length, keywords };
}

function runMatch(
  db: Db,
  matchExpr: string,
  visibilityWhere: string,
  visibilityParams: (string | number)[],
  params: SearchParams,
  limit: number,
): ChunkRow[] {
  if (matchExpr.length === 0) return [];
  const clauses = [visibilityWhere];
  const values: (string | number)[] = [matchExpr, ...visibilityParams];

  if (params.kinds && params.kinds.length > 0) {
    clauses.push(`c.kind IN (${params.kinds.map(() => '?').join(', ')})`);
    values.push(...params.kinds);
  }
  if (params.pathPrefix) {
    clauses.push('c.path LIKE ?');
    values.push(`${params.pathPrefix.replaceAll('\\', '/')}%`);
  }
  values.push(limit);

  const sql = `
    SELECT c.id, c.path, c.title, c.heading, c.text, c.kind, c.updated_at, c.stage, c.expires_at, bm25(chunks_fts) AS rank
    FROM chunks_fts
    JOIN chunks c ON c.rowid = chunks_fts.rowid
    WHERE chunks_fts MATCH ? AND ${clauses.join(' AND ')}
    ORDER BY rank
    LIMIT ?`;
  return db.prepare(sql).all(...values) as unknown as ChunkRow[];
}

export function getChunk(
  db: Db,
  id: string,
  token: TokenView,
  scene: string,
  maxChars: number,
  restriction?: Restriction,
): SearchHit | null {
  const visibility = visibilityClause(token, scene, 'c', restriction ? { restriction } : {});
  const row = db
    .prepare(
      `SELECT c.id, c.path, c.title, c.heading, c.text, c.kind, c.updated_at, c.stage, c.expires_at
       FROM chunks c
       WHERE c.id = ? AND ${visibility.where}
       LIMIT 1`,
    )
    .get(id, ...visibility.params) as unknown as (Omit<ChunkRow, 'rank'> | undefined);
  if (!row) return null;
  return {
    id: row.id,
    path: row.path,
    title: row.title,
    heading: row.heading ?? '',
    text: truncate(row.text, maxChars),
    kind: row.kind,
    updated_at: row.updated_at,
    stage: row.stage === 'short' ? 'short' : 'long',
    expires_at: row.expires_at ?? null,
    score: 1,
  };
}

export interface RecentDoc {
  id: string;
  title: string;
  kind: string;
  updated_at: number;
  text: string;
}

/** `get` accepts a chunk id (from search) or a doc id (from bootstrap/recent). */
export function getChunkOrDoc(
  db: Db,
  id: string,
  token: TokenView,
  scene: string,
  maxChars: number,
  restriction?: Restriction,
): SearchHit | null {
  const direct = getChunk(db, id, token, scene, maxChars, restriction);
  if (direct) return direct;

  const visibility = visibilityClause(token, scene, 'c', restriction ? { restriction } : {});
  const row = db
    .prepare(
      `SELECT c.id, c.path, c.title, c.heading, c.text, c.kind, c.updated_at, c.stage, c.expires_at
       FROM chunks c
       WHERE c.doc_id = ? AND ${visibility.where}
       ORDER BY c.rowid ASC
       LIMIT 1`,
    )
    .get(id, ...visibility.params) as unknown as (Omit<ChunkRow, 'rank'> | undefined);
  if (!row) return null;
  return {
    id: row.id,
    path: row.path,
    title: row.title,
    heading: row.heading ?? '',
    text: truncate(row.text, maxChars),
    kind: row.kind,
    updated_at: row.updated_at,
    stage: row.stage === 'short' ? 'short' : 'long',
    expires_at: row.expires_at ?? null,
    score: 1,
  };
}

/** Distinct documents, newest first, still filtered by visibility. */
export function recentDocs(
  db: Db,
  token: TokenView,
  scene: string,
  k: number,
  kinds?: readonly string[],
  restriction?: Restriction,
): RecentDoc[] {
  const visibility = visibilityClause(token, scene, 'c', restriction ? { restriction } : {});
  const clauses = [visibility.where];
  const values: (string | number)[] = [...visibility.params];
  if (kinds && kinds.length > 0) {
    clauses.push(`c.kind IN (${kinds.map(() => '?').join(', ')})`);
    values.push(...kinds);
  }
  values.push(Math.max(k * 6, 24));

  const rows = db
    .prepare(
      `SELECT c.doc_id, c.title, c.heading, c.text, c.kind, c.updated_at, c.stage, c.expires_at
       FROM chunks c
       WHERE ${clauses.join(' AND ')}
       ORDER BY c.updated_at DESC, c.rowid DESC
       LIMIT ?`,
    )
    .all(...values) as unknown as {
      doc_id: string;
      title: string;
      heading: string | null;
      text: string;
      kind: string;
      updated_at: number;
    }[];

  const seen = new Set<string>();
  const out: RecentDoc[] = [];
  for (const row of rows) {
    if (seen.has(row.doc_id)) continue;
    seen.add(row.doc_id);
    out.push({
      id: row.doc_id,
      title: row.title || (row.heading && row.heading.length > 0 ? row.heading : titleFrom(row.text)),
      kind: row.kind,
      updated_at: row.updated_at,
      text: row.text,
    });
    if (out.length >= k) break;
  }
  return out;
}

export function tokensForText(text: string): string {
  return tokenize(text).join(' ');
}

export interface ReviewCandidate {
  id: string;
  title: string;
  kind: string;
  text: string;
  scene: string | null;
  updated_at: number;
  expires_at: number | null;
}

/** Short-term memories visible in this scene that are candidates for review. */
export function reviewCandidates(
  db: Db,
  token: TokenView,
  scene: string,
  restriction: Restriction | undefined,
  options: { lookbackMs: number; limit: number },
): ReviewCandidate[] {
  const visibility = visibilityClause(token, scene, 'c', restriction ? { restriction } : {});
  const now = Date.now();
  const rows = db
    .prepare(
      `SELECT c.doc_id, c.title, c.heading, c.text, c.kind, c.scene, c.updated_at, c.expires_at
       FROM chunks c
       WHERE c.stage = 'short' AND c.expires_at > ? AND c.updated_at >= ? AND ${visibility.where}
       GROUP BY c.doc_id
       ORDER BY c.updated_at DESC
       LIMIT ?`,
    )
    .all(now, now - options.lookbackMs, ...visibility.params, options.limit) as unknown as {
    doc_id: string;
    title: string;
    heading: string | null;
    text: string;
    kind: string;
    scene: string | null;
    updated_at: number;
    expires_at: number | null;
  }[];

  return rows.map((row) => ({
    id: row.doc_id,
    title: row.title || (row.heading && row.heading.length > 0 ? row.heading : titleFrom(row.text)),
    kind: row.kind,
    text: truncate(row.text, 300),
    scene: row.scene,
    updated_at: row.updated_at,
    expires_at: row.expires_at,
  }));
}

