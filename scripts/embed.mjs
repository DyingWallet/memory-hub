#!/usr/bin/env node
/**
 * 向量回填 / 状态查询。
 *
 *   node scripts/embed.mjs                 # 回填到没有缺口（默认用 config.semantic.backfillThreads）
 *   node scripts/embed.mjs --threads 2     # 覆盖线程数（稳态建议 1，回填建议 4）
 *   node scripts/embed.mjs --stats         # 只看状态，不跑回填
 *
 * 一次性工作：跑完即退，模型不会被常驻。服务里的增量由 app.ts 的 5 秒循环负责。
 */
import { loadConfig } from '../packages/server/dist/config.js';
import { openDb } from '../packages/server/dist/db.js';
import { SemanticManager } from '../packages/server/dist/semantic.js';

const args = process.argv.slice(2);
const threadsIndex = args.indexOf('--threads');
const threads = threadsIndex >= 0 ? Number(args[threadsIndex + 1]) || undefined : undefined;
const statsOnly = args.includes('--stats');

const config = loadConfig();
if (!config.semantic.enabled) {
  console.error('semantic search is disabled: set config.json → {"semantic":{"enabled":true}} first');
  process.exit(2);
}

const db = openDb(config.indexFile);
const manager = new SemanticManager({
  db,
  config: config.semantic,
  logger: { info: (m) => console.log(`[embed] ${m}`), warn: (m) => console.warn(`[embed] ${m}`) },
  // 回填是一次性批处理：默认用 backfillThreads（实测 4 线程 2–5 秒跑完），
  // 稳态服务里仍然是 config.semantic.threads（1）。
  threads: threads ?? config.semantic.backfillThreads,
});

const status = await manager.start();
if (!status.ready) {
  console.error(`semantic unavailable: ${status.reason ?? 'unknown'}`);
  db.close();
  process.exit(1);
}
console.log(`model=${status.model} dim=${status.dim} vectors=${status.vectors} threads=${threads ?? config.semantic.backfillThreads}`);

if (!statsOnly) {
  const started = Date.now();
  const result = await manager.backfill();
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(result ? `embedded ${result.embedded} chunk(s) in ${seconds}s` : 'nothing to do');
  console.log(`vectors now: ${manager.status.vectors}`);
}

await manager.close();
db.close();
