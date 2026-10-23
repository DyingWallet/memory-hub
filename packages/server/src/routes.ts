import { performance } from 'node:perf_hooks';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import {
  audienceForWrite,
  canWriteAudience,
  classifyPrivacy,
  defaultPrivacy,
  extractKeywords,
  hasCapability,
  hasRootScope,
  isRestricted,
  isSensitive,
  newFactId,
  normalizeAudience,
  restrictionFor,
  sha256Hex,
  titleFrom,
  truncate,
  monthShard,
  type RestrictedPolicy,
} from '@memsvc/core';
import {
  ROUTE_SPECS,
  SETTINGS_SCHEMA,
  TErrorBody,
  routeByOperationId,
  type AudienceResponse,
  type BootstrapResponse,
  type CapabilitiesResponse,
  type ConfigResponse,
  type ConfigSchemaResponse,
  type ConfigUpdateRequest,
  type ConfigUpdateResponse,
  type ForgetRequest,
  type ForgetResponse,
  type GetResponse,
  type HealthResponse,
  type IngestRequest,
  type IngestResponse,
  type MemoryKind,
  type MemoryResult,
  type PersistResponse,
  type RecallResponse,
  type RecentResponse,
  type ReviewResponse,
  type SearchResponse,
  type TokenRevokeRequest,
  type TokenRevokeResponse,
  type TokensResponse,
  type WriteResponse,
  type TFactRecord,
} from '@memsvc/protocol';
import type { AuditLog } from './audit.js';
import { authenticate, type AuthContext } from './auth.js';
import { loadConfig, type ServerConfig } from './config.js';
import { getMeta, readStats, setMeta, type Db } from './db.js';
import { errors } from './errors.js';
import { appendFact, forgetFact, loadAudienceCard, loadIdentity, type FactRecord } from './indexer.js';
import { getChunkOrDoc, recentDocs, reviewCandidates, searchChunks, type SearchHit } from './search.js';
import { lastReviewAt, markReviewSeen, reminderSince, shouldReview } from './review.js';
import { dedupeKey, isNearDuplicate, normalizeForDedupe } from './dedupe.js';
import type { TokenStore } from './tokens.js';

export interface RouteDeps {
  config: ServerConfig;
  db: Db;
  tokens: TokenStore;
  audit: AuditLog;
  startedAt: number;
}

const ERROR_SCHEMA = TErrorBody;
const COMMON_ERROR_RESPONSES = {
  400: ERROR_SCHEMA,
  401: ERROR_SCHEMA,
  403: ERROR_SCHEMA,
  404: ERROR_SCHEMA,
  409: ERROR_SCHEMA,
  413: ERROR_SCHEMA,
  500: ERROR_SCHEMA,
};

function responseSchema(operationId: string): Record<number, unknown> {
  return { ...COMMON_ERROR_RESPONSES, 200: routeByOperationId(operationId).response };
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { config, db, tokens, audit, startedAt } = deps;

  const finish = (route: string, auth: AuthContext, started: number, ids: string[], query?: string, denied = 0): void => {
    audit.append({
      ts: new Date().toISOString(),
      token: auth.record.id,
      surface: auth.scene,
      route,
      ...(query !== undefined ? { query_hash: sha256Hex(query).slice(0, 16) } : {}),
      ids,
      denied,
      ms: Math.round(performance.now() - started),
    });
  };

  /* ---------------------------------------------------------------- */
  /* health (no auth)                                                 */
  /* ---------------------------------------------------------------- */
  app.get<{ Reply: HealthResponse }>(
    routeByOperationId('health').path,
    { schema: { response: responseSchema('health') } },
    async () => {
      const stats = readStats(db);
      return {
        ok: true,
        version: config.version,
        uptime_s: Math.round((Date.now() - startedAt) / 1000),
        index: {
          docs: stats.docs,
          facts: stats.facts,
          chunks: stats.chunks,
          ...(stats.built_at ? { built_at: stats.built_at } : {}),
        },
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* capabilities / config schema                                     */
  /* ---------------------------------------------------------------- */
  app.get<{ Reply: CapabilitiesResponse }>(
    routeByOperationId('capabilities').path,
    { schema: { response: responseSchema('capabilities') } },
    async (request) => {
      authenticate(request.headers.authorization, tokens);
      return {
        protocol: 'v1',
        version: config.version,
        tools: ['memory_bootstrap', 'memory_search', 'memory_get', 'memory_recent', 'memory_recall', 'memory_write', 'memory_call'],
        features: { images: false, documents: false, semantic: false, offline: false, short_term: true },
        limits: {
          search_default_k: config.searchDefaultK,
          search_max_k: config.searchMaxK,
          search_default_chars: config.searchDefaultChars,
          recall_max_messages: config.recallMaxMessages,
          write_max_chars: config.writeMaxChars,
        },
      };
    },
  );

  app.get<{ Reply: ConfigSchemaResponse }>(
    routeByOperationId('configSchema').path,
    { schema: { response: responseSchema('configSchema') } },
    async (request) => {
      authenticate(request.headers.authorization, tokens);
      return {
        title: '记忆服务',
        description: '客户端连接参数（配置真源在磁盘，页面只是渲染器）',
        schema: SETTINGS_SCHEMA as unknown as Record<string, unknown>,
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* runtime config update (root only; loopback settings page)        */
  /* ---------------------------------------------------------------- */
  app.get<{ Reply: ConfigResponse }>(
    routeByOperationId('getConfig').path,
    { schema: { response: responseSchema('getConfig') } },
    async (request) => {
      const auth = authenticate(request.headers.authorization, tokens);
      if (!hasRootScope(auth.view.scopes)) {
        throw errors.forbidden('root token required to read runtime config');
      }
      return {
        shortTerm: { ...config.shortTerm },
        privacy: {
          sensitiveScope: config.privacy.sensitiveScope,
          sensitiveAudiences: [...config.privacy.sensitiveAudiences],
          ownerAudiences: [...config.privacy.ownerAudiences],
        },
        archive: { ...config.archive },
      };
    },
  );

  app.post<{ Body: ConfigUpdateRequest; Reply: ConfigUpdateResponse }>(
    routeByOperationId('updateConfig').path,
    {
      schema: {
        body: routeByOperationId('updateConfig').request,
        response: responseSchema('updateConfig'),
      },
    },
    async (request) => {
      const auth = authenticate(request.headers.authorization, tokens);
      if (!hasRootScope(auth.view.scopes)) {
        throw errors.forbidden('root token required to change runtime config');
      }
      const patch = request.body ?? {};
      const merged = { ...config.shortTerm, ...(patch.shortTerm ?? {}) };
      if (merged.maxTtlHours < merged.ttlHours) {
        throw errors.invalid('maxTtlHours must be >= ttlHours');
      }

      const currentRaw = existsSync(config.configFile)
        ? JSON.parse(readFileSync(config.configFile, 'utf8')) as Record<string, unknown>
        : {};
      const next: Record<string, unknown> = { ...currentRaw };
      if (patch.shortTerm) next.shortTerm = { ...(currentRaw.shortTerm as object ?? {}), ...patch.shortTerm };
      if (patch.privacy) {
        const privacy: Record<string, unknown> = { ...(currentRaw.privacy as object ?? {}) };
        if (patch.privacy.sensitiveScope !== undefined) privacy.sensitiveScope = patch.privacy.sensitiveScope;
        if (patch.privacy.sensitiveAudiences !== undefined) privacy.sensitiveAudiences = patch.privacy.sensitiveAudiences;
        if (patch.privacy.ownerAudiences !== undefined) privacy.ownerAudiences = patch.privacy.ownerAudiences;
        next.privacy = privacy;
      }
      if (patch.archive) {
        next.archive = { ...(currentRaw.archive as object ?? {}), ...patch.archive };
      }

      const backup = `${config.configFile}.bak-${Date.now()}`;
      if (existsSync(config.configFile)) writeFileSync(backup, readFileSync(config.configFile));
      writeFileSync(config.configFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');

      try {
        const fresh = loadConfig({ configFile: config.configFile });
        config.shortTerm = fresh.shortTerm;
        config.privacy = fresh.privacy;
        config.archive = fresh.archive;
      } catch (error) {
        if (existsSync(backup)) writeFileSync(config.configFile, readFileSync(backup));
        throw errors.invalid(`config rejected: ${(error as Error).message}`);
      }

      const applied = [
        ...Object.keys(patch.shortTerm ?? {}).map((key) => `shortTerm.${key}`),
        ...Object.keys(patch.privacy ?? {}).map((key) => `privacy.${key}`),
        ...Object.keys(patch.archive ?? {}).map((key) => `archive.${key}`),
      ];
      return { ok: true, applied };
    },
  );

  /* ---------------------------------------------------------------- */
  /* token management (root only; issuing stays in the admin CLI)     */
  /* ---------------------------------------------------------------- */
  app.get<{ Reply: TokensResponse }>(
    routeByOperationId('getTokens').path,
    { schema: { response: responseSchema('getTokens') } },
    async (request) => {
      const auth = authenticate(request.headers.authorization, tokens);
      if (!hasRootScope(auth.view.scopes)) {
        throw errors.forbidden('root token required to list tokens');
      }
      return {
        tokens: tokens.list().map((record) => ({
          id: record.id,
          name: record.name,
          surface: record.surface,
          scenes: record.scenes,
          scopes: record.scopes,
          created_at: record.created_at,
          revoked_at: record.revoked_at ?? null,
          ...(record.last_used_at ? { last_used_at: record.last_used_at } : {}),
        })),
      };
    },
  );

  app.post<{ Body: TokenRevokeRequest; Reply: TokenRevokeResponse }>(
    routeByOperationId('revokeToken').path,
    {
      schema: {
        body: routeByOperationId('revokeToken').request,
        response: responseSchema('revokeToken'),
      },
    },
    async (request) => {
      const auth = authenticate(request.headers.authorization, tokens);
      if (!hasRootScope(auth.view.scopes)) {
        throw errors.forbidden('root token required to revoke tokens');
      }
      const revoked = tokens.revoke(request.body.id);
      if (!revoked) throw errors.notFound(`no token with id ${request.body.id}`);
      return { ok: true, id: revoked.id };
    },
  );

  /* ---------------------------------------------------------------- */
  /* bootstrap                                                        */
  /* ---------------------------------------------------------------- */
  app.post<{ Body: { surface?: string; scene?: string }; Reply: BootstrapResponse }>(
    routeByOperationId('bootstrap').path,
    {
      schema: {
        body: routeByOperationId('bootstrap').request,
        response: responseSchema('bootstrap'),
      },
    },
    async (request) => {
      const started = performance.now();
      const auth = authenticate(request.headers.authorization, tokens, request.body?.scene);
      const identity = loadIdentity(config);
      const card = loadAudienceCard(config, auth.scene);
      const recent = recentDocs(
        db,
        auth.view,
        auth.scene,
        5,
        undefined,
        restrictionFor(auth.view.scopes, auth.scene, config.privacy),
      );
      const stats = readStats(db);

      finish('bootstrap', auth, started, recent.map((doc) => doc.id));

      return {
        identity: truncate(identity, 300),
        audience: {
          id: card.id,
          face: truncate(card.face, 300),
          ...(card.name ? { name: card.name } : {}),
          ...(card.kind ? { kind: card.kind } : {}),
          ...(card.relationship ? { relationship: card.relationship } : {}),
          ...(card.boundaries ? { boundaries: card.boundaries } : {}),
          ...(card.known ? { known: card.known } : {}),
        },
        recent: recent.map((doc) => ({
          id: doc.id,
          title: doc.title,
          kind: doc.kind as MemoryKind,
          updated_at: new Date(doc.updated_at).toISOString(),
        })),
        counts: { docs: stats.docs, facts: stats.facts },
        instructions: config.instructions,
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* search                                                           */
  /* ---------------------------------------------------------------- */
  app.post<{
    Body: { query: string; k?: number; scene?: string; kinds?: MemoryKind[]; path_prefix?: string; max_chars?: number };
    Reply: SearchResponse;
  }>(
    routeByOperationId('search').path,
    {
      schema: {
        body: routeByOperationId('search').request,
        response: responseSchema('search'),
      },
    },
    async (request) => {
      const started = performance.now();
      const body = request.body;
      const auth = authenticate(request.headers.authorization, tokens, body.scene);
      const k = clamp(body.k ?? config.searchDefaultK, 1, config.searchMaxK);
      const restriction = restrictionFor(auth.view.scopes, auth.scene, config.privacy);
      const outcome = searchChunks(db, {
        query: body.query,
        k,
        maxChars: clamp(body.max_chars ?? config.searchDefaultChars, 40, 6000),
        token: auth.view,
        scene: auth.scene,
        restriction,
        ...(body.kinds ? { kinds: body.kinds } : {}),
        ...(body.path_prefix ? { pathPrefix: body.path_prefix } : {}),
      });
      finish('search', auth, started, outcome.hits.map((hit) => hit.id), body.query);
      return {
        query: body.query,
        results: outcome.hits.map((hit) => toMemoryResult(hit)),
        weak: outcome.weak,
        scanned: outcome.scanned,
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* get                                                              */
  /* ---------------------------------------------------------------- */
  app.post<{ Body: { id: string; scene?: string; max_chars?: number }; Reply: GetResponse }>(
    routeByOperationId('get').path,
    {
      schema: {
        body: routeByOperationId('get').request,
        response: responseSchema('get'),
      },
    },
    async (request) => {
      const started = performance.now();
      const auth = authenticate(request.headers.authorization, tokens, request.body.scene);
      const hit = getChunkOrDoc(
        db,
        request.body.id,
        auth.view,
        auth.scene,
        clamp(request.body.max_chars ?? 4000, 40, 20000),
        restrictionFor(auth.view.scopes, auth.scene, config.privacy),
      );
      finish('get', auth, started, hit ? [hit.id] : [], undefined, hit ? 0 : 1);
      if (!hit) throw errors.notFound('memory not found or not visible in this scene');
      return { memory: toMemoryResult(hit) };
    },
  );

  /* ---------------------------------------------------------------- */
  /* recent                                                           */
  /* ---------------------------------------------------------------- */
  app.post<{ Body: { k?: number; scene?: string; kinds?: MemoryKind[] }; Reply: RecentResponse }>(
    routeByOperationId('recent').path,
    {
      schema: {
        body: routeByOperationId('recent').request,
        response: responseSchema('recent'),
      },
    },
    async (request) => {
      const started = performance.now();
      const auth = authenticate(request.headers.authorization, tokens, request.body.scene);
      const docs = recentDocs(
        db,
        auth.view,
        auth.scene,
        clamp(request.body.k ?? 5, 1, 10),
        request.body.kinds,
        restrictionFor(auth.view.scopes, auth.scene, config.privacy),
      );
      finish('recent', auth, started, docs.map((doc) => doc.id));
      return { results: docs.map(docToMemoryResult) };
    },
  );

  /* ---------------------------------------------------------------- */
  /* recall                                                           */
  /* ---------------------------------------------------------------- */
  app.post<{
    Body: {
      messages: { role: string; text: string; from_owner?: boolean }[];
      k?: number;
      scene?: string;
      max_chars?: number;
    };
    Reply: RecallResponse;
  }>(
    routeByOperationId('recall').path,
    {
      schema: {
        body: routeByOperationId('recall').request,
        response: responseSchema('recall'),
      },
    },
    async (request) => {
      const started = performance.now();
      const body = request.body;
      const auth = authenticate(request.headers.authorization, tokens, body.scene);
      const messages = body.messages.slice(-2);
      const keywords = extractKeywords(messages.map((message) => message.text).join('\n'), 6);
      const k = clamp(body.k ?? 3, 1, 5);
      if (keywords.length === 0) {
        finish('recall', auth, started, []);
        return { keywords: [], results: [] };
      }
      const searchParams = {
        query: keywords.join(' '),
        k,
        maxChars: clamp(body.max_chars ?? 300, 40, 1000),
        token: auth.view,
        scene: auth.scene,
        restriction: restrictionFor(auth.view.scopes, auth.scene, config.privacy),
      };
      // Owner-initiated disclosure: when the memory's owner themself brings the
      // topic up in this scene, the owner's own memories become readable here.
      // Other people's private scopes and work material stay closed (visibility.ts).
      const ownerSaid = body.messages.some((message) => message.from_owner === true);
      let results: MemoryResult[];
      if (ownerSaid && !hasRootScope(auth.view.scopes)) {
        const base = searchChunks(db, searchParams);
        const wide = searchChunks(db, { ...searchParams, ownerDisclosure: true });
        const baseIds = new Set(base.hits.map((hit) => hit.id));
        results = wide.hits.map((hit) =>
          toMemoryResult(hit, baseIds.has(hit.id) ? undefined : 'owner_initiated'),
        );
      } else {
        results = searchChunks(db, searchParams).hits.map((hit) => toMemoryResult(hit));
      }
      touchShortTerm(
        db,
        results.filter((result) => result.stage === 'short').map((result) => result.id),
        config,
      );
      const shortCount = (
        db
          .prepare("SELECT COUNT(*) AS n FROM docs WHERE stage = 'short' AND scene = ? AND (expires_at IS NULL OR expires_at > ?)")
          .get(auth.scene, Date.now()) as { n: number }
      ).n;
      const lastReview = lastReviewAt(db, auth.scene);
      const reminder = reminderSince(db, auth.scene);
      const shouldReviewNow = shouldReview(db, auth.scene, config.shortTerm.reviewIntervalHours, shortCount > 0);
      finish('recall', auth, started, results.map((result) => result.id));
      return {
        keywords,
        results,
        review: {
          should_review: shouldReviewNow,
          ...(reminder ? { reminder_since: reminder } : {}),
          ...(lastReview > 0 ? { last_reviewed_at: new Date(lastReview).toISOString() } : {}),
        },
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* write                                                            */
  /* ---------------------------------------------------------------- */
  app.post<{
    Body: {
      kind: MemoryKind;
      text: string;
      tags?: string[];
      audience?: string[];
      privacy?: 'normal' | 'personal' | 'work' | 'financial' | 'secret';
      source?: 'main' | 'qq' | 'import' | 'work';
      scene?: string;
      supersedes?: string;
      stage?: 'short' | 'long';
      expires_at?: string;
      source_message_id?: string;
      meta?: Record<string, unknown>;
      idempotency_key?: string;
    };
    Reply: WriteResponse;
  }>(
    routeByOperationId('write').path,
    {
      schema: {
        body: routeByOperationId('write').request,
        response: responseSchema('write'),
      },
    },
    async (request) => {
      const started = performance.now();
      const body = request.body;
      const auth = authenticate(request.headers.authorization, tokens, body.scene);

      if (body.text.length > config.writeMaxChars) {
        throw errors.tooLarge(`text exceeds ${config.writeMaxChars} characters`);
      }
      if (body.privacy === 'secret') {
        throw errors.forbidden('secret memories are not written through the API in v1');
      }

      const idempotencyKey = body.idempotency_key ?? null;
      if (idempotencyKey) {
        const existing = getMeta(db, `idem:${idempotencyKey}`);
        if (existing) {
          finish('write', auth, started, [existing], undefined, 1);
          return { id: existing, indexed: false, duplicate: true };
        }
      }

      const privacy = body.privacy ?? defaultPrivacy(body.kind, body.source);
      if (!isKnownPrivacy(privacy)) {
        throw errors.invalid(`unknown privacy "${privacy}" (normal | personal | sensitive | secret)`);
      }
      if (isSensitive(privacy) && !hasCapability(auth.view.scopes, config.privacy)) {
        throw errors.forbidden(`${config.privacy.sensitiveScope} scope required to write "${privacy}" memories`);
      }
      const audience = audienceForWrite(body.audience, body.kind, privacy, auth.scene, config.privacy);
      if (!canWriteAudience(auth.view, audience)) {
        throw errors.forbidden(`this token may not write to audience ${JSON.stringify(audience)}`);
      }

      // Cheap content de-duplication: same scene/kind/text/audience/privacy
      // reuses the previous id instead of appending a duplicate JSONL row.
      const contentKey = dedupeKey([
        'fact',
        auth.scene,
        body.kind,
        normalizeForDedupe(body.text),
        [...audience].sort().join(','),
        privacy,
      ]);
      const dedupeMeta = `dedupe:${contentKey}`;
      const existingId = getMeta(db, dedupeMeta);
      if (existingId) {
        const alive = db.prepare('SELECT 1 FROM docs WHERE id = ?').get(existingId);
        if (alive) {
          finish('write', auth, started, [existingId], undefined, 1);
          return { id: existingId, indexed: false, duplicate: true };
        }
      }

      const now = Date.now();
      const record: FactRecord = {
        schema_version: 1,
        id: newFactId(now),
        ts: new Date(now).toISOString(),
        kind: body.kind,
        text: body.text,
        ...(body.tags ? { tags: body.tags } : {}),
        audience,
        privacy,
        source: body.source ?? (auth.scene === 'main' ? 'main' : 'qq'),
        device: 'memd',
        scene: auth.scene,
        ...(body.supersedes ? { supersedes: body.supersedes } : {}),
        ...(body.meta ? { meta: body.meta } : {}),
      };

      if (body.stage === 'short') {
        const expiresAt = body.expires_at
          ? new Date(body.expires_at).getTime()
          : Date.now() + config.shortTerm.ttlHours * 3_600_000;
        record.stage = 'short';
        record.expires_at = new Date(expiresAt).toISOString();
        record.recall_count = 0;
      }
      if (body.source_message_id) record.source_message_id = body.source_message_id;

      const { indexed } = appendFact(db, config, record as TFactRecord);
      setMeta(db, dedupeMeta, record.id);
      if (idempotencyKey) setMeta(db, `idem:${idempotencyKey}`, record.id);
      finish('write', auth, started, [record.id]);

      return { id: record.id, indexed, duplicate: false };
    },
  );

  /* ---------------------------------------------------------------- */
  /* forget (tombstone)                                               */
  /* ---------------------------------------------------------------- */
  app.post<{ Body: ForgetRequest; Reply: ForgetResponse }>(
    routeByOperationId('forget').path,
    {
      schema: {
        body: routeByOperationId('forget').request,
        response: responseSchema('forget'),
      },
    },
    async (request) => {
      const started = performance.now();
      const auth = authenticate(request.headers.authorization, tokens);
      const body = request.body ?? {};
      const id = body.id ?? (body.idempotency_key ? getMeta(db, `idem:${body.idempotency_key}`) : undefined);
      if (!id) {
        finish('forget', auth, started, [], undefined, 1);
        return { forgotten: [], missing: [] };
      }

      const doc = db.prepare("SELECT scene, doc_type FROM docs WHERE id = ?").get(id) as
        | { scene?: string; doc_type?: string }
        | undefined;
      if (!doc || doc.doc_type !== 'fact') {
        finish('forget', auth, started, [], undefined, 1);
        return { forgotten: [], missing: [id] };
      }
      const root = hasRootScope(auth.view.scopes);
      if (!root && doc.scene !== auth.scene) {
        throw errors.forbidden(`this token may not forget facts in scene ${JSON.stringify(doc.scene)}`);
      }

      const forgotten = forgetFact(db, config, id);
      finish('forget', auth, started, forgotten ? [id] : [], undefined, forgotten ? 0 : 1);
      return { forgotten: forgotten ? [id] : [], missing: forgotten ? [] : [id] };
    },
  );

  /* ---------------------------------------------------------------- */
  /* short-term chat: ingest / review / persist                        */
  /* ---------------------------------------------------------------- */
  app.post<{ Body: IngestRequest; Reply: IngestResponse }>(
    routeByOperationId('ingest').path,
    {
      schema: {
        body: routeByOperationId('ingest').request,
        response: responseSchema('ingest'),
      },
    },
    async (request) => {
      const started = performance.now();
      const body = request.body;
      const auth = authenticate(request.headers.authorization, tokens, body.scene);
      if (!config.shortTerm.enabled) throw errors.forbidden('short-term memory is disabled in the server config');

      const now = Date.now();
      const ttlHours = clamp(body.ttl_hours ?? config.shortTerm.ttlHours, 0.1, config.shortTerm.maxTtlHours);
      const expiresAt = Math.min(now + ttlHours * 3_600_000, now + config.shortTerm.maxTtlHours * 3_600_000);
      const audience = normalizeAudience(undefined, 'chat', auth.scene);
      let written = 0;
      let skipped = 0;

      for (const message of body.messages) {
        const text = String(message.text ?? '').trim();
        if (text.length === 0) {
          skipped += 1;
          continue;
        }
        const id = message.message_id
          ? `chat:${auth.scene}:${sha256Hex(String(message.message_id)).slice(0, 16)}`
          : `chat:${auth.scene}:${sha256Hex(`${text}\u0000${now}\u0000${Math.random()}`).slice(0, 16)}`;
        const exists = db.prepare('SELECT 1 FROM docs WHERE id = ?').get(id);
        if (exists) {
          skipped += 1;
          continue;
        }
        const record: FactRecord = {
          schema_version: 1,
          id,
          ts: new Date(now).toISOString(),
          kind: 'chat',
          text,
          audience,
          privacy: 'normal',
          source: auth.scene === 'main' ? 'main' : 'qq',
          device: 'memd',
          scene: auth.scene,
          stage: 'short',
          expires_at: new Date(expiresAt).toISOString(),
          recall_count: 0,
          ...(message.message_id ? { source_message_id: String(message.message_id) } : {}),
        };
        appendFact(db, config, record as TFactRecord);
        written += 1;
      }

      finish('ingest', auth, started, [], undefined, skipped);
      return { written, skipped };
    },
  );

  app.post<{
    Body: { scene?: string; lookback_hours?: number; limit?: number; status_only?: boolean };
    Reply: ReviewResponse;
  }>(
    routeByOperationId('review').path,
    {
      schema: {
        body: routeByOperationId('review').request,
        response: responseSchema('review'),
      },
    },
    async (request) => {
      const started = performance.now();
      const body = request.body;
      const auth = authenticate(request.headers.authorization, tokens, body.scene);
      const lookbackHours = clamp(body.lookback_hours ?? config.shortTerm.reviewLookbackHours, 1, 24 * 14);
      const limit = clamp(body.limit ?? config.shortTerm.reviewLimit, 1, 100);
      const candidates = reviewCandidates(
        db,
        auth.view,
        auth.scene,
        restrictionFor(auth.view.scopes, auth.scene, config.privacy),
        { lookbackMs: lookbackHours * 3_600_000, limit },
      );
      const lastReview = lastReviewAt(db, auth.scene);
      const reminder = reminderSince(db, auth.scene);
      const shouldReviewNow = shouldReview(db, auth.scene, config.shortTerm.reviewIntervalHours, candidates.length > 0);
      if (!body.status_only && candidates.length > 0) {
        // Looking at the list counts as "reviewed"; the reminder clears so the
        // next wake does not nag again until the interval elapses.
        markReviewSeen(db, auth.scene);
      }

      finish('review', auth, started, candidates.map((candidate) => candidate.id));
      return {
        should_review: shouldReviewNow,
        ...(reminder ? { reminder_since: reminder } : {}),
        ...(lastReview > 0 ? { last_reviewed_at: new Date(lastReview).toISOString() } : {}),
        counts: { short: candidates.length, reviewable: candidates.length },
        results: body.status_only
          ? []
          : candidates.map((candidate) => ({
              id: candidate.id,
              title: candidate.title,
              kind: candidate.kind as MemoryKind,
              render: { type: 'text' as const, text: candidate.text },
              updated_at: new Date(candidate.updated_at).toISOString(),
              stage: 'short' as const,
              ...(candidate.expires_at ? { expires_at: new Date(candidate.expires_at).toISOString() } : {}),
            })),
      };
    },
  );

  app.post<{
    Body: { ids: string[]; note?: { kind?: MemoryKind; text: string; tags?: string[] } };
    Reply: PersistResponse;
  }>(
    routeByOperationId('persist').path,
    {
      schema: {
        body: routeByOperationId('persist').request,
        response: responseSchema('persist'),
      },
    },
    async (request) => {
      const started = performance.now();
      const body = request.body;
      const auth = authenticate(request.headers.authorization, tokens);
      const restriction = restrictionFor(auth.view.scopes, auth.scene, config.privacy);
      const now = Date.now();
      const persisted: string[] = [];
      const merged: { from: string; into: string }[] = [];

      // Long-term facts visible in this scene are candidates for folding.
      const longCandidates = db
        .prepare(
          `SELECT doc_id, text, audience, privacy FROM chunks
            WHERE stage = 'long' AND scene = ? ORDER BY updated_at DESC LIMIT 500`,
        )
        .all(auth.scene) as { doc_id: string; text: string; audience: string; privacy: string }[];

      for (const id of body.ids) {
        const hit = getChunkOrDoc(db, id, auth.view, auth.scene, 2000, restriction);
        if (!hit) continue;
        const row = db
          .prepare('SELECT doc_id, text, audience, privacy FROM chunks WHERE doc_id = ? LIMIT 1')
          .get(id) as { doc_id: string; text: string; audience: string; privacy: string } | undefined;
        if (!row) continue;

        const duplicate = longCandidates.find(
          (candidate) =>
            candidate.doc_id !== id &&
            candidate.privacy === row.privacy &&
            candidate.audience === row.audience &&
            isNearDuplicate(candidate.text, row.text),
        );
        if (duplicate) {
          // Fold: tombstone the short copy, keep the existing long-term fact.
          forgetFact(db, config, id);
          merged.push({ from: id, into: duplicate.doc_id });
          continue;
        }

        db.prepare("UPDATE docs SET stage = 'long', expires_at = NULL, persisted_at = ? WHERE id = ?").run(now, id);
        db.prepare("UPDATE chunks SET stage = 'long', expires_at = NULL WHERE doc_id = ?").run(id);
        persisted.push(id);
        longCandidates.push({ ...row, doc_id: id, text: hit.text });
      }

      let noteId: string | undefined;
      if (body.note && body.note.text.trim().length > 0) {
        const note: FactRecord = {
          schema_version: 1,
          id: newFactId(now),
          ts: new Date(now).toISOString(),
          kind: body.note.kind ?? 'note',
          text: body.note.text.trim(),
          audience: normalizeAudience(undefined, body.note.kind ?? 'note', auth.scene),
          privacy: 'normal',
          source: auth.scene === 'main' ? 'main' : 'qq',
          device: 'memd',
          scene: auth.scene,
          stage: 'long',
          ...(body.note.tags ? { tags: body.note.tags } : {}),
        };
        appendFact(db, config, note as TFactRecord);
        noteId = note.id;
      }

      markReviewSeen(db, auth.scene, now);
      finish('persist', auth, started, persisted);
      return {
        persisted,
        ...(merged.length > 0 ? { merged } : {}),
        ...(noteId ? { note_id: noteId } : {}),
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* audience                                                         */
  /* ---------------------------------------------------------------- */
  app.post<{ Body: { scene?: string }; Reply: AudienceResponse }>(
    routeByOperationId('audience').path,
    {
      schema: {
        body: routeByOperationId('audience').request,
        response: responseSchema('audience'),
      },
    },
    async (request) => {
      const started = performance.now();
      const auth = authenticate(request.headers.authorization, tokens, request.body?.scene);
      const card = loadAudienceCard(config, auth.scene);
      finish('audience', auth, started, []);
      return {
        audience: {
          id: card.id,
          face: truncate(card.face, 300),
          ...(card.name ? { name: card.name } : {}),
          ...(card.kind ? { kind: card.kind } : {}),
          ...(card.relationship ? { relationship: card.relationship } : {}),
          ...(card.boundaries ? { boundaries: card.boundaries } : {}),
          ...(card.known ? { known: card.known } : {}),
        },
      };
    },
  );

  // Fail fast if someone registers a route that the contract does not know.
  // `hasRoute` is used instead of parsing printRoutes(): the radix tree compresses
  // shared prefixes (/v1/config vs /v1/config-schema), so substring checks lie.
  for (const route of ROUTE_SPECS) {
    if (!app.hasRoute({ method: route.method, url: route.path })) {
      throw new Error(`route ${route.method} ${route.path} is declared in ROUTE_SPECS but not registered`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function isKnownPrivacy(label: string): boolean {
  return label === 'normal' || label === 'personal' || label === 'sensitive' || label === 'secret';
}

function toMemoryResult(hit: SearchHit, disclosure?: 'owner_initiated'): MemoryResult {
  return {
    id: hit.id,
    // Prefer the document title; the section heading is carried separately.
    title: hit.title || hit.heading || titleFrom(hit.text),
    kind: hit.kind as MemoryKind,
    render: { type: 'text', text: hit.text },
    path: hit.path,
    ...(hit.heading.length > 0 ? { heading: hit.heading } : {}),
    updated_at: new Date(hit.updated_at).toISOString(),
    score: Math.round(hit.score * 1e4) / 1e4,
    stage: hit.stage,
    ...(hit.expires_at ? { expires_at: new Date(hit.expires_at).toISOString() } : {}),
    ...(disclosure ? { disclosure } : {}),
  };
}

/**
 * Forgetting curve: every recall strengthens a short-term memory. The interval
 * doubles with each recall (spacing effect) and is capped by `maxTtlHours`.
 */
function touchShortTerm(db: Db, ids: string[], config: ServerConfig): void {
  if (!config.shortTerm.enabled || ids.length === 0) return;
  const now = Date.now();
  const base = config.shortTerm.ttlHours * 3_600_000;
  const cap = config.shortTerm.maxTtlHours * 3_600_000;
  const read = db.prepare("SELECT recall_count FROM docs WHERE id = ? AND stage = 'short'");
  const updateDocs = db.prepare('UPDATE docs SET recall_count = ?, expires_at = ? WHERE id = ?');
  const updateChunks = db.prepare('UPDATE chunks SET expires_at = ? WHERE doc_id = ?');
  for (const id of ids) {
    const row = read.get(id) as { recall_count?: number } | undefined;
    if (!row) continue;
    const count = (row.recall_count ?? 0) + 1;
    const expiresAt = Math.min(now + base * 2 ** count, now + cap);
    updateDocs.run(count, expiresAt, id);
    updateChunks.run(expiresAt, id);
  }
}

function docToMemoryResult(doc: { id: string; title: string; kind: string; updated_at: number; text: string }): MemoryResult {
  return {
    id: doc.id,
    title: doc.title,
    kind: doc.kind as MemoryKind,
    render: { type: 'text', text: truncate(doc.text, 400) },
    updated_at: new Date(doc.updated_at).toISOString(),
  };
}

export function monthFileFor(ts: string): string {
  return `facts/${monthShard(ts)}.jsonl`;
}
