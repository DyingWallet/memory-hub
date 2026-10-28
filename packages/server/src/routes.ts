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
  hasSecretWrite,
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
  type RecallResponse,
  type RecentResponse,
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
import { getChunkOrDoc, liveMessages, recentDocs, searchChunks, timelineDocs, type SearchHit } from './search.js';
import { cleanIngestText } from './ingest-filter.js';
import { visibilityClause } from './visibility.js';
import { renderMemoryBlock, renderRecallBlock } from './recall-format.js';
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

/**
 * `source` 表示「这条记忆从哪个端来」，不是场景名。pet 场景写 pet——以前一律
 * 落成 `qq`，按来源统计或回滚时会把桌宠的记忆一起算进 QQ。
 */
function sourceForScene(scene: string): TFactRecord['source'] {
  if (scene === 'main') return 'main';
  if (scene.startsWith('qq:')) return 'qq';
  if (scene === 'pet') return 'pet';
  return 'qq';
}

  const finish = (
    route: string,
    auth: AuthContext,
    started: number,
    ids: string[],
    query?: string,
    denied = 0,
    extras: { group?: string; requester_hash?: string } = {},
    skipped = 0,
  ): void => {
    audit.append({
      ts: new Date().toISOString(),
      token: auth.record.id,
      surface: auth.scene,
      route,
      ...(query !== undefined ? { query_hash: sha256Hex(query).slice(0, 16) } : {}),
      ids,
      denied,
      // ingest 的「跳过」（重复 / 清洗过滤）不是权限拒绝，分开记，否则审计里
      // 会堆出一大串 denied，把真正的越权告警淹掉。
      ...(skipped > 0 ? { skipped } : {}),
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
      // 时间窗可选：不传 = 该群全部历史。成员资格由桥接实时校验（并负责退群拒绝），
      // memd 只守「只给这个群、只给 chat/note、只给 normal/personal」。
      const sinceHours =
        body.since_hours === undefined || body.since_hours === null ? null : clamp(body.since_hours, 1, 24 * 365);
      const k = clamp(body.k ?? 20, 1, 50);
      const since = sinceHours === null ? null : Date.now() - sinceHours * 3_600_000;

      const clauses = [
        'c.scene = ?',
        "c.kind IN ('chat', 'note')",
        "c.privacy IN ('normal', 'personal')",
        '(c.expires_at IS NULL OR c.expires_at > ?)',
      ];
      const params: (string | number)[] = [`qq:group:${groupId}`, Date.now()];
      if (since !== null) {
        clauses.push('c.updated_at >= ?');
        params.push(since);
      }
      params.push(k);

      const rows = db
        .prepare(
          `SELECT c.id, c.path, c.title, c.heading, c.text, c.kind, c.updated_at, c.stage, c.expires_at
             FROM chunks c
            WHERE ${clauses.join(' AND ')}
            ORDER BY c.updated_at DESC
            LIMIT ?`,
        )
        .all(...params) as {
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
      // since_hours=0 表示「不限时间」——响应 schema 要求 number，用 0 不用 null。
      return { group: `qq:group:${groupId}`, since_hours: sinceHours ?? 0, count: results.length, results };
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
    Body: { query: string; k?: number; scene?: string; kinds?: MemoryKind[]; path_prefix?: string; max_chars?: number; subject?: 'owner' | 'self' | 'other'; explain?: number };
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
        ...(body.explain === 1 ? { explain: true } : {}),
      }, k);
      finish('search', auth, started, outcome.hits.map((hit) => hit.id), body.query);
      const ordered = orderByStageWeight(outcome.hits, config.searchShortWeight);
      return {
        query: body.query,
        results: markSuperseded(db, ordered.map((hit) => toMemoryResult(hit))),
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
  app.post<{
    Body: { k?: number; scene?: string; kinds?: MemoryKind[]; format?: 'block'; stage?: 'short' | 'long' };
    Reply: RecentResponse;
  }>(
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
        undefined,
        request.body.stage,
      );
      finish('recent', auth, started, docs.map((doc) => doc.id));
      const results = docs.map(docToMemoryResult);
      return {
        results,
        ...(request.body.format === 'block'
          ? {
              block: renderMemoryBlock(results, {
                maxChars: 1200,
                title: '【最近记下的】（按时间倒序，不是「相关」）',
              }),
            }
          : {}),
      };
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
      format?: 'block';
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
      // FTS 的 query 用完整原句，而不是关键词串。关键词串是 extractKeywords 按
      // bigram 切出来的碎片（「阿汐」「才的」「的记」），AND 必然全灭；OR 降级后
      // bm25 偏爱短文本，长决策记忆会被闲聊挤掉。原句交给 searchChunks 的
      // 覆盖度重排，才能把「记忆对账」这类信号词捞回来。
      const queryText = messages.map((message) => message.text).join(' ');
      const searchParams = {
        query: queryText,
        // 语义那边用原话更准：关键词串适合 FTS，句向量更适合完整句子。
        semanticQuery: queryText,
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
      // 所有命中的记忆都记召回次数（加权模型用它放大 tau），不只是短期记忆。
      touchRecall(db, results.map((result) => result.id), config);
      finish('recall', auth, started, results.map((result) => result.id));
      return {
        keywords,
        results,
        ...(liveResults ? { live: liveResults } : {}),
        ...(body.format === 'block'
          ? {
              block: renderRecallBlock(results, liveResults, {
                maxChars: body.max_chars ?? 1500,
                liveMinutes: body.live?.minutes ?? 30,
              }),
            }
          : {}),
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
      source?: 'main' | 'qq' | 'import' | 'sleep' | 'pet';
      scene?: string;
      subject?: 'owner' | 'self' | 'other';
      supersedes?: string;
      stage?: 'short' | 'long';
      expires_at?: string;
      /** 记忆加权模型：0-3，缺省 1。见 docs/MEMORY-WEIGHTING.md。 */
      importance?: number;
      /** 0/1，话没说完。 */
      open_loop?: number;
      /** 收尾时间（ISO）。 */
      closed_at?: string;
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
      if (body.privacy === 'secret' && !hasSecretWrite(auth.view.scopes)) {
        throw errors.forbidden('writing secret memories requires the secret:write scope');
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
        id: newFactId({ now, scene: auth.scene }),
        ts: new Date(now).toISOString(),
        kind: body.kind,
        text: body.text,
        ...(body.tags ? { tags: body.tags } : {}),
        audience,
        privacy,
        // 只有 root 能标来源：否则群令牌能把自己写的东西伪装成 sleep / import，
        // 回滚时会误删或漏删。
        source: hasRootScope(auth.view.scopes) && body.source ? body.source : sourceForScene(auth.scene),
        device: 'memd',
        scene: auth.scene,
        subject,
        ...(body.supersedes ? { supersedes: body.supersedes } : {}),
        ...(body.meta ? { meta: body.meta } : {}),
        // 加权模型三字段：写进 JSONL，索引重建时原样读回。
        ...(body.importance !== undefined ? { importance: body.importance } : {}),
        ...(body.open_loop !== undefined ? { open_loop: body.open_loop } : {}),
        ...(body.closed_at ? { closed_at: body.closed_at } : {}),
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
        // id 统一走 `<source>-<scene>-<time36>-<rand4>`；幂等改由 source_message_id
        // 承担。它不是一个裸的 provider id：QQ 会在同一个会话里复用短 messageId，
        // 只用 id 当键会把「第二条不同的消息」当成重复丢掉，所以键是
        // `<messageId>#<内容 hash 前 12 位>`。同一条消息重放键相同 → 跳过；
        // 同 id 不同内容键不同 → 两条都留下。
        const sourceMessageId = message.message_id
          ? `${String(message.message_id)}#${sha256Hex(text).slice(0, 12)}`
          : null;
        if (sourceMessageId) {
          const exists = db
            .prepare('SELECT 1 FROM docs WHERE scene = ? AND source_message_id = ?')
            .get(auth.scene, sourceMessageId);
          if (exists) {
            skipped += 1;
            continue;
          }
        }
        const id = newFactId({ now, scene: auth.scene });
        const record: FactRecord = {
          schema_version: 1,
          id,
          ts: new Date(now).toISOString(),
          kind: 'chat',
          text,
          audience,
          privacy: 'normal',
          source: sourceForScene(auth.scene),
          device: 'memd',
          scene: auth.scene,
          stage: 'short',
          expires_at: new Date(expiresAt).toISOString(),
          recall_count: 0,
          // 原始发送时间：桥接补录未读时一批消息的 ts 全是同一入库时刻，
          // 真正的「什么时候说的」在这里，留给整理脚本显示时刻与排序。
          ...(message.ts && Number.isFinite(Date.parse(message.ts))
            ? { sent_at: new Date(message.ts).toISOString() }
            : {}),
          ...(sourceMessageId ? { source_message_id: sourceMessageId } : {}),
        };
        appendFact(db, config, record as TFactRecord);
        written += 1;
      }

      finish('ingest', auth, started, [], undefined, 0, {}, skipped);
      return { written, skipped };
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

/**
 * 短期记忆降权：bm25 天生偏爱短文档，聊天碎片会把长期文档挤出前几名。
 * 只改顺序、不改返回的 score（score 仍是原始召回分）；权重可配，1 = 关闭。
 */
function orderByStageWeight(hits: SearchHit[], shortWeight: number): SearchHit[] {
  if (!(shortWeight >= 0 && shortWeight < 1)) return hits;
  return [...hits].sort((a, b) => {
    const wa = a.score * (a.stage === 'short' ? shortWeight : 1);
    const wb = b.score * (b.stage === 'short' ? shortWeight : 1);
    return wb - wa;
  });
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
/**
 * 召回后更新计数。
 *
 * 两件事分开做：
 * 1. **所有**记忆的 `recall_count` +1——加权模型拿它放大 `tau`（用得多 → 沉得慢）。
 *    不受 `shortTerm` 开关影响：加权跟短期缓存是两回事。
 * 2. **短期**记忆额外延长 TTL（原行为，受 `shortTerm` 开关和封顶约束）。
 */
function touchRecall(db: Db, ids: string[], config: ServerConfig): void {
  if (ids.length === 0) return;
  const now = Date.now();
  const base = config.shortTerm.ttlHours * 3_600_000;
  const cap = config.shortTerm.maxTtlHours * 3_600_000;
  const bump = db.prepare('UPDATE docs SET recall_count = recall_count + 1 WHERE id = ?');
  const readShort = db.prepare("SELECT recall_count FROM docs WHERE id = ? AND stage = 'short'");
  const updateShort = db.prepare('UPDATE docs SET expires_at = ? WHERE id = ?');
  const updateChunks = db.prepare('UPDATE chunks SET expires_at = ? WHERE doc_id = ?');
  for (const id of ids) {
    bump.run(id);
    if (!config.shortTerm.enabled) continue;
    const row = readShort.get(id) as { recall_count?: number } | undefined;
    if (!row) continue;
    // bump 已经 +1，读到的就是新计数。
    const count = row.recall_count ?? 1;
    const expiresAt = Math.min(now + base * 2 ** count, now + cap);
    updateShort.run(expiresAt, id);
    updateChunks.run(expiresAt, id);
  }
}

function docToMemoryResult(doc: {
  id: string;
  title: string;
  kind: string;
  updated_at: number;
  text: string;
  stage?: string;
}): MemoryResult {
  return {
    id: doc.id,
    title: doc.title,
    kind: doc.kind as MemoryKind,
    render: { type: 'text', text: truncate(doc.text, 400) },
    updated_at: new Date(doc.updated_at).toISOString(),
    stage: doc.stage === 'short' ? 'short' : 'long',
  };
}

export function monthFileFor(ts: string): string {
  return `facts/${monthShard(ts)}.jsonl`;
}
