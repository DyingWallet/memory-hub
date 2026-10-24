import { mkdirSync, watch, writeFileSync } from 'node:fs';
import { createServer, type RequestListener, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { purgeExpired } from './db.js';
import { reindexAll } from './indexer.js';

const config = loadConfig();
const { app, db, index } = await buildApp({ config });

// 记下自己用的 node 运行时：doctor 靠它判断有没有进程还在用 DSH 自带的 node.exe
// （那会锁住 DSH 安装目录，让升级改名失败 WinError 32）。
try {
  const runtimeFile = join(config.dataDir, 'runtime.json');
  mkdirSync(dirname(runtimeFile), { recursive: true });
  writeFileSync(
    runtimeFile,
    `${JSON.stringify({ service: 'memd', node: process.execPath, version: process.version, pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );
} catch {
  // 只是自检用，写不了不影响服务
}

// Fastify's `listen()` accepts a single address, so each configured address gets
// its own http.Server sharing Fastify's request handler. That keeps the service
// on loopback + the ZeroTier address without ever binding 0.0.0.0.
await app.ready();
const listeners: Server[] = [];
const handler = app.routing as unknown as RequestListener;

for (const host of config.hosts) {
  const server = createServer(handler);
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once('error', onError);
      server.listen(config.port, host, () => {
        server.off('error', onError);
        resolve();
      });
    });
    listeners.push(server);
    app.log.info(`memd listening on http://${host}:${config.port}`);
  } catch (error) {
    app.log.error({ err: error, host }, `failed to listen on ${host}:${config.port}`);
    process.exitCode = 1;
  }
}

if (listeners.length === 0) {
  app.log.error('no address bound; exiting');
  await app.close();
  db.close();
  process.exit(1);
}

if (index) {
  app.log.info(
    { docs: index.docs, facts: index.facts, chunks: index.chunks, changed: index.changed },
    'index ready',
  );
}

// Hourly sweep: short-term memories that outlived their TTL are dropped.
const purgeTimer = setInterval(() => {
  try {
    const dropped = purgeExpired(db);
    if (dropped > 0) app.log.info({ dropped }, 'expired short-term memories purged');
  } catch (error) {
    app.log.error({ err: error }, 'purge failed');
  }
}, 60 * 60 * 1000);
purgeTimer.unref();

if (config.watch) {
  let timer: NodeJS.Timeout | null = null;
  try {
    watch(config.memoriesDir, { recursive: true }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          const result = reindexAll(db, config);
          if (result.changed > 0) app.log.info({ changed: result.changed }, 'reindexed (watch)');
        } catch (error) {
          app.log.error({ err: error }, 'watch reindex failed');
        }
      }, 750);
    });
    app.log.info(`watching ${config.memoriesDir}`);
  } catch (error) {
    app.log.warn({ err: error }, 'fs.watch unavailable; run reindex manually');
  }
}

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  try {
    await new Promise<void>((resolve) => {
      let pending = listeners.length;
      if (pending === 0) return resolve();
      for (const server of listeners) {
        server.close(() => {
          pending -= 1;
          if (pending === 0) resolve();
        });
      }
    });
    await app.close();
    db.close();
  } finally {
    process.exit(0);
  }
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
