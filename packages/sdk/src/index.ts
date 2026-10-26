import { readFileSync } from 'node:fs';
import type {
  AudienceResponse,
  BootstrapResponse,
  CapabilitiesResponse,
  ConfigSchemaResponse,
  ErrorBody,
  ForgetResponse,
  GetResponse,
  HealthResponse,
  IngestMessage,
  IngestResponse,
  MemoryResult,
  PersistResponse,
  RecallMessage,
  RecallResponse,
  RecentResponse,
  ReviewResponse,
  SearchResponse,
  TimelineRequest,
  TimelineResponse,
  WriteRequest,
  WriteResponse,
  MemoryKind,
  Subject,
} from '@memsvc/protocol';

export interface MemoryClientOptions {
  endpoint: string;
  /** Plaintext token. Prefer `tokenFile` in long-running processes. */
  token?: string;
  /** File containing the bearer token; re-read on each request so rotation needs no restart. */
  tokenFile?: string;
  timeoutMs?: number;
}

export class MemoryServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'MemoryServiceError';
  }
}

export class MemoryClient {
  constructor(private readonly options: MemoryClientOptions) {}

  health(): Promise<HealthResponse> {
    return this.request<HealthResponse>('GET', '/v1/health');
  }

  capabilities(): Promise<CapabilitiesResponse> {
    return this.request<CapabilitiesResponse>('GET', '/v1/capabilities');
  }

  configSchema(): Promise<ConfigSchemaResponse> {
    return this.request<ConfigSchemaResponse>('GET', '/v1/config-schema');
  }

  bootstrap(scene?: string): Promise<BootstrapResponse> {
    return this.request<BootstrapResponse>('POST', '/v1/bootstrap', scene ? { scene } : {});
  }

  search(
    query: string,
    options: { k?: number; scene?: string; kinds?: MemoryKind[]; maxChars?: number; subject?: Subject } = {},
  ): Promise<SearchResponse> {
    return this.request<SearchResponse>('POST', '/v1/search', {
      query,
      ...(options.k !== undefined ? { k: options.k } : {}),
      ...(options.scene ? { scene: options.scene } : {}),
      ...(options.kinds ? { kinds: options.kinds } : {}),
      ...(options.maxChars !== undefined ? { max_chars: options.maxChars } : {}),
      ...(options.subject ? { subject: options.subject } : {}),
    });
  }

  get(id: string, options: { scene?: string; maxChars?: number } = {}): Promise<GetResponse> {
    return this.request<GetResponse>('POST', '/v1/get', {
      id,
      ...(options.scene ? { scene: options.scene } : {}),
      ...(options.maxChars !== undefined ? { max_chars: options.maxChars } : {}),
    });
  }

  recent(options: { k?: number; scene?: string; kinds?: MemoryKind[] } = {}): Promise<RecentResponse> {
    return this.request<RecentResponse>('POST', '/v1/recent', {
      ...(options.k !== undefined ? { k: options.k } : {}),
      ...(options.scene ? { scene: options.scene } : {}),
      ...(options.kinds ? { kinds: options.kinds } : {}),
    });
  }

  recall(
    messages: RecallMessage[],
    options: { k?: number; scene?: string; maxChars?: number; subject?: Subject } = {},
  ): Promise<RecallResponse> {
    return this.request<RecallResponse>('POST', '/v1/recall', {
      messages,
      ...(options.k !== undefined ? { k: options.k } : {}),
      ...(options.scene ? { scene: options.scene } : {}),
      ...(options.maxChars !== undefined ? { max_chars: options.maxChars } : {}),
      ...(options.subject ? { subject: options.subject } : {}),
    });
  }

  /** Documents in time order, grouped by month ("what was going on back then"). */
  timeline(
    options: { from?: string; to?: string; scene?: string; subject?: Subject; kinds?: MemoryKind[]; limit?: number; maxChars?: number } = {},
  ): Promise<TimelineResponse> {
    const body: TimelineRequest = {
      ...(options.from ? { from: options.from } : {}),
      ...(options.to ? { to: options.to } : {}),
      ...(options.scene ? { scene: options.scene } : {}),
      ...(options.subject ? { subject: options.subject } : {}),
      ...(options.kinds ? { kinds: options.kinds } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.maxChars !== undefined ? { max_chars: options.maxChars } : {}),
    };
    return this.request<TimelineResponse>('POST', '/v1/timeline', body);
  }

  write(record: WriteRequest): Promise<WriteResponse> {
    return this.request<WriteResponse>('POST', '/v1/write', record);
  }

  /** Store ordinary chat as short-term memories (TTL + forgetting curve). */
  ingest(messages: IngestMessage[], options: { scene?: string; ttlHours?: number } = {}): Promise<IngestResponse> {
    return this.request<IngestResponse>('POST', '/v1/ingest', {
      messages,
      ...(options.scene ? { scene: options.scene } : {}),
      ...(options.ttlHours !== undefined ? { ttl_hours: options.ttlHours } : {}),
    });
  }

  /** Short-term memories waiting for review. */
  review(options: { scene?: string; lookbackHours?: number; limit?: number; statusOnly?: boolean } = {}): Promise<ReviewResponse> {
    return this.request<ReviewResponse>('POST', '/v1/review', {
      ...(options.scene ? { scene: options.scene } : {}),
      ...(options.lookbackHours !== undefined ? { lookback_hours: options.lookbackHours } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.statusOnly !== undefined ? { status_only: options.statusOnly } : {}),
    });
  }

  /** Promote short-term memories to long-term, optionally with a distilled note. */
  persist(ids: string[], note?: { kind?: MemoryKind; text: string; tags?: string[] }): Promise<PersistResponse> {
    return this.request<PersistResponse>('POST', '/v1/persist', {
      ids,
      ...(note ? { note } : {}),
    });
  }

  /** Forget a fact (writes a tombstone; the JSONL keeps history). */
  forget(id: string, options: { idempotencyKey?: string } = {}): Promise<ForgetResponse> {
    return this.request<ForgetResponse>('POST', '/v1/forget', {
      id,
      ...(options.idempotencyKey ? { idempotency_key: options.idempotencyKey } : {}),
    });
  }

  audience(scene?: string): Promise<AudienceResponse> {
    return this.request<AudienceResponse>('POST', '/v1/audience', scene ? { scene } : {});
  }

  /** Fetches the body text of the first visible result for a query, if any. */
  async recallText(query: string, options: { k?: number; scene?: string; maxChars?: number } = {}): Promise<string | null> {
    const response = await this.search(query, options);
    const first: MemoryResult | undefined = response.results[0];
    return first ? first.render.text : null;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const url = `${this.options.endpoint.replace(/\/+$/, '')}${path}`;
    const timeout = this.options.timeoutMs ?? 4000;
    const headers: Record<string, string> = { accept: 'application/json' };
    const token = this.readToken();
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      throw new MemoryServiceError(0, 'service_unavailable', `cannot reach ${url}: ${(error as Error).message}`);
    }

    const text = await response.text();
    const payload = text.length > 0 ? (JSON.parse(text) as unknown) : null;

    if (!response.ok) {
      const body = payload as ErrorBody | null;
      throw new MemoryServiceError(
        response.status,
        body?.error?.code ?? 'internal_error',
        body?.error?.message ?? `HTTP ${response.status}`,
        body?.error?.requestId,
      );
    }
    return payload as T;
  }

  private readToken(): string | undefined {
    if (this.options.tokenFile) {
      try {
        return readFileSync(this.options.tokenFile, 'utf8').trim();
      } catch {
        return this.options.token;
      }
    }
    return this.options.token;
  }
}
