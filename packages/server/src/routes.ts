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
  type DiscloseRequest,
  type DiscloseResponse,
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
  type TimelineItem,
  type TimelineRequest,
  type TimelineResponse,
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
import { getChunkOrDoc, liveMessages, recentDocs, reviewCandidates, searchChunks, timelineDocs, type SearchHit } from './search.js';
import { cleanIngestText } from './ingest-filter.js';
import { lastReviewAt, markReviewSeen, reminderSince, shouldReview } from './review.js';
import { visibilityClause } from './visibility.js';
import { dedupeKey, isNearDuplicate, normalizeForDedupe } from './dedupe.js';
import type { SemanticManager } from './semantic.js';
import type { TokenStore } from './tokens.js';

export interface RouteDeps {
  config: ServerConfig;
  db: Db;
  tokens: TokenStore;
  audit: AuditLog;
  startedAt: number;
  /** 语义检索（可选）。`ready === false` 时所有调用都返回 null，检索退回纯 FTS。 */
  semantic: SemanticManager;
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
  const { config, db, tokens, audit, startedAt, semantic } = deps;

  /**
   * 检索入口：语义可用时走混合排序，否则/失败时退回纯 FTS。
   * 语义关闭或不可用是**正常状态**，不记错、不影响可用性。
   */
  const runSearch = async (params: Parameters<typeof searchChunks>[1], k: number) => {
    if (semantic.ready) {
      const hybrid = await semantic.search(params, k);
      if (hybrid) return hybrid;
    }
    return searchChunks(db, params);
  };

  const finish = (
    route: string,
    auth: AuthContext,
    started: number,
    ids: string[],
    query?: string,
    denied = 0,
    extras: { group?: string; requester_hash?: string } = {},
  ): void => {
    audit.append({
      ts: new Date().toISOString(),
      token: auth.record.id,
      surface: auth.scene,
      route,
      ...(query !== undefined ? { query_hash: sha256Hex(query).slice(0, 16) } : {}),
      ids,
      denied,
      ms: Math.round(performance.now() - started),
      ...(extras.group ? { group: extras.group } : {}),
      ...(extras.requester_hash ? { requester_hash: extras.requester_hash } : {}),
    });
  };

  /**
   * 跨场景披露：群友在私聊里问「刚才群里聊了什么」。
   * 成员校验在桥接侧做（它才有 QQ 成员表），这里只认 `disclose:group` scope，
   * 并再收一次口径：只给这一个群的 chat/note、只给 normal/personal、绝不含敏感与 secret。
   */
  app.post<{ Body: DiscloseRequest; Reply: DiscloseResponse }>(
    routeByOperationId('disclose').path,
    {
      schema: {
        body: routeByOperationId('disclose').request,
        response: responseSchema('disclose'),
      },
    },
    async (request) => {
      const started = performance.now();
      const body = request.body;
      const auth = authenticate(request.headers.authorization, tokens);
      if (!auth.view.scopes.includes('disclose:group')) {
        throw errors.forbidden('disclose:group scope required');
      }
      const groupId = String(body.group).replace(/^qq:group:/, '').trim();
      if (!/^\d{4,20}$/.test(groupId)) throw errors.invalid('group must be a QQ group id');
      const requester = String(body.requester).trim();
      if (!/^\d{4,20}$/.test(requester)) throw errors.invalid('requester must be a QQ number');
      const sinceHours = clamp(body.since_hours ?? 24, 1, 24 * 7);
      const k = clamp(body.k ?? 8, 1, 20);
      const since = Date.now() - sinceHours * 3_600_000;

      const rows = db
        .prepare(
          `SELECT c.id, c.path, c.title, c.heading, c.text, c.kind, c.updated_at, c.stage, c.expires_at
             FROM chunks c
            WHERE c.scene = ?
              AND c.kind IN ('chat', 'note')
              AND c.privacy IN ('normal', 'personal')
              AND (c.expires_at IS NULL OR c.expires_at > ?)
              AND c.updated_at >= ?
            ORDER BY c.updated_at DESC
            LIMIT ?`,
        )
        .all(`qq:group:${groupId}`, Date.now(), since, k) as {
        id: string;
        path: string;
        title: string;
        heading: string | null;
        text: string;
        kind: string;
        updated_at: number;
        stage: string;
        expires_at: number | null;
      }[];

      const results: MemoryResult[] = rows.map((row) => ({
        id: row.id,
        title: row.title,
        kind: row.kind as MemoryKind,
        render: { type: 'text' as const, text: row.text },
        path: row.path,
        ...(row.heading ? { heading: row.heading } : {}),
        updated_at: new Date(row.updated_at).toISOString(),
        stage: row.stage as 'short' | 'long',
        ...(row.expires_at ? { expires_at: new Date(row.expires_at).toISOString() } : {}),
      }));

      finish('disclose', auth, started, results.map((result) => result.id), undefined, 0, {
        group: `qq:group:${groupId}`,
        requester_hash: sha256Hex(requester).slice(0, 16),
      });
      return { group: `qq:group:${groupId}`, since_hours: sinceHours, count: results.length, results };
    },
  );

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
        features: { images: false, documents: false, semantic: semantic.ready, offline: false, short_term: true },
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
        semantic: semantic.status,
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
      if (patch.semantic) {
        next.semantic = { ...(currentRaw.semantic as object ?? {}), ...patch.semantic };
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
        ...Object.keys(patch.semantic ?? {}).map((key) => `semantic.${key}`),
      ];
      // 语义开关即时生效：开 = 建索引并先补一批向量，关 = 释放模型与向量表连接。
      if (patch.semantic && typeof patch.semantic.enabled === 'boolean') {
        const status = await semantic.setEnabled(patch.semantic.enabled);
        request.log.info({ semantic: status }, 'semantic toggled');
      }
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
      const restriction = restrictionFor(auth.view.scopes, auth.scene, config.privacy);
      const recent = recentDocs(db, auth.view, auth.scene, 5, undefined, restriction);
      // The assistant's own recent judgements, so a fresh session starts with
      // "what I thought last time", not only with facts about the owner.
      const self = recentDocs(db, auth.view, auth.scene, 3, undefined, restriction, 'self');
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
        self: self.map((doc) => ({
          id: doc.id,
          title: doc.title,
          kind: doc.kind as MemoryKind,
          updated_at: new Date(doc.updated_at).toISOString(),
          // A title alone reads like a headline; the excerpt is what makes
          // "what I thought last time" actually usable in a fresh session.
          text: truncate(doc.text, 140),
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
    Body: { query: string; k?: number; scene?: string; kinds?: MemoryKind[]; path_prefix?: string; max_chars?: number; subject?: 'owner' | 'self' | 'other' };
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
      const outcome = await runSearch({
        query: body.query,
        k,
        maxChars: clamp(body.max_chars ?? config.searchDefaultChars, 40, 6000),
        token: auth.view,
        scene: auth.scene,
        restriction,
        ...(body.kinds ? { kinds: body.kinds } : {}),
        ...(body.path_prefix ? { pathPrefix: body.path_prefix } : {}),
        ...(body.subject ? { subject: body.subject } : {}),
      }, k);
      finish('search', auth, started, outcome.hits.map((hit) => hit.id), body.query);
      return {
        query: body.query,
        results: markSuperseded(db, outcome.hits.map((hit) => toMemoryResult(hit))),
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
      scope?: 'scene' | 'groups';
      since_hours?: number;
      live?: { k?: number; minutes?: number; scenes?: string[] };
      subject?: 'owner' | 'self' | 'other';
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

      // "Live" side channel: the newest short-term chat, so a surface that
      // was not part of the conversation (the pet) can tell what the main
      // session is in the middle of. Same visibility SQL, same privacy.
      const live = body.live
        ? liveMessages(
            db,
            auth.view,
            auth.scene,
            restrictionFor(auth.view.scopes, auth.scene, config.privacy),
            {
              minutes: clamp(body.live.minutes ?? 30, 1, 24 * 60),
              k: clamp(body.live.k ?? 6, 1, 12),
              scenes: body.live.scenes,
            },
          )
        : undefined;
      const liveResults: MemoryResult[] | undefined = live?.map((row) => ({
        id: row.id,
        title: titleFrom(row.text),
        kind: 'chat' as MemoryKind,
        render: { type: 'text' as const, text: row.text },
        updated_at: new Date(row.updated_at).toISOString(),
        stage: 'short' as const,
      }));

      // Owner-only recency fallback for vague questions ("今天群聊了什么").
      // FTS cannot match meta questions, so return the actual recent messages
      // instead; the model does the summarizing.
      if (body.scope === 'groups') {
        if (!hasRootScope(auth.view.scopes)) {
          throw errors.forbidden('scope=groups is owner-only');
        }
        const sinceHours = clamp(body.since_hours ?? 24, 1, 24 * 30);
        const since = Date.now() - sinceHours * 3_600_000;
        const visibility = visibilityClause(auth.view, auth.scene, 'c', {
          restriction: restrictionFor(auth.view.scopes, auth.scene, config.privacy),
        });
        const rows = db
          .prepare(
            `SELECT c.id, c.path, c.title, c.heading, c.text, c.kind, c.updated_at, c.stage, c.expires_at
               FROM chunks c
              WHERE ${visibility.where}
                AND c.scene LIKE 'qq:group:%'
                AND c.kind IN ('chat', 'note')
                AND c.updated_at >= ?
              ORDER BY c.updated_at DESC
              LIMIT ?`,
          )
          .all(...visibility.params, since, k * 6) as {
          id: string;
          path: string;
          title: string;
          heading: string | null;
          text: string;
          kind: string;
          updated_at: number;
          stage: string;
          expires_at: number | null;
        }[];
        const results: MemoryResult[] = rows.map((row) => ({
          id: row.id,
          title: row.title,
          kind: row.kind as MemoryKind,
          render: { type: 'text' as const, text: row.text },
          path: row.path,
          ...(row.heading ? { heading: row.heading } : {}),
          updated_at: new Date(row.updated_at).toISOString(),
          stage: row.stage as 'short' | 'long',
          ...(row.expires_at ? { expires_at: new Date(row.expires_at).toISOString() } : {}),
        }));
        finish('recall', auth, started, results.map((result) => result.id));
        return { keywords: ['scope:groups'], results };
      }

      if (keywords.length === 0) {
        finish('recall', auth, started, []);
        return { keywords: [], results: [], ...(liveResults ? { live: liveResults } : {}) };
      }
      const searchParams = {
        query: keywords.join(' '),
        // 语义那边用原话更准：关键词串适合 FTS，句向量更适合完整句子。
        semanticQuery: messages.map((message) => message.text).join('\n'),
        k,
        maxChars: clamp(body.max_chars ?? 300, 40, 1000),
        token: auth.view,
        scene: auth.scene,
        restriction: restrictionFor(auth.view.scopes, auth.scene, config.privacy),
        ...(body.subject ? { subject: body.subject } : {}),
      };
      // Owner-initiated disclosure: when the memory's owner themself brings the
      // topic up in this scene, the owner's own memories become readable here.
      // Other people's private scopes and work material stay closed (visibility.ts).
      const ownerSaid = body.messages.some((message) => message.from_owner === true);
      let results: MemoryResult[];
      if (ownerSaid && !hasRootScope(auth.view.scopes)) {
        const base = await runSearch(searchParams, k);
        const wide = await runSearch({ ...searchParams, ownerDisclosure: true }, k);
        const baseIds = new Set(base.hits.map((hit) => hit.id));
        results = wide.hits.map((hit) =>
          toMemoryResult(hit, baseIds.has(hit.id) ? undefined : 'owner_initiated'),
        );
      } else {
        results = (await runSearch(searchParams, k)).hits.map((hit) => toMemoryResult(hit));
      }
      markSuperseded(db, results);
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
        ...(liveResults ? { live: liveResults } : {}),
        review: {
          should_review: shouldReviewNow,
          ...(reminder ? { reminder_since: reminder } : {}),
          ...(lastReview > 0 ? { last_reviewed_at: new Date(lastReview).toISOString() } : {}),
        },
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* timeline（「那阵子发生了什么」）                                   */
  /* ---------------------------------------------------------------- */
  app.post<{ Body: TimelineRequest; Reply: TimelineResponse }>(
    routeByOperationId('timeline').path,
    {
      schema: {
        body: routeByOperationId('timeline').request,
        response: responseSchema('timeline'),
      },
    },
    async (request) => {
      const started = performance.now();
      const body = request.body;
      const auth = authenticate(request.headers.authorization, tokens, body.scene);
      const from = timelineBound(body.from, 'from');
      const to = timelineBound(body.to, 'to');
      if (to <= from) throw errors.invalid('"to" must be after "from"');

      const limit = clamp(body.limit ?? 200, 1, 1000);
      const { docs, total } = timelineDocs(db, auth.view, auth.scene, restrictionFor(auth.view.scopes, auth.scene, config.privacy), {
        from,
        to,
        ...(body.subject ? { subject: body.subject } : {}),
        ...(body.kinds ? { kinds: body.kinds } : {}),
        limit,
        maxChars: clamp(body.max_chars ?? 160, 40, 1000),
      });

      const months = new Map<string, TimelineItem[]>();
      for (const doc of docs) {
        const key = monthKeyOf(doc.updated_at);
        const item: TimelineItem = {
          id: doc.id,
          title: doc.title,
          kind: doc.kind as MemoryKind,
          subject: doc.subject as 'owner' | 'self' | 'other',
          stage: doc.stage,
          updated_at: new Date(doc.updated_at).toISOString(),
          text: doc.text,
          ...(doc.supersedes ? { supersedes: doc.supersedes } : {}),
          ...(doc.superseded_by ? { superseded_by: doc.superseded_by } : {}),
        };
        const bucket = months.get(key);
        if (bucket) bucket.push(item);
        else months.set(key, [item]);
      }

      finish('timeline', auth, started, docs.map((doc) => doc.id));
      // A full page means there is probably an older one: the oldest item's
      // timestamp works as the next `to` (which is exclusive).
      const nextBefore = docs.length >= limit ? new Date(docs[0]!.updated_at).toISOString() : undefined;
      return {
        from: monthKeyOf(from),
        to: monthKeyOf(to - 1),
        total,
        returned: docs.length,
        ...(nextBefore ? { next_before: nextBefore } : {}),
        months: [...months.entries()].map(([month, items]) => ({ month, count: items.length, items })),
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
      subject?: 'owner' | 'self' | 'other';
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

      // Cheap content de-duplication: same scene/kind/text/audience/privacy/
      // subject reuses the previous id instead of appending a duplicate row.
      // `subject` has to be part of the key: "I think X" and "he thinks X" are
      // the same words but not the same memory.
      const subject = body.subject ?? 'owner';
      const contentKey = dedupeKey([
        'fact',
        auth.scene,
        body.kind,
        normalizeForDedupe(body.text),
        [...audience].sort().join(','),
        privacy,
        subject,
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
        subject,
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
        // 入库前清洗：占位符、内部 prompt、工具报错不进短期记忆。
        // 过滤掉的计入 skipped（协议只有 written/skipped 两个字段，不新增）。
        const cleaned = cleanIngestText(String(message.text ?? ''));
        if (cleaned.drop) {
          skipped += 1;
          continue;
        }
        const text = cleaned.text;
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

        // 先取原状态：UPDATE 之后 stage 就变 long 了，判断不出「这原本是不是短期」。
        const before = db
          .prepare('SELECT stage, kind, audience, privacy, source, scene, subject FROM docs WHERE id = ?')
          .get(id) as
          | { stage?: string; kind: string; audience: string; privacy: string; source: string; scene: string | null; subject: string | null }
          | undefined;

        db.prepare("UPDATE docs SET stage = 'long', expires_at = NULL, persisted_at = ? WHERE id = ?").run(now, id);
        db.prepare("UPDATE chunks SET stage = 'long', expires_at = NULL WHERE doc_id = ?").run(id);

        // 把 long 状态也写进 JSONL。index.db 是可以从 memories/ 重建的，持久化状态不能
        // 只活在索引里——否则从备份恢复（备份不含 index.db）后，reindex 会把它变回短期，
        // 等 TTL 到了就被删掉。追加一行同 id 的记录，reindex 时后行覆盖前行。
        // 只对原本是 short 的记录写：多 chunk 的文档用单个 chunk 文本会截断。
        if (before?.stage === 'short') {
          try {
            appendFact(db, config, {
              schema_version: 1,
              id,
              ts: new Date(now).toISOString(),
              kind: before.kind as MemoryKind,
              text: row.text,
              audience: JSON.parse(before.audience) as string[],
              privacy: before.privacy,
              source: before.source,
              ...(before.scene ? { scene: before.scene } : {}),
              ...(before.subject ? { subject: before.subject as 'owner' | 'self' | 'other' } : {}),
              stage: 'long',
              recall_count: 0,
              persisted_at: new Date(now).toISOString(),
            } as TFactRecord);
          } catch (error) {
            // 写 JSONL 失败不能回滚已经生效的 persist：索引已经是 long，只是重建能力丢了。
            // 记一行日志，下一次 persist 或手动迁移可以补。
            console.error(`[persist] failed to append long row for ${id}: ${(error as Error).message}`);
          }
        }
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

/**
 * Accepts `YYYY`, `YYYY-MM`, `YYYY-MM-DD` or an ISO time. `from` is inclusive,
 * `to` is exclusive. No bound means "the last 12 months".
 */
function timelineBound(value: string | undefined, side: 'from' | 'to'): number {
  const text = String(value ?? '').trim();
  if (text.length === 0) {
    if (side === 'from') {
      const now = new Date();
      return new Date(now.getFullYear() - 1, now.getMonth(), 1).getTime();
    }
    return Date.now() + 1;
  }
  const month = /^(\d{4})-(\d{2})$/.exec(text);
  if (month) {
    const year = Number(month[1]);
    const index = Number(month[2]) - 1;
    if (index < 0 || index > 11) throw errors.invalid(`bad month in "${text}"`);
    return side === 'from' ? new Date(year, index, 1).getTime() : new Date(year, index + 1, 1).getTime();
  }
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (day) {
    const start = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime();
    return side === 'from' ? start : start + 86_400_000;
  }
  const year = /^(\d{4})$/.exec(text);
  if (year) {
    const value = Number(year[1]);
    return side === 'from' ? new Date(value, 0, 1).getTime() : new Date(value + 1, 0, 1).getTime();
  }
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) throw errors.invalid(`cannot parse "${text}" as a date`);
  return parsed;
}

function monthKeyOf(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function isKnownPrivacy(label: string): boolean {
  return label === 'normal' || label === 'personal' || label === 'sensitive' || label === 'secret';
}

/**
 * Mark results that a newer memory replaced, so a ranked hit does not present
 * an outdated judgement as if it were current.
 *
 * Chunk ids are the doc id for facts and `doc#0` for markdown docs, so the doc
 * id is recoverable; `docs.supersedes` points at doc ids, which is what we
 * compare against.
 */
function markSuperseded(db: Db, results: MemoryResult[]): MemoryResult[] {
  if (results.length === 0) return results;
  const docIdOf = (chunkId: string): string => {
    const hash = chunkId.indexOf('#');
    return hash >= 0 ? chunkId.slice(0, hash) : chunkId;
  };
  const docIds = Array.from(new Set(results.map((item) => docIdOf(item.id))));
  const placeholders = docIds.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT supersedes FROM docs WHERE supersedes IN (${placeholders})`)
    .all(...docIds) as { supersedes: string | null }[];
  if (rows.length === 0) return results;
  const replaced = new Set(rows.map((row) => row.supersedes).filter((id): id is string => typeof id === 'string'));
  for (const item of results) {
    if (replaced.has(docIdOf(item.id))) item.superseded = true;
  }
  return results;
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
    subject: hit.subject as 'owner' | 'self' | 'other',
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
