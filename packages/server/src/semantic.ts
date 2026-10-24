// 语义检索（可选）：本地 embedding + sqlite-vec + 与 FTS 的混合排序。
//
// 开关在 config.semantic.enabled（默认关）。关着的时候这个模块完全不会被实例化：
// 不加载 onnxruntime、不建向量表、recall 走原来的纯 FTS。
//
// 降级：模型缺失 / onnxruntime 未安装 / sqlite-vec 加载失败 / 推理报错 —— 一律返回 null，
// 调用方静默退回纯 FTS。检索**不能**因为语义功能坏掉而失败。
import { createRequire } from 'node:module';
import type { SemanticConfig } from './config.js';
import type { Db } from './db.js';
import { EmbeddingRuntime } from './embedding.js';
import { searchChunks, type SearchHit, type SearchOutcome, type SearchParams } from './search.js';
import { visibilityClause } from './visibility.js';

const TABLE = 'chunk_vecs';
const DIM_META_KEY = 'semantic_dim';

export interface SemanticStatus {
  enabled: boolean;
  ready: boolean;
  reason: string | null;
  vectors: number;
  dim: number;
  model: string;
  alpha: number;
}

/** 向量已归一化，L2 距离和余弦的关系是 d² = 2 - 2·cos。 */
export function distanceToCosine(distance: number): number {
  const value = 1 - (distance * distance) / 2;
  return Math.max(-1, Math.min(1, value));
}

/** min-max 压到 [0,1]；只有一个值或全相等时给 1（它本身就是最好/唯一候选）。 */
export function normalizeScores(scores: readonly number[]): number[] {
  if (scores.length === 0) return [];
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max - min < 1e-9) return scores.map(() => 1);
  return scores.map((score) => (score - min) / (max - min));
}

/**
 * 混合排序：`alpha·norm(bm25) + (1-alpha)·cos`。
 * 两边都出现的 chunk 两项相加；只出现在一边的，另一项记 0。
 */
export function mergeHybrid(
  ftsHits: readonly SearchHit[],
  semanticHits: readonly SearchHit[],
  alpha: number,
  k: number,
): SearchHit[] {
  const weight = Math.max(0, Math.min(1, alpha));
  const ftsNorm = normalizeScores(ftsHits.map((hit) => hit.score));
  const merged = new Map<string, { hit: SearchHit; score: number }>();

  ftsHits.forEach((hit, index) => {
    merged.set(hit.id, { hit, score: weight * (ftsNorm[index] ?? 1) });
  });
  for (const hit of semanticHits) {
    const cosine = Math.max(0, Math.min(1, hit.score));
    const existing = merged.get(hit.id);
    if (existing) existing.score += (1 - weight) * cosine;
    else merged.set(hit.id, { hit, score: (1 - weight) * cosine });
  }

  return [...merged.values()]
    .sort((a, b) => b.score - a.score || b.hit.updated_at - a.hit.updated_at)
    .slice(0, Math.max(1, k))
    .map((entry) => ({ ...entry.hit, score: entry.score }));
}

export interface SemanticLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  debug?: (message: string) => void;
}

export interface CreateSemanticOptions {
  db: Db;
  config: SemanticConfig;
  logger?: SemanticLogger;
  /** 覆盖稳态线程数（回填脚本用 backfillThreads）。 */
  threads?: number;
}

export class SemanticIndex {
  /** 上一次「完全对齐」时的变更指纹；相同就跳过整轮检查。 */
  private syncKey: string | null = null;

  private constructor(
    private readonly db: Db,
    private readonly config: SemanticConfig,
    private readonly runtime: EmbeddingRuntime,
    private readonly logger: SemanticLogger,
    private readonly dim: number,
  ) {}

  /**
   * 打开语义索引；任何一步失败都返回 `{ index: null, status }`，调用方据此退回 FTS。
   */
  static async create(options: CreateSemanticOptions): Promise<{ index: SemanticIndex | null; status: SemanticStatus }> {
    const { db, config } = options;
    const base: SemanticStatus = {
      enabled: config.enabled,
      ready: false,
      reason: null,
      vectors: 0,
      dim: config.dim,
      model: config.modelFile,
      alpha: config.alpha,
    };
    if (!config.enabled) return { index: null, status: { ...base, reason: 'disabled' } };

    const { runtime, reason } = await EmbeddingRuntime.create({
      modelDir: config.modelDir,
      modelFile: config.modelFile,
      vocabFile: config.vocabFile,
      maxLen: config.maxLen,
      batchSize: config.batchSize,
      threads: options.threads ?? config.threads,
      ...(options.logger ? { logger: options.logger } : {}),
    });
    if (!runtime) return { index: null, status: { ...base, reason } };

    const index = new SemanticIndex(db, config, runtime, options.logger ?? {}, runtime.dim);
    try {
      index.loadExtension();
      index.ensureTable();
    } catch (error) {
      await runtime.close();
      return { index: null, status: { ...base, reason: `sqlite-vec: ${(error as Error).message}` } };
    }
    const status = { ...index.status, enabled: true };
    return { index, status };
  }

  get status(): SemanticStatus {
    return {
      enabled: this.config.enabled,
      ready: true,
      reason: null,
      vectors: this.countVectors(),
      dim: this.dim,
      model: this.config.modelFile,
      alpha: this.config.alpha,
    };
  }

  /**
   * 把缺失的向量补上、把指向已删 chunk 的向量清掉。
   * @param max 本次最多补多少条（服务里每次只跑一小批，避免长时间占 CPU）
   */
  async sync(options: { max?: number } = {}): Promise<{ embedded: number; removed: number; pending: number }> {
    const max = Math.max(1, options.max ?? 64);

    // 服务里每 5 秒调一次，绝大多数时候什么都没变。全量读 chunks.text 大约 2 ms，
    // 先用一个便宜的指纹（行数 + 最大 rowid + 最后更新时间 + 向量数）判断要不要干活。
    const fingerprint = this.fingerprint();
    if (this.syncKey === fingerprint) return { embedded: 0, removed: 0, pending: 0 };

    const rows = this.db.prepare('SELECT id, text FROM chunks').all() as { id: string; text: string }[];
    const chunkIds = new Set(rows.map((row) => row.id));
    const existing = new Set(
      (this.db.prepare(`SELECT chunk_id FROM ${TABLE}`).all() as { chunk_id: string }[]).map((row) => row.chunk_id),
    );

    const orphans = [...existing].filter((id) => !chunkIds.has(id));
    if (orphans.length > 0) this.removeMany(orphans);

    const missing = rows.filter((row) => !existing.has(row.id));
    const batch = missing.slice(0, max);
    if (batch.length === 0) {
      // 一次完整的检查确认没有缺口也没孤儿：记下指纹，下一次同样状态直接返回。
      if (orphans.length === 0) this.syncKey = fingerprint;
      return { embedded: 0, removed: orphans.length, pending: 0 };
    }

    const vectors = await this.runtime.embed(batch.map((row) => row.text));
    const items: { id: string; vector: Float32Array }[] = [];
    batch.forEach((row, index) => {
      const vector = vectors[index];
      if (vector) items.push({ id: row.id, vector });
    });
    this.upsertMany(items);
    return { embedded: batch.length, removed: orphans.length, pending: Math.max(0, missing.length - batch.length) };
  }

  /** 回填到没有缺口（脚本用；服务里只跑 sync 的小批量）。 */
  async backfill(): Promise<{ embedded: number; ms: number }> {
    const started = Date.now();
    let embedded = 0;
    for (;;) {
      const result = await this.sync({ max: 256 });
      embedded += result.embedded;
      if (result.pending === 0 && result.embedded === 0) break;
    }
    return { embedded, ms: Date.now() - started };
  }

  /** 向量召回 + 混合排序；不可用时返回 null（调用方退回 FTS）。 */
  async search(params: SearchParams, k: number): Promise<SearchOutcome | null> {
    try {
      const queryText = params.semanticQuery ?? params.query;
      if (queryText.trim().length === 0) return null;
      const [queryVector] = await this.runtime.embed([queryText]);
      if (!queryVector) return null;

      const candidates = this.knn(queryVector, this.config.maxCandidates);
      const fts = searchChunks(this.db, params);
      if (candidates.length === 0) return { ...fts, hits: fts.hits.slice(0, k) };

      const rows = this.rowsByIds(candidates.map((candidate) => candidate.id), params);
      const byId = new Map(candidates.map((candidate) => [candidate.id, candidate.cosine]));
      const semanticHits: SearchHit[] = rows
        .map((row) => this.toHit(row, byId.get(row.id) ?? 0, params.maxChars))
        .sort((a, b) => b.score - a.score);

      const hits = mergeHybrid(fts.hits, semanticHits, this.config.alpha, k);
      return {
        hits,
        weak: fts.weak && semanticHits.length === 0,
        scanned: fts.scanned + candidates.length,
        keywords: fts.keywords,
      };
    } catch (error) {
      this.logger.warn?.(`semantic search failed, falling back to FTS: ${(error as Error).message}`);
      return null;
    }
  }

  async close(): Promise<void> {
    await this.runtime.close();
  }

  /* ---------------------------------------------------------------- */

  private loadExtension(): void {
    const loadable = sqliteVecPath();
    const db = this.db as unknown as { loadExtension: (path: string) => void };
    if (!loadable) throw new Error('sqlite-vec native extension not available');
    db.loadExtension(loadable);
  }

  private ensureTable(): void {
    const stored = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(DIM_META_KEY) as { value?: string } | undefined;
    const existing = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(TABLE) as { name?: string } | undefined;
    if (existing && stored?.value !== String(this.dim)) {
      // 维度变了（换模型）：向量表是派生物，直接重建，下一次 sync 会重新填。
      this.db.exec(`DROP TABLE ${TABLE}`);
    }
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${TABLE} USING vec0(chunk_id TEXT PRIMARY KEY, embedding float[${this.dim}])`,
    );
    this.db
      .prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(DIM_META_KEY, String(this.dim));
  }

  private countVectors(): number {
    try {
      const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get() as { n: number };
      return row.n;
    } catch {
      return 0;
    }
  }

  /**
   * 便宜的变更指纹：chunk 行数 + 最大 rowid + 最后更新时间 + 向量数。
   * 覆盖插入（行数/rowid 变）、删除（行数变）、重建（updated_at 变）。
   */
  private fingerprint(): string {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS n, COALESCE(MAX(rowid), 0) AS maxRowid, COALESCE(MAX(updated_at), 0) AS last FROM chunks',
      )
      .get() as { n: number; maxRowid: number; last: number };
    return `${row.n}:${row.maxRowid}:${row.last}:${this.countVectors()}`;
  }

  private knn(query: Float32Array, limit: number): { id: string; cosine: number }[] {
    const blob = new Uint8Array(query.buffer, query.byteOffset, query.byteLength);
    const rows = this.db
      .prepare(`SELECT chunk_id, distance FROM ${TABLE} WHERE embedding MATCH ? ORDER BY distance LIMIT ?`)
      .all(blob, Math.max(1, limit)) as { chunk_id: string; distance: number }[];
    return rows.map((row) => ({ id: row.chunk_id, cosine: distanceToCosine(row.distance) }));
  }

  private rowsByIds(
    ids: readonly string[],
    params: SearchParams,
  ): {
    id: string;
    path: string;
    title: string;
    heading: string | null;
    text: string;
    kind: string;
    updated_at: number;
    stage: string | null;
    expires_at: number | null;
  }[] {
    if (ids.length === 0) return [];
    const visibility = visibilityClause(params.token, params.scene, 'c', {
      ownerDisclosure: params.ownerDisclosure === true,
      ...(params.restriction ? { restriction: params.restriction } : {}),
    });
    const placeholders = ids.map(() => '?').join(', ');
    const values: (string | number)[] = [...ids, ...visibility.params];
    let sql = `SELECT c.id, c.path, c.title, c.heading, c.text, c.kind, c.updated_at, c.stage, c.expires_at
       FROM chunks c WHERE c.id IN (${placeholders}) AND ${visibility.where}`;
    if (params.kinds && params.kinds.length > 0) {
      sql += ` AND c.kind IN (${params.kinds.map(() => '?').join(', ')})`;
      values.push(...params.kinds);
    }
    if (params.pathPrefix) {
      sql += ' AND c.path LIKE ?';
      values.push(`${params.pathPrefix.replaceAll('\\', '/')}%`);
    }
    return this.db.prepare(sql).all(...values) as unknown as {
      id: string;
      path: string;
      title: string;
      heading: string | null;
      text: string;
      kind: string;
      updated_at: number;
      stage: string | null;
      expires_at: number | null;
    }[];
  }

  private toHit(
    row: {
      id: string;
      path: string;
      title: string;
      heading: string | null;
      text: string;
      kind: string;
      updated_at: number;
      stage: string | null;
      expires_at: number | null;
    },
    score: number,
    maxChars: number,
  ): SearchHit {
    const text = row.text.length > maxChars ? `${row.text.slice(0, maxChars)}…` : row.text;
    return {
      id: row.id,
      path: row.path,
      title: row.title ?? '',
      heading: row.heading ?? '',
      text,
      kind: row.kind,
      updated_at: row.updated_at,
      stage: row.stage === 'short' ? 'short' : 'long',
      expires_at: row.expires_at ?? null,
      score,
    };
  }

  private upsertMany(items: readonly { id: string; vector: Float32Array }[]): void {
    if (items.length === 0) return;
    const remove = this.db.prepare(`DELETE FROM ${TABLE} WHERE chunk_id = ?`);
    const insert = this.db.prepare(`INSERT INTO ${TABLE}(chunk_id, embedding) VALUES (?, ?)`);
    this.db.exec('BEGIN');
    try {
      for (const item of items) {
        remove.run(item.id);
        insert.run(item.id, new Uint8Array(item.vector.buffer, item.vector.byteOffset, item.vector.byteLength));
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private removeMany(ids: readonly string[]): void {
    const remove = this.db.prepare(`DELETE FROM ${TABLE} WHERE chunk_id = ?`);
    this.db.exec('BEGIN');
    try {
      for (const id of ids) remove.run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

/**
 * 语义检索的生命周期管理：持有/释放 SemanticIndex，使「开关」可以在运行中切换。
 * 关掉之后 `search()` 返回 null、`sync()` 什么也不做，调用方自然退回纯 FTS。
 */
export class SemanticManager {
  private index: SemanticIndex | null = null;
  private lastStatus: SemanticStatus;

  constructor(
    private readonly deps: { db: Db; config: SemanticConfig; logger: SemanticLogger; threads?: number },
  ) {
    this.lastStatus = {
      enabled: deps.config.enabled,
      ready: false,
      reason: deps.config.enabled ? null : 'disabled',
      vectors: 0,
      dim: deps.config.dim,
      model: deps.config.modelFile,
      alpha: deps.config.alpha,
    };
  }

  get ready(): boolean {
    return this.index !== null;
  }

  get status(): SemanticStatus {
    return this.index ? this.index.status : this.lastStatus;
  }

  /** 按配置尝试启动；失败只记录原因，不抛错（检索继续走 FTS）。 */
  async start(): Promise<SemanticStatus> {
    if (this.index) return this.index.status;
    if (!this.deps.config.enabled) {
      this.lastStatus = { ...this.lastStatus, enabled: false, ready: false, reason: 'disabled' };
      return this.lastStatus;
    }
    const opened = await SemanticIndex.create({
      db: this.deps.db,
      config: this.deps.config,
      logger: this.deps.logger,
      ...(this.deps.threads !== undefined ? { threads: this.deps.threads } : {}),
    });
    this.index = opened.index;
    this.lastStatus = opened.status;
    if (!opened.index) {
      this.deps.logger.warn?.(`semantic search unavailable: ${opened.status.reason ?? 'unknown'}`);
    }
    return this.status;
  }

  async stop(): Promise<void> {
    const index = this.index;
    this.index = null;
    await index?.close();
    this.lastStatus = { ...this.lastStatus, enabled: false, ready: false, reason: 'disabled' };
  }

  /** 运行中切换开关：开 = 建索引并先补一批向量，关 = 直接释放。 */
  async setEnabled(enabled: boolean): Promise<SemanticStatus> {
    this.deps.config.enabled = enabled;
    if (!enabled) {
      await this.stop();
      return this.status;
    }
    await this.start();
    if (this.index) {
      try {
        await this.index.sync({ max: 256 });
      } catch (error) {
        this.deps.logger.warn?.(`semantic backfill failed: ${(error as Error).message}`);
      }
    }
    return this.status;
  }

  async sync(max: number): Promise<{ embedded: number; removed: number; pending: number } | null> {
    if (!this.index) return null;
    return this.index.sync({ max });
  }

  async search(params: SearchParams, k: number): Promise<SearchOutcome | null> {
    if (!this.index) return null;
    return this.index.search(params, k);
  }

  async backfill(): Promise<{ embedded: number; ms: number } | null> {
    if (!this.index) return null;
    return this.index.backfill();
  }

  async close(): Promise<void> {
    await this.stop();
  }
}

/** sqlite-vec 的本地扩展路径；没装或平台不支持时返回 null。 */let cachedVecPath: string | null | undefined;
function sqliteVecPath(): string | null {
  if (cachedVecPath !== undefined) return cachedVecPath;
  cachedVecPath = null;
  try {
    // 变量说明符：sqlite-vec 是可选依赖，缺失时不该让 TS/打包器解析失败。
    const spec = 'sqlite-vec';
    const req = createRequire(import.meta.url);
    const mod = req(spec) as { getLoadablePath?: () => string };
    const path = mod.getLoadablePath?.();
    if (typeof path === 'string' && path.length > 0) cachedVecPath = path;
  } catch {
    cachedVecPath = null;
  }
  return cachedVecPath;
}
