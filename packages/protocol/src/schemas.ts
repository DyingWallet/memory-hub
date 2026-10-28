/**
 * Wire protocol for the memory service (`/v1`).
 *
 * TypeBox is the single source of truth: the same schema drives Fastify
 * validation, the OpenAPI document, and the DSH settings page JSON Schema.
 * Types are derived with `Static<>`; never hand-write a duplicate interface.
 */
import { Type, type Static } from '@sinclair/typebox';

/* ------------------------------------------------------------------ */
/* vocabularies                                                        */
/* ------------------------------------------------------------------ */

/**
 * One sensitivity bit on top of audience: `sensitive` memories are pinned to
 * the owner's own audiences and need a token scope to read. `secret` is
 * special-cased by the server and is never readable or writable via the API.
 */
export const PRIVACY_VALUES = ['normal', 'personal', 'sensitive', 'secret'] as const;
export const TPrivacy = Type.String({ minLength: 1, maxLength: 40, pattern: '^[a-z][a-z0-9_-]*$' });
export type Privacy = Static<typeof TPrivacy>;

export const MEMORY_KINDS = [
  'note',
  'event',
  'stance',
  'promise',
  'person',
  'identity',
  'chat',
  'qq-topic',
  'qq-impression',
  'journal',
  'decision',
  'knowledge',
  'audience',
  'project',
  'profile',
  'preference',
] as const;
export const TMemoryKind = Type.Union(MEMORY_KINDS.map((v) => Type.Literal(v)));
export type MemoryKind = Static<typeof TMemoryKind>;

// `sleep` = 夜间整理产出（整理会话写入，只有 root 令牌能标）。存在的意义是让
// 「按来源整批撤回」有抓手：整理写错了能一次 forget，而不是一条条翻。
// `pet` 同理——桌宠写的东西不该混进 `qq`，否则按来源统计/回滚会串。
export const SOURCE_VALUES = ['main', 'qq', 'import', 'sleep', 'pet'] as const;
export const TSource = Type.Union(SOURCE_VALUES.map((v) => Type.Literal(v)));
export type Source = Static<typeof TSource>;

export const STAGE_VALUES = ['short', 'long'] as const;
export const TStage = Type.Union(STAGE_VALUES.map((v) => Type.Literal(v)));
export type Stage = Static<typeof TStage>;

/**
 * Whose memory this is: the owner's, the assistant's own judgement, or a third
 * party's. Absent means `owner` — every record written before this field existed
 * is about the owner, so old data needs no migration.
 */
export const SUBJECT_VALUES = ['owner', 'self', 'other'] as const;
export const TSubject = Type.Union(SUBJECT_VALUES.map((v) => Type.Literal(v)));
export type Subject = Static<typeof TSubject>;

/** `*` = root (main session / owner QQ DM), `shared` = every surface. */
export const TScopeList = Type.Array(Type.String({ minLength: 1, maxLength: 120 }), {
  uniqueItems: true,
  maxItems: 32,
});
export type ScopeList = Static<typeof TScopeList>;

/* ------------------------------------------------------------------ */
/* shared objects                                                      */
/* ------------------------------------------------------------------ */

export const TRender = Type.Object(
  {
    type: Type.Literal('text'),
    text: Type.String({ maxLength: 20000 }),
  },
  { additionalProperties: false },
);
export type Render = Static<typeof TRender>;

export const TMemoryResult = Type.Object(
  {
    id: Type.String(),
    title: Type.String(),
    kind: TMemoryKind,
    render: TRender,
    path: Type.Optional(Type.String()),
    heading: Type.Optional(Type.String()),
    updated_at: Type.Optional(Type.String()),
    score: Type.Optional(Type.Number()),
    /** `short` items decay and may be forgotten; `long` items are durable. */
    stage: Type.Optional(TStage),
    /** Whose memory this is (absent = `owner`). */
    subject: Type.Optional(TSubject),
    /**
     * A newer memory replaced this one. Present on ranked results (search /
     * recall) so an outdated judgement is not shown as if it were current.
     */
    superseded: Type.Optional(Type.Boolean()),
    expires_at: Type.Optional(Type.String()),
    /** Set when this item became visible because its owner brought it up in this scene. */
    disclosure: Type.Optional(Type.Union([Type.Literal('owner_initiated')])),
    /** 仅请求体 `explain: 1` 时返回：加权分量，用于排查「为什么这条排第一」。 */
    explain: Type.Optional(
      Type.Object(
        {
          baseScore: Type.Number(),
          strength: Type.Number(),
          importance: Type.Integer(),
          openLoop: Type.Integer(),
          finalScore: Type.Number(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type MemoryResult = Static<typeof TMemoryResult>;

export const TAudience = Type.Object(
  {
    id: Type.String(),
    face: Type.String(),
    name: Type.Optional(Type.String()),
    kind: Type.Optional(Type.String()),
    relationship: Type.Optional(Type.String()),
    boundaries: Type.Optional(Type.Array(Type.String())),
    known: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);
export type Audience = Static<typeof TAudience>;

export const TErrorBody = Type.Object(
  {
    error: Type.Object(
      {
        code: Type.String(),
        message: Type.String(),
        requestId: Type.Optional(Type.String()),
        details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type ErrorBody = Static<typeof TErrorBody>;

/** Stable error codes — clients branch on these, never on the message. */
export const ERROR_CODES = [
  'invalid_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'payload_too_large',
  'rate_limited',
  'service_unavailable',
  'internal_error',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/* ------------------------------------------------------------------ */
/* health / capabilities                                               */
/* ------------------------------------------------------------------ */

export const THealthResponse = Type.Object(
  {
    ok: Type.Boolean(),
    version: Type.String(),
    uptime_s: Type.Number(),
    index: Type.Object(
      {
        docs: Type.Integer(),
        facts: Type.Integer(),
        chunks: Type.Integer(),
        built_at: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type HealthResponse = Static<typeof THealthResponse>;

export const TCapabilitiesResponse = Type.Object(
  {
    protocol: Type.Literal('v1'),
    version: Type.String(),
    tools: Type.Array(Type.String()),
    features: Type.Object(
      {
        images: Type.Boolean(),
        documents: Type.Boolean(),
        semantic: Type.Boolean(),
        offline: Type.Boolean(),
        short_term: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    limits: Type.Object(
      {
        search_default_k: Type.Integer(),
        search_max_k: Type.Integer(),
        search_default_chars: Type.Integer(),
        recall_max_messages: Type.Integer(),
        write_max_chars: Type.Integer(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type CapabilitiesResponse = Static<typeof TCapabilitiesResponse>;

export const TConfigSchemaResponse = Type.Object(
  {
    title: Type.String(),
    description: Type.String(),
    schema: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);
export type ConfigSchemaResponse = Static<typeof TConfigSchemaResponse>;

/* ------------------------------------------------------------------ */
/* bootstrap                                                          */
/* ------------------------------------------------------------------ */

export const TBootstrapRequest = Type.Object(
  {
    surface: Type.Optional(Type.String({ maxLength: 120 })),
    scene: Type.Optional(Type.String({ maxLength: 120 })),
  },
  { additionalProperties: false },
);
export type BootstrapRequest = Static<typeof TBootstrapRequest>;

export const TRecentItem = Type.Object(
  {
    id: Type.String(),
    title: Type.String(),
    kind: TMemoryKind,
    updated_at: Type.Optional(Type.String()),
    /** Short body excerpt; bootstrap fills it for `self` only. */
    text: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type RecentItem = Static<typeof TRecentItem>;

export const TBootstrapResponse = Type.Object(
  {
    identity: Type.String(),
    audience: TAudience,
    recent: Type.Array(TRecentItem),
    /** The assistant's own recent judgements (`subject=self`), newest first. */
    self: Type.Array(TRecentItem),
    counts: Type.Object(
      { docs: Type.Integer(), facts: Type.Integer() },
      { additionalProperties: false },
    ),
    instructions: Type.String(),
  },
  { additionalProperties: false },
);
export type BootstrapResponse = Static<typeof TBootstrapResponse>;

/* ------------------------------------------------------------------ */
/* search / get / recent / recall                                     */
/* ------------------------------------------------------------------ */

export const TSearchRequest = Type.Object(
  {
    query: Type.String({ minLength: 1, maxLength: 2000 }),
    k: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
    scene: Type.Optional(Type.String({ maxLength: 120 })),
    kinds: Type.Optional(Type.Array(TMemoryKind, { maxItems: 16 })),
    path_prefix: Type.Optional(Type.String({ maxLength: 200 })),
    max_chars: Type.Optional(Type.Integer({ minimum: 40, maximum: 6000 })),
    /** Only memories about this subject (`owner` / `self` / `other`). */
    subject: Type.Optional(TSubject),
    /** 1 = 在每条结果上附带加权分量（baseScore / strength / importance / openLoop）。 */
    explain: Type.Optional(Type.Integer({ minimum: 0, maximum: 1 })),
  },
  { additionalProperties: false },
);
export type SearchRequest = Static<typeof TSearchRequest>;

export const TSearchResponse = Type.Object(
  {
    query: Type.String(),
    results: Type.Array(TMemoryResult),
    weak: Type.Boolean(),
    scanned: Type.Integer(),
  },
  { additionalProperties: false },
);
export type SearchResponse = Static<typeof TSearchResponse>;

/* ------------------------------------------------------------------ */
/* disclosure（跨场景披露：群友在私聊里问“刚才群里说了什么”）        */
/* ------------------------------------------------------------------ */

export const TDiscloseRequest = Type.Object(
  {
    /** 提问者的 QQ 号（桥接已经用群成员表校验过，这里是留痕用）。 */
    requester: Type.String({ minLength: 1, maxLength: 32 }),
    /** 群号或 `qq:group:<id>`。 */
    group: Type.String({ minLength: 1, maxLength: 32 }),
    since_hours: Type.Optional(Type.Number({ minimum: 1, maximum: 168 })),
    k: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  },
  { additionalProperties: false },
);
export type DiscloseRequest = Static<typeof TDiscloseRequest>;

export const TDiscloseResponse = Type.Object(
  {
    group: Type.String(),
    since_hours: Type.Number(),
    count: Type.Integer(),
    results: Type.Array(TMemoryResult),
  },
  { additionalProperties: false },
);
export type DiscloseResponse = Static<typeof TDiscloseResponse>;

export const TGetRequest = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 200 }),
    scene: Type.Optional(Type.String({ maxLength: 120 })),
    max_chars: Type.Optional(Type.Integer({ minimum: 40, maximum: 20000 })),
  },
  { additionalProperties: false },
);
export type GetRequest = Static<typeof TGetRequest>;

export const TGetResponse = Type.Object(
  { memory: Type.Union([TMemoryResult, Type.Null()]) },
  { additionalProperties: false },
);
export type GetResponse = Static<typeof TGetResponse>;

export const TRecentRequest = Type.Object(
  {
    k: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
    scene: Type.Optional(Type.String({ maxLength: 120 })),
    kinds: Type.Optional(Type.Array(TMemoryKind, { maxItems: 16 })),
    /**
     * 只取某一层。夜间整理要拿「最近的长期记忆」做查重参照——短期聊天每秒在写，
     * 按 updated_at 倒序取 10 条永远是短期，过滤完只剩一两条。
     */
    stage: Type.Optional(Type.Union([Type.Literal('short'), Type.Literal('long')])),
    // 和 /v1/recall 一样：传 "block" 时多返一段服务端渲染好的文本，
    // 消费端不再自己拼格式（三端共用同一套）。
    format: Type.Optional(Type.Literal('block')),
  },
  { additionalProperties: false },
);
export type RecentRequest = Static<typeof TRecentRequest>;

export const TRecentResponse = Type.Object(
  {
    results: Type.Array(TMemoryResult),
    block: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type RecentResponse = Static<typeof TRecentResponse>;

export const TRecallMessage = Type.Object(
  {
    role: Type.String({ maxLength: 20 }),
    text: Type.String({ maxLength: 4000 }),
    /** The bridge sets this from the actual sender; the model never supplies it. */
    from_owner: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type RecallMessage = Static<typeof TRecallMessage>;

/**
 * "What is happening right now": the newest short-term chat, returned next to
 * the recall hits. The pet uses it to know what the main session is in the
 * middle of — recall alone can only find things that resemble the question.
 */
export const TRecallLive = Type.Object(
  {
    k: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
    /** Only messages newer than this are returned (default 30). */
    minutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 24 * 60 })),
    /** Restrict to these scenes (e.g. `["main"]`); omitted = every visible scene. */
    scenes: Type.Optional(Type.Array(Type.String({ maxLength: 120 }), { maxItems: 8 })),
  },
  { additionalProperties: false },
);
export type RecallLive = Static<typeof TRecallLive>;

export const TRecallRequest = Type.Object(
  {
    messages: Type.Array(TRecallMessage, { maxItems: 8 }),
    k: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
    scene: Type.Optional(Type.String({ maxLength: 120 })),
    max_chars: Type.Optional(Type.Integer({ minimum: 40, maximum: 2000 })),
    /** Ask for the newest chat messages as well (see `TRecallLive`). */
    live: Type.Optional(TRecallLive),
    /** Only memories about this subject (`owner` / `self` / `other`). */
    subject: Type.Optional(TSubject),
    /** Owner-only: `groups` returns recent group messages instead of FTS hits. */
    scope: Type.Optional(Type.Union([Type.Literal('scene'), Type.Literal('groups')])),
    /** Time window for `scope=groups` (hours, default 24). */
    since_hours: Type.Optional(Type.Integer({ minimum: 1, maximum: 24 * 30 })),
    /** Render a ready-to-inject prompt block in `block` (same results, pre-formatted). */
    format: Type.Optional(Type.Union([Type.Literal('block')])),
  },
  { additionalProperties: false },
);
export type RecallRequest = Static<typeof TRecallRequest>;

export const TRecallResponse = Type.Object(
  {
    keywords: Type.Array(Type.String()),
    results: Type.Array(TMemoryResult),
    /** Newest chat from other scenes (only when the request asked for `live`). */
    live: Type.Optional(Type.Array(TMemoryResult)),
    /** Ready-to-inject prompt block, only when the request asked for `format: "block"`. */
    block: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type RecallResponse = Static<typeof TRecallResponse>;

/* ------------------------------------------------------------------ */
/* timeline（「那阵子发生了什么」）                                   */
/* ------------------------------------------------------------------ */

export const TTimelineRequest = Type.Object(
  {
    /** `YYYY` / `YYYY-MM` / `YYYY-MM-DD` / ISO time. Default: 12 months back. */
    from: Type.Optional(Type.String({ maxLength: 40 })),
    to: Type.Optional(Type.String({ maxLength: 40 })),
    scene: Type.Optional(Type.String({ maxLength: 120 })),
    subject: Type.Optional(TSubject),
    kinds: Type.Optional(Type.Array(TMemoryKind, { maxItems: 16 })),
    /** Max documents returned (default 200). */
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    max_chars: Type.Optional(Type.Integer({ minimum: 40, maximum: 1000 })),
  },
  { additionalProperties: false },
);
export type TimelineRequest = Static<typeof TTimelineRequest>;

export const TTimelineItem = Type.Object(
  {
    id: Type.String(),
    title: Type.String(),
    kind: TMemoryKind,
    subject: TSubject,
    stage: TStage,
    updated_at: Type.String(),
    text: Type.String(),
    /** This memory replaced an older one. */
    supersedes: Type.Optional(Type.String()),
    /** A newer memory replaced this one. */
    superseded_by: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type TimelineItem = Static<typeof TTimelineItem>;

export const TTimelineResponse = Type.Object(
  {
    from: Type.String(),
    to: Type.String(),
    /** Documents in the whole window (same visibility as the page). */
    total: Type.Integer(),
    /** How many of them this response actually carries (≤ `limit`). */
    returned: Type.Integer(),
    /**
     * Set when `returned` reached `limit`: pass it as `to` to read the previous
     * page. No cursor object — the boundary is just the oldest item returned.
     */
    next_before: Type.Optional(Type.String()),
    months: Type.Array(
      Type.Object(
        {
          month: Type.String(),
          count: Type.Integer(),
          items: Type.Array(TTimelineItem),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type TimelineResponse = Static<typeof TTimelineResponse>;

/* ------------------------------------------------------------------ */
/* short-term chat ingestion, review, persistence                     */
/* ------------------------------------------------------------------ */

export const TIngestMessage = Type.Object(
  {
    message_id: Type.Optional(Type.String({ maxLength: 200 })),
    role: Type.String({ maxLength: 20 }),
    author: Type.Optional(Type.String({ maxLength: 120 })),
    text: Type.String({ minLength: 1, maxLength: 4000 }),
    ts: Type.Optional(Type.String({ maxLength: 40 })),
  },
  { additionalProperties: false },
);
export type IngestMessage = Static<typeof TIngestMessage>;

export const TIngestRequest = Type.Object(
  {
    scene: Type.Optional(Type.String({ maxLength: 120 })),
    /** Hours until these chat memories are forgotten (default from server config). */
    ttl_hours: Type.Optional(Type.Number({ minimum: 0.1, maximum: 24 * 30 })),
    messages: Type.Array(TIngestMessage, { minItems: 1, maxItems: 50 }),
  },
  { additionalProperties: false },
);
export type IngestRequest = Static<typeof TIngestRequest>;

export const TIngestResponse = Type.Object(
  { written: Type.Integer(), skipped: Type.Integer() },
  { additionalProperties: false },
);
export type IngestResponse = Static<typeof TIngestResponse>;



/* ------------------------------------------------------------------ */
/* write                                                              */
/* ------------------------------------------------------------------ */

/**
 * One line of `facts/YYYY-MM.jsonl`. Append-only: corrections are new records
 * with `supersedes`. Unknown `meta` keys are preserved, so no migration is
 * needed when a field is added.
 */
export const TFactRecord = Type.Object(
  {
    schema_version: Type.Literal(1),
    id: Type.String({ minLength: 1, maxLength: 200 }),
    ts: Type.String({ minLength: 1, maxLength: 40 }),
    kind: TMemoryKind,
    text: Type.String({ minLength: 1, maxLength: 20000 }),
    tags: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 24 })),
    audience: Type.Optional(TScopeList),
    privacy: Type.Optional(TPrivacy),
    source: Type.Optional(TSource),
    device: Type.Optional(Type.String({ maxLength: 64 })),
    scene: Type.Optional(Type.String({ maxLength: 120 })),
    /** Whose memory this is; absent means `owner` (all pre-existing records). */
    subject: Type.Optional(TSubject),
    supersedes: Type.Optional(Type.String({ maxLength: 200 })),
    /** `short` = ordinary chat, decays; `long` = durable (default). */
    stage: Type.Optional(TStage),
    /** ISO time when a short memory is forgotten; absent for long memories. */
    expires_at: Type.Optional(Type.String({ maxLength: 40 })),
    /** How many times this memory was recalled (spacing effect extends TTL). */
    recall_count: Type.Optional(Type.Integer({ minimum: 0 })),
    /**
     * 记忆加权模型（docs/MEMORY-WEIGHTING.md）：0-3，写入时标注。
     * 0/1/2 是「沉得慢」，3 是「几乎不沉」（50 年半衰期）。缺省按 1。
     */
    importance: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
    /** 0/1，话没说完。只影响相关时的排序，不催办。 */
    open_loop: Type.Optional(Type.Integer({ minimum: 0, maximum: 1 })),
    /** 收尾时间（ISO）。参与 strength 的第二条痕迹。 */
    closed_at: Type.Optional(Type.String({ maxLength: 40 })),
    persisted_at: Type.Optional(Type.String({ maxLength: 40 })),
    source_message_id: Type.Optional(Type.String({ maxLength: 200 })),
    /**
     * 原始发送时间。`ts` 是入库时刻——桥接补录未读时一批消息的 ts 全一样，
     * 真正的「什么时候说的」在这里。整理脚本按它显示时刻与排序。
     */
    sent_at: Type.Optional(Type.String({ maxLength: 40 })),
    meta: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: true },
);
export type TFactRecord = Static<typeof TFactRecord>;


export const TWriteRequest = Type.Object(
  {
    kind: TMemoryKind,
    text: Type.String({ minLength: 1, maxLength: 8000 }),
    tags: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 24 })),
    audience: Type.Optional(TScopeList),
    privacy: Type.Optional(TPrivacy),
    source: Type.Optional(TSource),
    scene: Type.Optional(Type.String({ maxLength: 120 })),
    /** `self` = the assistant's own judgement, not a fact about the owner. */
    subject: Type.Optional(TSubject),
    supersedes: Type.Optional(Type.String({ maxLength: 200 })),
    stage: Type.Optional(TStage),
    expires_at: Type.Optional(Type.String({ maxLength: 40 })),
    /** 记忆加权模型：0-3，缺省 1。见 docs/MEMORY-WEIGHTING.md。 */
    importance: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
    /** 0/1，话没说完。只影响相关时的排序。 */
    open_loop: Type.Optional(Type.Integer({ minimum: 0, maximum: 1 })),
    /** 收尾时间（ISO），参与 strength 的第二条痕迹。 */
    closed_at: Type.Optional(Type.String({ maxLength: 40 })),
    source_message_id: Type.Optional(Type.String({ maxLength: 200 })),
    meta: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    idempotency_key: Type.Optional(Type.String({ maxLength: 200 })),
  },
  { additionalProperties: false },
);
export type WriteRequest = Static<typeof TWriteRequest>;

export const TWriteResponse = Type.Object(
  {
    id: Type.String(),
    indexed: Type.Boolean(),
    duplicate: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type WriteResponse = Static<typeof TWriteResponse>;

export const TForgetRequest = Type.Object(
  {
    id: Type.Optional(Type.String({ maxLength: 200 })),
    idempotency_key: Type.Optional(Type.String({ maxLength: 200 })),
  },
  { additionalProperties: false, minProperties: 1 },
);
export type ForgetRequest = Static<typeof TForgetRequest>;

export const TForgetResponse = Type.Object(
  {
    forgotten: Type.Array(Type.String()),
    missing: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);
export type ForgetResponse = Static<typeof TForgetResponse>;

/* ------------------------------------------------------------------ */
/* config update (root token, loopback settings page)                 */
/* ------------------------------------------------------------------ */

export const TConfigUpdateRequest = Type.Object(
  {
    shortTerm: Type.Optional(
      Type.Object(
        {
          enabled: Type.Optional(Type.Boolean()),
          ttlHours: Type.Optional(Type.Number({ minimum: 0.1, maximum: 720 })),
          maxTtlHours: Type.Optional(Type.Number({ minimum: 0.1, maximum: 8760 })),
        },
        { additionalProperties: false },
      ),
    ),
    privacy: Type.Optional(
      Type.Object(
        {
          sensitiveScope: Type.Optional(Type.String({ maxLength: 64 })),
          sensitiveAudiences: Type.Optional(Type.Array(Type.String({ maxLength: 120 }), { maxItems: 32 })),
          ownerAudiences: Type.Optional(Type.Array(Type.String({ maxLength: 120 }), { maxItems: 32 })),
        },
        { additionalProperties: false },
      ),
    ),
    archive: Type.Optional(
      Type.Object(
        {
          enabled: Type.Optional(Type.Boolean()),
          keepMonths: Type.Optional(Type.Integer({ minimum: 0, maximum: 120 })),
        },
        { additionalProperties: false },
      ),
    ),
    semantic: Type.Optional(
      Type.Object(
        {
          /** 语义检索总开关；运行中切换会即时生效（开 = 建索引并补一批向量）。 */
          enabled: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false, minProperties: 1 },
);
export type ConfigUpdateRequest = Static<typeof TConfigUpdateRequest>;

export const TConfigUpdateResponse = Type.Object(
  { ok: Type.Boolean(), applied: Type.Array(Type.String()) },
  { additionalProperties: false },
);
export type ConfigUpdateResponse = Static<typeof TConfigUpdateResponse>;

export const TConfigResponse = Type.Object(
  {
    shortTerm: Type.Object(
      {
        enabled: Type.Boolean(),
        ttlHours: Type.Number(),
        maxTtlHours: Type.Number(),
      },
      { additionalProperties: false },
    ),
    privacy: Type.Object(
      {
        sensitiveScope: Type.String(),
        sensitiveAudiences: Type.Array(Type.String()),
        ownerAudiences: Type.Array(Type.String()),
      },
      { additionalProperties: false },
    ),
    archive: Type.Object(
      { enabled: Type.Boolean(), keepMonths: Type.Integer() },
      { additionalProperties: false },
    ),
    semantic: Type.Object(
      {
        enabled: Type.Boolean(),
        ready: Type.Boolean(),
        reason: Type.Union([Type.String(), Type.Null()]),
        vectors: Type.Integer(),
        dim: Type.Integer(),
        model: Type.String(),
        alpha: Type.Number(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type ConfigResponse = Static<typeof TConfigResponse>;

/* ------------------------------------------------------------------ */
/* tokens (root-only management for the settings page)                */
/* ------------------------------------------------------------------ */

export const TTokenInfo = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    surface: Type.String(),
    scenes: Type.Array(Type.String()),
    scopes: Type.Array(Type.String()),
    created_at: Type.String(),
    revoked_at: Type.Union([Type.String(), Type.Null()]),
    last_used_at: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type TokenInfo = Static<typeof TTokenInfo>;

export const TTokensResponse = Type.Object(
  { tokens: Type.Array(TTokenInfo) },
  { additionalProperties: false },
);
export type TokensResponse = Static<typeof TTokensResponse>;

export const TTokenRevokeRequest = Type.Object(
  { id: Type.String({ minLength: 1, maxLength: 100 }) },
  { additionalProperties: false },
);
export type TokenRevokeRequest = Static<typeof TTokenRevokeRequest>;

export const TTokenRevokeResponse = Type.Object(
  { ok: Type.Boolean(), id: Type.String() },
  { additionalProperties: false },
);
export type TokenRevokeResponse = Static<typeof TTokenRevokeResponse>;

/* ------------------------------------------------------------------ */
/* audience                                                           */
/* ------------------------------------------------------------------ */

export const TAudienceRequest = Type.Object(
  { scene: Type.Optional(Type.String({ maxLength: 120 })) },
  { additionalProperties: false },
);
export type AudienceRequest = Static<typeof TAudienceRequest>;

export const TAudienceResponse = Type.Object(
  { audience: TAudience },
  { additionalProperties: false },
);
export type AudienceResponse = Static<typeof TAudienceResponse>;

/* ------------------------------------------------------------------ */
/* settings page schema (renderer only; config truth lives on disk)    */
/* ------------------------------------------------------------------ */

export const SETTINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['endpoint'],
  properties: {
    endpoint: {
      type: 'string',
      title: '服务地址',
      description: 'memd 的 HTTP 地址，本机默认 http://127.0.0.1:8787',
      default: 'http://127.0.0.1:8787',
      format: 'uri',
    },
    surface: {
      type: 'string',
      title: '场景',
      description: '此客户端代表的场景（main / qq:owner / qq:group:…）',
      default: 'main',
    },
    tokenFile: {
      type: 'string',
      title: 'Token 文件',
      description: '存放 Bearer token 的 ACL 文件路径（不在页面回显内容）',
    },
    bootstrap: { type: 'boolean', title: '会话启动注入记忆摘要', default: true },
    recall: { type: 'boolean', title: '对话中按需召回', default: true },
    write: { type: 'boolean', title: '允许写入新记忆', default: true },
    timeoutMs: { type: 'integer', title: '请求超时（毫秒）', default: 4000, minimum: 200, maximum: 60000 },
  },
} as const;
