/**
 * 检索回归检查：先跑 FTS 基线，再（若可用）跑语义混合，确认「基线不下降、语义有新召回」。
 *
 *   node scripts/verify-recall.mjs                  # 基线 + 语义（不可用则跳过）
 *   node scripts/verify-recall.mjs --require-semantic   # 语义不可用就判失败
 *   node scripts/verify-recall.mjs 记忆 桌宠         # 追加自定义 FTS 查询
 *
 * 判定口径（内容无关，避免写死某篇文档）：
 *   1. FTS 基线：每条默认查询至少 1 条命中（与 v1 行为一致）；
 *   2. 语义组：混合结果至少 1 条命中，且与 FTS 结果有交集（不把基线挤掉）；
 *   3. 改进证据：至少有一组语义查询召回了 FTS 没给出的 chunk。
 * 语义不可用时默认只提示并退出 0（降级是预期行为）；带 --require-semantic 则退出 1。
 */
import { performance } from 'node:perf_hooks';
import { loadConfig } from '../packages/server/dist/config.js';
import { openDb } from '../packages/server/dist/db.js';
import { reindexAll } from '../packages/server/dist/indexer.js';
import { searchChunks } from '../packages/server/dist/search.js';
import { SemanticManager } from '../packages/server/dist/semantic.js';

const argv = process.argv.slice(2);
const requireSemantic = argv.includes('--require-semantic');
const extraQueries = argv.filter((arg) => !arg.startsWith('--'));

const config = loadConfig();
const db = openDb(config.indexFile);
const index = reindexAll(db, config);
console.log(`index: docs=${index.docs} facts=${index.facts} chunks=${index.chunks} changed=${index.changed}\n`);

// 与服务里 root token 的可见范围一致：主会话可读敏感。
const token = { surface: 'main', scopes: ['*', 'sensitive:read', 'work:read'], scenes: ['main'] };
const params = (query) => ({ query, k: 3, maxChars: 80, token, scene: 'main' });

const BASELINE = ['记忆', '桌宠', '记忆简报', 'QQ 桥接', '股票'];
const baseline = extraQueries.length > 0 ? [...BASELINE, ...extraQueries] : BASELINE;

// 语义查询：故意和库里的措辞错开，靠向量接近来命中。
const SEMANTIC_CASES = [
  '打游戏的时候会不会被占资源',
  '计划任务为什么会弹黑框',
  '桌宠会不会偷偷换成普通模型说话',
  '我当时是怎么判断要不要上 GPU 的',
];

let failures = 0;
const ftsIds = new Map();

console.log('== FTS 基线（不能退化）==');
for (const query of baseline) {
  const started = performance.now();
  const outcome = searchChunks(db, params(query));
  const ms = performance.now() - started;
  ftsIds.set(query, new Set(outcome.hits.map((hit) => hit.id)));
  const top = outcome.hits[0];
  if (outcome.hits.length === 0) failures += 1;
  console.log(
    `${outcome.hits.length === 0 ? 'MISS' : 'HIT '} ${query.padEnd(12)} ${ms.toFixed(1).padStart(6)}ms  ` +
      (top ? `${top.title} (${outcome.hits.length} hit)` : '(no results)'),
  );
}

const semanticConfig = { ...config.semantic, enabled: true };
const manager = new SemanticManager({
  db,
  config: semanticConfig,
  logger: { info: (m) => console.log(`[semantic] ${m}`), warn: (m) => console.log(`[semantic] ${m}`) },
  // 复现稳态：跟服务一样单线程。
  threads: 1,
});
const status = await manager.start();

if (!status.ready) {
  console.log(`\n== 语义检索：不可用（${status.reason ?? 'unknown'}）==`);
  if (requireSemantic) {
    console.error('semantic was required but is not available');
    failures += 1;
  } else {
    console.log('跳过语义对比（降级为纯 FTS 是预期行为；用 --require-semantic 强制要求）');
  }
} else {
  const started = Date.now();
  const backfill = await manager.backfill();
  console.log(
    `\n== 语义检索：已就绪（${status.model}, ${status.dim} 维, α=${status.alpha}）` +
      ` · 向量 ${manager.status.vectors}/${index.chunks}，补齐 ${backfill?.embedded ?? 0} 条用时 ${(
        (Date.now() - started) / 1000
      ).toFixed(1)}s ==`,
  );

  let improved = 0;
  for (const query of SEMANTIC_CASES) {
    const gone = performance.now();
    const hybrid = await manager.search(params(query), 3);
    const ms = performance.now() - gone;
    if (!hybrid || hybrid.hits.length === 0) {
      failures += 1;
      console.log(`MISS ${query.padEnd(12)} ${ms.toFixed(1).padStart(6)}ms  (no results)`);
      continue;
    }
    const fts = ftsIds.get(query) ?? new Set(searchChunks(db, params(query)).hits.map((hit) => hit.id));
    const overlap = hybrid.hits.filter((hit) => fts.has(hit.id)).length;
    const added = hybrid.hits.filter((hit) => !fts.has(hit.id));
    if (overlap === 0) failures += 1;
    if (added.length > 0) improved += 1;
    const top = hybrid.hits[0];
    console.log(
      `HIT  ${query.padEnd(12)} ${ms.toFixed(1).padStart(6)}ms  ${top.title}` +
        ` [语义新增 ${added.length} 条，与 FTS 重叠 ${overlap} 条]`,
    );
    for (const hit of hybrid.hits) {
      console.log(`       - ${hit.title} score=${hit.score.toFixed(3)}`);
    }
  }

  if (improved === 0) {
    failures += 1;
    console.error('\n语义没有带来任何新召回：检查向量是否补齐、模型是否选对。');
  } else {
    console.log(`\n语义召回提升：${improved}/${SEMANTIC_CASES.length} 组查询召回了 FTS 没有的 chunk。`);
  }
}

await manager.close();
db.close();

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nrecall verification passed');
