/**
 * P0 acceptance check: index the real `memories/` tree and prove that the
 * Chinese two-character queries the plan calls out actually hit.
 *
 *   node scripts/verify-recall.mjs [query ...]
 */
import { performance } from 'node:perf_hooks';
import { loadConfig } from '../packages/server/dist/config.js';
import { openDb } from '../packages/server/dist/db.js';
import { reindexAll } from '../packages/server/dist/indexer.js';
import { searchChunks } from '../packages/server/dist/search.js';

const config = loadConfig();
const db = openDb(config.indexFile);
const index = reindexAll(db, config);
console.log(`index: docs=${index.docs} facts=${index.facts} chunks=${index.chunks} changed=${index.changed}`);

const token = { surface: 'main', scopes: ['*', 'work:read'], scenes: ['main'] };
const queries = process.argv.slice(2);
const defaults = ['记忆', '桌宠', '记忆简报', 'QQ 桥接', '股票'];

let failures = 0;
for (const query of queries.length > 0 ? queries : defaults) {
  const started = performance.now();
  const outcome = searchChunks(db, {
    query,
    k: 3,
    maxChars: 80,
    token,
    scene: 'main',
  });
  const ms = performance.now() - started;
  const top = outcome.hits[0];
  if (outcome.hits.length === 0) failures += 1;
  console.log(
    `${outcome.hits.length === 0 ? 'MISS' : 'HIT '} ${query.padEnd(10)} ${ms.toFixed(1).padStart(6)}ms  ${
      top ? `${top.title} ${outcome.hits.length} hit(s) score=${top.score.toFixed(3)}` : '(no results)'
    }`,
  );
}
db.close();
if (failures > 0) {
  console.error(`${failures} query/queries missed`);
  process.exit(1);
}
