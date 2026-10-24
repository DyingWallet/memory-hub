#!/usr/bin/env node
/**
 * MCP stdio server for the memory service (plan B for DSH integration).
 *
 * DSH's `dsh-mcp-client` registers this process and puts `initialize.instructions`
 * into the system prompt before the first model turn, so the model knows the
 * memory rules from the very beginning. The HTTP `/v1` API remains the source of
 * truth; MCP is only a projection of it.
 */
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { MemoryClient, MemoryServiceError } from '@memsvc/sdk';
import type {
  BootstrapResponse,
  CapabilitiesResponse,
  GetResponse,
  MemoryKind,
  PersistResponse,
  RecallMessage,
  RecallResponse,
  RecentResponse,
  ReviewResponse,
  SearchResponse,
  TimelineResponse,
  WriteRequest,
  WriteResponse,
} from '@memsvc/protocol';
import { buildBootstrapBlock } from './bootstrap.js';
import { loadPluginConfig } from './config.js';

export const SERVER_INSTRUCTIONS = [
  '长期记忆服务。用户提到过去、旧事、约定、人或项目时，先 memory_search 再回答。',
  '默认先取 5 条；不够再 k=10。不要一次读全量，不要凭标题编造正文。',
  'memory_write 只记持久的事实、承诺、立场、偏好；不记流水账和一次性的寒暄。',
  '记我自己的判断时用 memory_write + subject=self：记忆不只是「他说了什么」。',
  '问「那阵子 / 上个月 / 去年在忙什么」用 memory_timeline，按时间看，不要拿 memory_search 硬凑。',
  '普通聊天已自动进短期记忆（会过期）。新会话开始时若不确定，先 memory_review(status_only=true)；需要回顾就用 memory_review 看候选、memory_persist 挑重要的转长期，其余让它过期。',
  '写不出处不确定时就别写；宁可少一条，不要写错一条。',
].join('\n');

/** Subset of MemoryClient the MCP layer needs; tests inject a fake. */
export interface MemoryApi {
  bootstrap(scene?: string): Promise<BootstrapResponse>;
  search(
    query: string,
    options?: { k?: number; scene?: string; kinds?: MemoryKind[]; maxChars?: number; subject?: 'owner' | 'self' | 'other' },
  ): Promise<SearchResponse>;
  get(id: string, options?: { scene?: string; maxChars?: number }): Promise<GetResponse>;
  recent(options?: { k?: number; scene?: string; kinds?: MemoryKind[] }): Promise<RecentResponse>;
  recall(
    messages: RecallMessage[],
    options?: { k?: number; scene?: string; maxChars?: number; subject?: 'owner' | 'self' | 'other' },
  ): Promise<RecallResponse>;
  timeline(options?: {
    from?: string;
    to?: string;
    scene?: string;
    subject?: 'owner' | 'self' | 'other';
    kinds?: MemoryKind[];
    limit?: number;
    maxChars?: number;
  }): Promise<TimelineResponse>;
  write(record: WriteRequest): Promise<WriteResponse>;
  review(options?: { scene?: string; lookbackHours?: number; limit?: number; dueOnly?: boolean }): Promise<ReviewResponse>;
  persist(ids: string[], note?: { kind?: MemoryKind; text: string; tags?: string[] }): Promise<PersistResponse>;
  capabilities(): Promise<CapabilitiesResponse>;
}

export interface McpServerOptions {
  writeEnabled?: boolean;
  defaultScene?: string;
}

export function createMemoryMcpServer(client: MemoryApi, options: McpServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: 'memory-hub', version: '0.1.0' },
    { instructions: SERVER_INSTRUCTIONS },
  );
  const writeEnabled = options.writeEnabled ?? true;

  const sceneArg = z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe('场景；省略时用插件配置的 scene/surface');

  const ok = (value: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  });

  const fail = (error: unknown) => {
    const message =
      error instanceof MemoryServiceError
        ? `${error.code} (${error.status}): ${error.message}`
        : (error as Error).message;
    return {
      isError: true,
      content: [{ type: 'text' as const, text: `memory service error: ${message}` }],
    };
  };

  const sceneOf = (scene: string | undefined) => scene ?? options.defaultScene;

  server.registerTool(
    'memory_bootstrap',
    {
      title: '记忆摘要',
      description: '取身份、受众脸、最近标题、规模统计。会话开始时调用一次即可。',
      inputSchema: { scene: sceneArg },
    },
    async ({ scene }) => {
      try {
        const response = await client.bootstrap(sceneOf(scene));
        return ok({ ...response, block: buildBootstrapBlock(response) });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'memory_search',
    {
      title: '检索记忆',
      description: '关键词检索长期记忆，默认 5 条短片段。中文两字词也能命中。',
      inputSchema: {
        query: z.string().min(1).max(2000).describe('检索词，可以是用户原话'),
        k: z.number().int().min(1).max(10).optional().describe('条数，默认 5，最大 10'),
        kinds: z.array(z.string()).max(16).optional().describe('限定类型，如 event/note/knowledge'),
        subject: z
          .enum(['owner', 'self', 'other'])
          .optional()
          .describe('只取关于谁的记忆：owner=主人、self=我自己的判断、other=第三方；省略不筛'),
        scene: sceneArg,
      },
    },
    async ({ query, k, kinds, subject, scene }) => {
      try {
        const response = await client.search(query, {
          ...(k !== undefined ? { k } : {}),
          ...(kinds ? { kinds: kinds as MemoryKind[] } : {}),
          ...(subject ? { subject } : {}),
          ...(scene ? { scene } : {}),
        });
        return ok(response);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'memory_timeline',
    {
      title: '时间线',
      description:
        '按时间倒出「那阵子发生了什么」：给年月范围，返回按月分组的记忆，不走相似度。满页时返回 next_before，把它当下一次的 to 就是上一页。',
      inputSchema: {
        from: z.string().max(40).optional().describe('起点：YYYY / YYYY-MM / YYYY-MM-DD；省略=一年前'),
        to: z.string().max(40).optional().describe('终点（不含）；省略=现在'),
        subject: z.enum(['owner', 'self', 'other']).optional().describe('只看关于谁的记忆'),
        kinds: z.array(z.string()).max(16).optional(),
        limit: z.number().int().min(1).max(1000).optional().describe('最多多少条，默认 200'),
        scene: sceneArg,
      },
    },
    async ({ from, to, subject, kinds, limit, scene }) => {
      try {
        return ok(
          await client.timeline({
            ...(from ? { from } : {}),
            ...(to ? { to } : {}),
            ...(subject ? { subject } : {}),
            ...(kinds ? { kinds: kinds as MemoryKind[] } : {}),
            ...(typeof limit === 'number' ? { limit } : {}),
            ...(scene ? { scene } : {}),
          }),
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'memory_get',
    {
      title: '取一条记忆',
      description: '按 id 取回一条记忆的正文（id 来自 search/recent/bootstrap 的结果）。',
      inputSchema: { id: z.string().min(1).max(200), scene: sceneArg },
    },
    async ({ id, scene }) => {
      try {
        return ok(await client.get(id, scene ? { scene } : {}));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'memory_recent',
    {
      title: '最近记忆',
      description: '最近更新的记忆标题与片段，默认 5 条。',
      inputSchema: { k: z.number().int().min(1).max(10).optional(), scene: sceneArg },
    },
    async ({ k, scene }) => {
      try {
        return ok(await client.recent({ ...(k !== undefined ? { k } : {}), ...(scene ? { scene } : {}) }));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'memory_recall',
    {
      title: '按对话召回',
      description: '给最近几条对话消息，召回 2–3 条最相关的短片段。唤醒类场景用这个。',
      inputSchema: {
        messages: z.array(z.object({ role: z.string().max(20), text: z.string().max(4000) })).min(1).max(8),
        k: z.number().int().min(1).max(5).optional(),
        scene: sceneArg,
      },
    },
    async ({ messages, k, scene }) => {
      try {
        return ok(
          await client.recall(messages, {
            ...(k !== undefined ? { k } : {}),
            ...(scene ? { scene } : {}),
          }),
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'memory_write',
    {
      title: '写入记忆',
      description: '写入一条持久事实。只记 durable 的事：事实、承诺、立场、偏好。',
      inputSchema: {
        kind: z
          .enum([
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
          ])
          .describe('类型；拿不准用 note'),
        text: z.string().min(1).max(8000),
        tags: z.array(z.string().max(64)).max(24).optional(),
        privacy: z.enum(['normal', 'personal', 'work', 'financial']).optional(),
        audience: z.array(z.string().max(120)).max(32).optional().describe('可见范围；省略按类型默认'),
        subject: z
          .enum(['owner', 'self', 'other'])
          .optional()
          .describe('这是关于谁的：owner=主人（默认）、self=我自己的判断、other=第三方'),
        idempotency_key: z.string().max(200).optional().describe('重试时用来去重'),
        scene: sceneArg,
      },
    },
    async ({ kind, text, tags, privacy, audience, subject, idempotency_key, scene }) => {
      if (!writeEnabled) {
        return fail(new Error('write is disabled in the plugin config'));
      }
      try {
        return ok(
          await client.write({
            kind: kind as MemoryKind,
            text,
            ...(tags ? { tags } : {}),
            ...(privacy ? { privacy } : {}),
            ...(audience ? { audience } : {}),
            ...(subject ? { subject } : {}),
            ...(idempotency_key ? { idempotency_key } : {}),
            ...(scene ? { scene } : {}),
          }),
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'memory_review',
    {
      title: '记忆回顾',
      description: '列出待回顾的短期聊天记忆；挑重要的用 memory_persist 转长期，其余让它自然过期。',
      inputSchema: {
        lookback_hours: z.number().int().min(1).max(24 * 14).optional().describe('回看多少小时，默认 72'),
        limit: z.number().int().min(1).max(100).optional(),
        status_only: z.boolean().optional().describe('只查状态和条数，不返回条目、不清提醒'),
        scene: sceneArg,
      },
    },
    async ({ lookback_hours, limit, status_only, scene }) => {
      try {
        return ok(
          await client.review({
            ...(typeof lookback_hours === 'number' ? { lookbackHours: lookback_hours } : {}),
            ...(typeof limit === 'number' ? { limit } : {}),
            ...(typeof status_only === 'boolean' ? { statusOnly: status_only } : {}),
            ...(scene ? { scene } : {}),
          }),
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'memory_persist',
    {
      title: '转为长期记忆',
      description: '把回顾中挑中的短期记忆转长期；可另写一条蒸馏后的 note。',
      inputSchema: {
        ids: z.array(z.string().max(200)).max(50).describe('要转长期的短期记忆 id'),
        note: z
          .object({
            kind: z
              .enum([
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
                'chat',
              ])
              .optional(),
            text: z.string().min(1).max(4000),
            tags: z.array(z.string().max(64)).max(24).optional(),
          })
          .optional()
          .describe('蒸馏后的一条长期记忆（可选）'),
      },
    },
    async ({ ids, note }) => {
      try {
        return ok(await client.persist(ids, note ? { ...note, kind: note.kind as MemoryKind } : undefined));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'memory_call',
    {
      title: '通用调用（前向兼容）',
      description: '未来操作的兜底入口；op 必须在服务端白名单内。普通场景请用具体工具。',
      inputSchema: {
        op: z.enum(['search', 'get', 'recent', 'recall', 'bootstrap', 'write', 'capabilities']),
        params: z.record(z.unknown()).optional(),
      },
    },
    async ({ op, params }) => {
      const p = (params ?? {}) as Record<string, unknown>;
      try {
        switch (op) {
          case 'search':
            return ok(
              await client.search(String(p.query ?? ''), {
                ...(typeof p.k === 'number' ? { k: p.k } : {}),
                ...(typeof p.scene === 'string' ? { scene: p.scene } : {}),
              }),
            );
          case 'get':
            return ok(await client.get(String(p.id ?? ''), typeof p.scene === 'string' ? { scene: p.scene } : {}));
          case 'recent':
            return ok(
              await client.recent({
                ...(typeof p.k === 'number' ? { k: p.k } : {}),
                ...(typeof p.scene === 'string' ? { scene: p.scene } : {}),
              }),
            );
          case 'recall':
            return ok(
              await client.recall(Array.isArray(p.messages) ? (p.messages as RecallMessage[]) : [], {
                ...(typeof p.k === 'number' ? { k: p.k } : {}),
                ...(typeof p.scene === 'string' ? { scene: p.scene } : {}),
              }),
            );
          case 'bootstrap':
            return ok(await client.bootstrap(typeof p.scene === 'string' ? p.scene : undefined));
          case 'capabilities':
            return ok(await client.capabilities());
          case 'write':
            return ok(await client.write(p as unknown as WriteRequest));
          default:
            return fail(new Error(`unsupported op: ${op}`));
        }
      } catch (error) {
        return fail(error);
      }
    },
  );

  return server;
}

async function main(): Promise<void> {
  const config = loadPluginConfig();
  const client = new MemoryClient({
    endpoint: config.endpoint,
    tokenFile: config.tokenFile,
    timeoutMs: config.timeoutMs,
  });
  const server = createMemoryMcpServer(client, {
    writeEnabled: config.write,
    ...(config.scene
      ? { defaultScene: config.scene }
      : config.surface !== 'main'
        ? { defaultScene: config.surface }
        : {}),
  });
  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel: diagnostics go to stderr only.
  console.error(`[memory-mcp] ready (endpoint=${config.endpoint}, surface=${config.surface})`);
}

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[memory-mcp] fatal: ${(error as Error).message}`);
    process.exit(1);
  });
}
