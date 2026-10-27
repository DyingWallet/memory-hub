#!/usr/bin/env node
/**
 * 统一记忆 ID 规则，并迁移存量。
 *
 * 新格式：
 *   <source>-<scene>-<time36>-<rand4>      事实（fact / import）
 *   doc-<pathHash8>-<ord>                   文档
 *
 * 特性：
 *  - **确定性**：同一旧 id 永远映射到同一新 id（rand 取旧 id 的 sha1 前 4 位），
 *    所以脚本可以重复跑、dry-run 与 apply 结果一致。
 *  - **默认只预演**：`--apply` 才动文件；apply 前要求 memd 已停，并自动备份。
 *  - **引用同步**：`supersedes` 里的旧 id 一并改写。
 *
 *   node scripts/migrate-ids.mjs             # dry-run：只报告
 *   node scripts/migrate-ids.mjs --apply     # 备份 + 重写 + 重建索引
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '@memsvc/server/config';
import { openDb, purgeExpired, setMeta } from '@memsvc/server/db';
import { rebuildDedupeKeys, reindexAll } from '@memsvc/server/indexer';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const config = loadConfig();
const factsDir = config.factsDir;
const dataDir = config.dataDir;

if (!existsSync(factsDir)) {
  console.error(`missing facts dir: ${factsDir}`);
  process.exit(1);
}

function normalizeScene(scene) {
  if (!scene) return 'none';
  const cleaned = String(scene)
    .replace(/:/g, '-')
    .replace(/[^a-zA-Z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return cleaned || 'none';
}

/**
 * 已经是统一格式的 id 原样保留：脚本会被重复执行，每次重洗一遍会让所有 id
 * 变形（和外部引用、日志、审计记录对不上），也没有任何收益。
 * 旧前缀共四种：`f_<epoch>_<hex>`、`chat:<scene>:<hash>`、`import:<scene>:<hash>`、
 * `doc:<path>#<ord>`；新格式对应 `fact-` / `import-` / `doc-`。
 */
function needsMigration(id) {
  return id.startsWith('f_') || id.startsWith('chat:') || id.startsWith('import:') || id.startsWith('doc:');
}

function newIdFor(oldId, record) {
  if (oldId.startsWith('doc:')) {
    const [path, ord = '0'] = oldId.slice(4).split('#');
    const hash = createHash('sha1').update(path).digest('hex').slice(0, 8);
    return `doc-${hash}-${ord}`;
  }
  const source = oldId.startsWith('import:') ? 'import' : 'fact';
  const scene = normalizeScene(record?.scene);
  const ts = Date.parse(record?.ts ?? '') || 0;
  const time = Math.max(1, Math.floor(ts / 1000)).toString(36);
  const rand = createHash('sha1').update(oldId).digest('hex').slice(0, 4);
  return `${source}-${scene}-${time}-${rand}`;
}

const files = readdirSync(factsDir).filter((name) => name.endsWith('.jsonl'));
const map = new Map();
const collisions = new Map();
const supersedesRefs = new Set();
let totalRows = 0;
let brokenSupersedes = 0;

for (const name of files) {
  const lines = readFileSync(join(factsDir, name), 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    totalRows += 1;
    if (typeof record.id !== 'string') continue;
    if (!needsMigration(record.id)) continue;
    if (!map.has(record.id)) {
      const next = newIdFor(record.id, record);
      if ([...map.values()].includes(next)) {
        const list = collisions.get(next) ?? [];
        list.push(record.id);
        collisions.set(next, list);
      }
      map.set(record.id, next);
    }
    if (typeof record.supersedes === 'string') supersedesRefs.add(record.supersedes);
  }
}

for (const ref of supersedesRefs) if (!map.has(ref)) brokenSupersedes += 1;

const summary = {
  mode: apply ? 'apply' : 'dry-run',
  files: files.length,
  rows: totalRows,
  uniqueIds: map.size,
  idCollisions: collisions.size,
  supersedesRefs: supersedesRefs.size,
  supersedesMissing: brokenSupersedes,
  sample: [...map.entries()].slice(0, 5).map(([from, to]) => ({ from, to })),
};

// ── --sync-meta：不迁移 id，只把去重键补齐/修回来 ──────────────────
// 用途：索引重建（或丢掉）之后，`dedupe:*` 会一起没，同一内容再写就不算重复。
// 它可以从 JSONL 重算，所以不需要动任何记忆。
if (args.includes('--sync-meta')) {
  try {
    const health = await fetch(`http://127.0.0.1:${config.port}/v1/health`, { signal: AbortSignal.timeout(1500) });
    if (health.ok) {
      console.error('memd is running; stop it before touching the index.');
      process.exit(2);
    }
  } catch {
    // 不可达 = 已停
  }
  const db = openDb(config.indexFile);
  const dedupeRestored = rebuildDedupeKeys(db, config);
  const idemCount = db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'idem:%'").get().n;
  const dedupeCount = db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'dedupe:%'").get().n;
  db.close();
  console.log(
    JSON.stringify({ mode: 'sync-meta', dedupeRestored, dedupeTotal: dedupeCount, idemTotal: idemCount }, null, 2),
  );
  process.exit(0);
}

if (!apply) {
  console.log(JSON.stringify(summary, null, 2));
  if (collisions.size > 0) {
    console.log('collisions:', JSON.stringify([...collisions.entries()].slice(0, 5), null, 2));
  }
  console.log('\n(dry-run) 未改动任何文件；加 --apply 才会备份并重写。');
  console.log('只想修 meta 里的去重键（不迁移 id）：--sync-meta');
  process.exit(0);
}

// apply 要 memd 停着（否则索引与文件会不一致）。
try {
  const health = await fetch(`http://127.0.0.1:${config.port}/v1/health`, { signal: AbortSignal.timeout(1500) });
  if (health.ok) {
    console.error('memd is running; stop it before applying (or run with the service stopped).');
    process.exit(2);
  }
} catch {
  // 不可达 = 已停，继续
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = join(dataDir, '..', 'backups', `ids-before-${stamp}`);
mkdirSync(backupDir, { recursive: true });
for (const name of files) {
  copyFileSync(join(factsDir, name), join(backupDir, name));
}

let rewritten = 0;
for (const name of files) {
  const path = join(factsDir, name);
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      out.push(line);
      continue;
    }
    if (typeof record.id === 'string' && map.has(record.id)) {
      record.id = map.get(record.id);
      rewritten += 1;
    }
    if (typeof record.supersedes === 'string' && map.has(record.supersedes)) {
      record.supersedes = map.get(record.supersedes);
    }
    out.push(JSON.stringify(record));
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${out.join('\n')}\n`, 'utf8');
  renameSync(tmp, path);
}

// 索引是派生物：删掉重建，让新 id 生效。重建前先把 `idem:*` 导出来——
// 它的 key 是客户端传的 idempotency_key，只存在 meta 里，重建后就没了。
const idemBefore = (() => {
  try {
    const probe = openDb(config.indexFile);
    const rows = probe.prepare("SELECT key, value FROM meta WHERE key LIKE 'idem:%'").all();
    probe.close();
    return rows;
  } catch {
    return [];
  }
})();

const indexFile = config.indexFile;
if (existsSync(indexFile)) rmSync(indexFile);
const db = openDb(indexFile);
const result = reindexAll(db, config);
const purged = purgeExpired(db);
// 写回 idem（值跟着 id 迁移；旧 id 不在映射里说明那条记忆已经没了，丢弃）。
let idemRestored = 0;
for (const row of idemBefore) {
  const next = map.get(row.value);
  if (next) {
    setMeta(db, row.key, next);
    idemRestored += 1;
  }
}
// dedupe:* 从 JSONL 重算——可计算，不必备份。
const dedupeRestored = rebuildDedupeKeys(db, config);
db.close();

console.log(
  JSON.stringify(
    {
      ...summary,
      backupDir,
      rewrittenRows: rewritten,
      reindex: { docs: result.docs, facts: result.facts, chunks: result.chunks },
      purged,
      meta: { idemRestored, idemDropped: idemBefore.length - idemRestored, dedupeRestored },
    },
    null,
    2,
  ),
);
