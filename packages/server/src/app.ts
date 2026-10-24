import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { ErrorBody } from '@memsvc/protocol';
import { AuditLog } from './audit.js';
import { buildLogLevel, loadConfig, type ServerConfig } from './config.js';
import { openDb, purgeExpired, type Db } from './db.js';
import { ApiError } from './errors.js';
import { reindexAll, type ReindexResult } from './indexer.js';
import { registerRoutes } from './routes.js';
import { startReviewScheduler } from './review.js';
import { SemanticManager } from './semantic.js';
import { TokenStore } from './tokens.js';

export interface BuildAppOptions {
  config: ServerConfig;
  db?: Db;
  tokens?: TokenStore;
  audit?: AuditLog;
  logger?: FastifyServerOptions['logger'];
  /** Skip the startup reindex (tests index their own fixtures). */
  reindex?: boolean;
}

export interface BuiltApp {
  app: FastifyInstance;
  db: Db;
  tokens: TokenStore;
  audit: AuditLog;
  index: ReindexResult | null;
  /** Always present; inert (FTS-only) until enabled. */
  semantic: SemanticManager;
}

export async function buildApp(options: BuildAppOptions): Promise<BuiltApp> {
  const { config } = options;
  const db = options.db ?? openDb(config.indexFile);
  const tokens = options.tokens ?? new TokenStore(config.tokensFile);
  const audit = options.audit ?? new AuditLog(config.auditFile);

  let index: ReindexResult | null = null;
  if (options.reindex !== false) {
    try {
      index = reindexAll(db, config);
      // Forget whatever expired while the service was down.
      purgeExpired(db);
    } catch (error) {
      console.error(`[memd] startup reindex failed: ${(error as Error).message}`);
    }
  }

  // 语义检索是可选的：关着就完全跳过（不加载 onnxruntime、不建向量表），
  // 模型缺失 / 没装依赖也只是一条 warn。运行中可以通过 /v1/config 切换。
  const semantic = new SemanticManager({
    db,
    config: config.semantic,
    logger: {
      info: (message: string) => console.log(`[memd] ${message}`),
      warn: (message: string) => console.warn(`[memd] ${message}`),
    },
  });
  if (config.semantic.enabled) await semantic.start();

  const app = Fastify({
    logger: options.logger ?? { level: buildLogLevel(config.logLevel) },
    bodyLimit: 512 * 1024,
    disableRequestLogging: true,
  });
  // CORS preflight for the settings panel's authenticated config calls.
  app.options('/*', async (_request, reply) => {
    reply.header('access-control-allow-methods', 'GET,POST,OPTIONS');
    reply.header('access-control-allow-headers', 'authorization,content-type');
    reply.header('access-control-allow-private-network', 'true');
    reply.header('access-control-max-age', '600');
    return reply.status(204).send();
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.id);
    // The DSH settings panel is a browser page on another loopback port; the
    // status endpoint is public, so allow loopback origins (and opaque/null
    // origins such as a sandboxed iframe or a desktop shell's file:// page).
    // memd only binds loopback + ZeroTier; auth is a bearer token, never a
    // cookie, so echoing `*` for opaque origins cannot leak credentials.
    const origin = request.headers.origin;
    const isPublicHealth = request.method === 'GET' && request.url.split('?')[0] === '/v1/health';
    if (typeof origin === 'string' && /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(origin)) {
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'origin');
      reply.header('access-control-allow-private-network', 'true');
    } else if (isPublicHealth || origin === 'null' || origin === undefined) {
      reply.header('access-control-allow-origin', '*');
      reply.header('access-control-allow-private-network', 'true');
    }
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    const fastifyError = error as { statusCode?: number; message?: string };
    if (error instanceof ApiError) {
      const body: ErrorBody = {
        error: {
          code: error.code,
          message: error.message,
          requestId: request.id,
          ...(error.details ? { details: error.details } : {}),
        },
      };
      reply.status(error.statusCode).send(body);
      return;
    }
    const statusCode = typeof fastifyError.statusCode === 'number' ? fastifyError.statusCode : 500;
    const isValidation = statusCode === 400;
    if (statusCode >= 500) {
      request.log.error({ err: error }, 'unhandled error');
    }
    const body: ErrorBody = {
      error: {
        code: isValidation ? 'invalid_request' : statusCode === 401 ? 'unauthorized' : statusCode === 403 ? 'forbidden' : 'internal_error',
        message: statusCode >= 500 ? 'internal error' : (fastifyError.message ?? 'request failed'),
        requestId: request.id,
      },
    };
    reply.status(statusCode).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    const body: ErrorBody = {
      error: { code: 'not_found', message: `no route for ${request.method} ${request.url}`, requestId: request.id },
    };
    reply.status(404).send(body);
  });

  registerRoutes(app, { config, db, tokens, audit, startedAt: Date.now(), semantic });

  // 新写入的 chunk 由这个小循环补向量：每 5 秒最多 32 条（32 × ~5 ms ≈ 160 ms 的低优先级 CPU），
  // 大回填交给 scripts/embed.mjs（多线程、跑完即退）。
  let semanticSync: NodeJS.Timeout | null = null;
  semanticSync = setInterval(() => {
    if (!semantic.ready) return;
    void semantic.sync(32).catch((error: unknown) => app.log.warn({ err: error }, 'semantic sync failed'));
  }, 5000);
  semanticSync.unref();
  if (semantic.ready) {
    void semantic.sync(64).catch((error: unknown) => app.log.warn({ err: error }, 'semantic sync failed'));
  }

  // Daily review nudge: mark due scenes even when no client is awake; the next
  // recall/review sees the pending flag. Timer is unref'd and stopped on close.
  if (config.shortTerm.enabled) {
    const stopReview = startReviewScheduler(db, config.shortTerm.reviewIntervalHours, (scenes) => {
      app.log.debug({ scenes }, 'review due');
    });
    app.addHook('onClose', async () => stopReview());
  }

  app.addHook('onClose', async () => {
    if (semanticSync) clearInterval(semanticSync);
    await semantic?.close();
  });

  return { app, db, tokens, audit, index, semantic };
}

export { loadConfig };
export type { ServerConfig };
