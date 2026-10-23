/**
 * Smoke test against a running memd over real HTTP.
 *   node scripts/smoke.mjs <token-file> [query]
 */
import { readFileSync } from 'node:fs';
import { loadConfig } from '../packages/server/dist/config.js';

const tokenFile = process.argv[2] ?? 'data/smoke-token';
const query = process.argv[3] ?? '桌宠';
const config = loadConfig();
const base = process.env.MEMD_URL ?? `http://127.0.0.1:${config.port}`;
const token = readFileSync(new URL(`../${tokenFile.replace(/^\.\//, '')}`, import.meta.url), 'utf8').trim();

async function call(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(options.headers ?? {}),
    },
    signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} -> ${response.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const health = await call('/v1/health');
console.log(`health: ok=${health.ok} docs=${health.index.docs} facts=${health.index.facts} chunks=${health.index.chunks}`);

const bootstrap = await call('/v1/bootstrap', { method: 'POST', body: JSON.stringify({ scene: 'main' }) });
console.log(`identity: ${bootstrap.identity.slice(0, 40)}...`);
console.log(`audience: ${bootstrap.audience.id} / face=${bootstrap.audience.face.slice(0, 30)}`);
console.log(`recent: ${bootstrap.recent.map((item) => item.title).slice(0, 3).join(' | ')}`);

const started = performance.now();
const search = await call('/v1/search', { method: 'POST', body: JSON.stringify({ query, k: 3, scene: 'main' }) });
const ms = performance.now() - started;
console.log(`search "${query}": ${search.results.length} hit(s), ${ms.toFixed(1)}ms, weak=${search.weak}`);
for (const result of search.results) {
  console.log(`  - ${result.title} (${result.kind}, score=${result.score})`);
}
