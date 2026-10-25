/**
 * QQ bridge memory client — compiled to `dist/memory-client.mjs` and imported
 * from the plain-JS bridge (`src/bridge.js`).
 *
 * Deliberately dependency-free (Node builtins only) so the bridge never needs
 * the TypeScript build chain. Uses global `fetch`: the bridge's `safe-fetch`
 * refuses loopback addresses, and memd lives on 127.0.0.1:8787.
 *
 * Every call fails soft: the bridge must keep working when memd is down.
 */
import { readFileSync } from 'node:fs';

export interface QQMemoryOptions {
  enabled?: boolean;
  endpoint: string;
  tokenFile: string;
  recallK?: number;
  maxChars?: number;
  timeoutMs?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface ChatMessage {
  role: string;
  text: string;
  /** Set by the bridge when the sender is the owner; enables owner-initiated disclosure. */
  from_owner?: boolean;
  id?: string;
  author?: string;
  ts?: string;
}

export interface MemoryItem {
  id: string;
  title: string;
  kind: string;
  text: string;
  /** `short` = 短期记忆（会被遗忘，`expires_at` 到期后不再召回到）。 */
  stage?: 'short' | 'long';
  /** 短期记忆的过期时间（ISO）；长期记忆没有这个字段。 */
  expires_at?: string;
}

export interface MirrorEntry {
  kind: 'qq-topic' | 'qq-impression';
  text: string;
  scene: string;
  privacy?: 'normal' | 'personal';
  tags?: string[];
  idempotencyKey?: string;
}

export interface TimelineOptions {
  from?: string;
  to?: string;
  limit?: number;
  subject?: 'owner' | 'self' | 'other';
  kinds?: string[];
}

export interface TimelineItem {
  id: string;
  title: string;
  kind: string;
  updated_at: string;
  text: string;
  stage?: 'short' | 'long';
  subject?: string;
}

export interface TimelineResult {
  from: string;
  to: string;
  total: number;
  returned: number;
  next_before?: string;
  months: { month: string; count: number; items: TimelineItem[] }[];
}

export interface QQMemoryClient {
  sceneForConvKey(convKey: string, ownerQQ: string | number): string;
  recallBlock(
    convKey: string,
    ownerQQ: string | number,
    messages: ChatMessage[],
    options?: { scope?: 'scene' | 'groups'; sinceHours?: number },
  ): Promise<string | null>;
  ingest(messages: ChatMessage[]): Promise<boolean>;
  search(query: string, scene: string, k?: number): Promise<MemoryItem[]>;
  timeline(scene: string, options?: TimelineOptions): Promise<TimelineResult | null>;
  get(id: string, scene: string): Promise<MemoryItem | null>;
  recent(scene: string, k?: number): Promise<MemoryItem[]>;
  mirrorWrite(entry: MirrorEntry): Promise<boolean>;
  writeFact(entry: {
    kind: string;
    text: string;
    scene: string;
    tags?: string[];
    privacy?: 'normal' | 'personal' | 'sensitive';
    audience?: string[];
    idempotencyKey?: string;
  }): Promise<boolean>;
  forget(options: { id?: string; idempotencyKey?: string }): Promise<boolean>;
}

const IDENTITY_TTL_MS = 10 * 60 * 1000;

export function sceneForConvKey(convKey: string, ownerQQ: string | number): string {
  const raw = String(convKey ?? '').trim();
  const match = /^(group|private):(.+)$/.exec(raw);
  if (!match) return 'qq:unknown';
  const [, kind, id] = match;
  if (kind === 'group') return `qq:group:${id}`;
  return String(id) === String(ownerQQ) ? 'qq:owner' : `qq:private:${id}`;
}

export function createQQMemoryClient(options: QQMemoryOptions): QQMemoryClient {
  const endpoint = options.endpoint.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 3000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const recallK = clampInt(options.recallK ?? 3, 1, 5);
  const maxChars = clampInt(options.maxChars ?? 800, 120, 4000);
  let identityCache: { text: string; at: number } | null = null;

  const readToken = (): string | undefined => {
    try {
      return readFileSync(options.tokenFile, 'utf8').trim();
    } catch {
      return undefined;
    }
  };

  const call = async (path: string, body: unknown): Promise<any> => {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    const token = readToken();
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetchImpl(`${endpoint}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`memd ${path} -> HTTP ${response.status} ${text.slice(0, 200)}`);
    }
    return response.json();
  };

  const identity = async (): Promise<string> => {
    if (identityCache && Date.now() - identityCache.at < IDENTITY_TTL_MS) return identityCache.text;
    const payload = await call('/v1/bootstrap', {});
    const line = String(payload?.identity ?? '').replace(/\s+/g, ' ').trim();
    identityCache = { text: line, at: Date.now() };
    return line;
  };

  const sceneFor = (convKey: string, ownerQQ: string | number): string => sceneForConvKey(convKey, ownerQQ);

  return {
    sceneForConvKey: sceneFor,

    async recallBlock(convKey, ownerQQ, messages, recallOptions) {
      if (options.enabled === false) return null;
      try {
        const scene = sceneFor(convKey, ownerQQ);
        const recentMessages = (Array.isArray(messages) ? messages : [])
          .slice(-2)
          .filter((message) => typeof message?.text === 'string' && message.text.trim().length > 0)
          .map((message) => ({
            role: message.role === 'assistant' ? 'assistant' : 'user',
            text: message.text.slice(0, 2000),
            ...(message.from_owner === true ? { from_owner: true } : {}),
          }));
        if (recentMessages.length === 0 && recallOptions?.scope !== 'groups') return null;

        const [payload, identityLine] = await Promise.all([
          call('/v1/recall', {
            messages: recentMessages,
            k: recallK,
            scene,
            max_chars: Math.min(300, maxChars),
            ...(recallOptions?.scope ? { scope: recallOptions.scope } : {}),
            ...(recallOptions?.sinceHours ? { since_hours: recallOptions.sinceHours } : {}),
          }),
          identity().catch(() => ''),
        ]);

        const results: any[] = Array.isArray(payload?.results) ? payload.results : [];
        if (results.length === 0 && identityLine.length === 0) return null;

        const lines: string[] = [];
        if (identityLine.length > 0) lines.push(`【长期记忆】${identityLine}`);
        if (results.length > 0) {
          lines.push('【相关记忆】');
          let used = lines.join('\n').length;
          for (const [index, item] of results.entries()) {
            const text = String(item?.render?.text ?? item?.text ?? '')
              .replace(/\s+/g, ' ')
              .trim();
            if (text.length === 0) continue;
            const borrowed = item?.disclosure === 'owner_initiated' ? '（对方自己提起过的记忆）' : '';
            const line = `${index + 1}. ${borrowed}${text}`;
            if (used + line.length + 1 > maxChars) break;
            lines.push(line);
            used += line.length + 1;
          }
        }
        const block = lines.join('\n').trim();
        const reviewHint =
          payload?.review?.should_review === true
            ? '【记忆回顾】有短期记忆待回顾：用 mcp__memory__memory_review 查看，挑重要的用 mcp__memory__memory_persist 转长期，其余让它自然过期。'
            : '';
        return [block, reviewHint].filter((part) => part.length > 0).join('\n\n');
      } catch (error) {
        // Silent by contract: a missing memd must never delay or break a wake-up.
        return null;
      }
    },

    async ingest(messages) {
      if (options.enabled === false) return false;
      const list = (Array.isArray(messages) ? messages : []).filter(
        (message) => String(message?.text ?? '').trim().length > 0,
      );
      if (list.length === 0) return false;
      // The API caps one request at 50 messages; batch so a wake can report
      // hundreds of messages (ingestLimit) without oversized bodies.
      try {
        for (let i = 0; i < list.length; i += 50) {
          const batch = list.slice(i, i + 50);
          await call('/v1/ingest', {
            messages: batch.map((message) => ({
              ...(message.id ? { message_id: message.id } : {}),
              role: message.role === 'assistant' ? 'assistant' : 'user',
              ...(message.author ? { author: message.author } : {}),
              text: String(message.text ?? '').slice(0, 2000),
              ...(message.ts ? { ts: message.ts } : {}),
            })),
          });
        }
        return true;
      } catch {
        return false;
      }
    },

    async search(query, scene, k = 5) {
      try {
        const payload = await call('/v1/search', { query, k: clampInt(k, 1, 10), scene, max_chars: 400 });
        return normalizeResults(payload?.results);
      } catch {
        return [];
      }
    },

    async timeline(scene, options = {}) {
      try {
        const payload = await call('/v1/timeline', {
          scene,
          ...(options.from ? { from: options.from } : {}),
          ...(options.to ? { to: options.to } : {}),
          ...(options.limit ? { limit: clampInt(options.limit, 1, 1000) } : {}),
          ...(options.subject ? { subject: options.subject } : {}),
          ...(options.kinds ? { kinds: options.kinds } : {}),
          max_chars: 200,
        });
        const out = normalizeTimeline(payload);
        if (out.total === 0 && out.months.length === 0) return null;
        return out;
      } catch {
        return null;
      }
    },

    async get(id, scene) {
      try {
        const payload = await call('/v1/get', { id, scene, max_chars: 4000 });
        const results = normalizeResults(payload?.memory ? [payload.memory] : []);
        return results[0] ?? null;
      } catch {
        return null;
      }
    },

    async recent(scene, k = 5) {
      try {
        const payload = await call('/v1/recent', { k: clampInt(k, 1, 10), scene });
        return normalizeResults(payload?.results);
      } catch {
        return [];
      }
    },

    async writeFact(entry) {
      if (options.enabled === false) return false;
      try {
        await call('/v1/write', {
          kind: entry.kind,
          text: entry.text,
          scene: entry.scene,
          audience: entry.audience ?? [entry.scene],
          privacy: entry.privacy ?? 'normal',
          source: 'qq',
          ...(entry.tags ? { tags: entry.tags } : {}),
          ...(entry.idempotencyKey ? { idempotency_key: entry.idempotencyKey } : {}),
        });
        return true;
      } catch {
        return false;
      }
    },

    async mirrorWrite(entry) {
      if (options.enabled === false) return false;
      try {
        await call('/v1/write', {
          kind: entry.kind,
          text: entry.text,
          scene: entry.scene,
          audience: [entry.scene],
          privacy: entry.privacy ?? (entry.kind === 'qq-impression' ? 'personal' : 'normal'),
          source: 'qq',
          ...(entry.tags ? { tags: entry.tags } : {}),
          ...(entry.idempotencyKey ? { idempotency_key: entry.idempotencyKey } : {}),
        });
        return true;
      } catch {
        return false;
      }
    },

    async forget(request) {
      if (options.enabled === false) return false;
      if (!request.id && !request.idempotencyKey) return false;
      try {
        await call('/v1/forget', {
          ...(request.id ? { id: request.id } : {}),
          ...(request.idempotencyKey ? { idempotency_key: request.idempotencyKey } : {}),
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}

function normalizeTimeline(raw: unknown): TimelineResult {
  const value = (raw ?? {}) as Record<string, any>;
  const months = Array.isArray(value.months)
    ? value.months.map((month: any) => ({
        month: String(month?.month ?? ''),
        count: Number(month?.count ?? 0),
        items: (Array.isArray(month?.items) ? month.items : []).map((item: any) => ({
          id: String(item?.id ?? ''),
          title: String(item?.title ?? ''),
          kind: String(item?.kind ?? ''),
          updated_at: String(item?.updated_at ?? ''),
          text: String(item?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
          ...(item?.stage === 'short' || item?.stage === 'long' ? { stage: item.stage } : {}),
          ...(item?.subject ? { subject: String(item.subject) } : {}),
        })),
      }))
    : [];
  return {
    from: String(value.from ?? ''),
    to: String(value.to ?? ''),
    total: Number(value.total ?? 0),
    returned: Number(value.returned ?? 0),
    ...(value.next_before ? { next_before: String(value.next_before) } : {}),
    months,
  };
}

function normalizeResults(raw: unknown): MemoryItem[] {  if (!Array.isArray(raw)) return [];
  const out: MemoryItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const value = item as Record<string, any>;
    const text = String(value.render?.text ?? value.text ?? '').trim();
    if (text.length === 0) continue;
    out.push({
      id: String(value.id ?? ''),
      title: String(value.title ?? ''),
      kind: String(value.kind ?? ''),
      text,
      // stage/expires_at 必须透传：没有 stage，模型分不清「今天某人随口一句」
      // （short，会过期）和长期项目记忆，会把临时聊天当事实引用。
      ...(value.stage === 'short' || value.stage === 'long' ? { stage: value.stage } : {}),
      ...(typeof value.expires_at === 'string' ? { expires_at: value.expires_at } : {}),
    });
  }
  return out;
}

function clampInt(value: number, min: number, max: number): number {
  const n = Number.isFinite(value) ? Math.trunc(value) : min;
  return Math.min(max, Math.max(min, n));
}
