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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../packages/server/dist/config.js';
import { openDb } from '../packages/server/dist/db.js';
import { reindexAll } from '../packages/server/dist/indexer.js';
import { searchChunks } from '../packages/server/dist/search.js';
import { SemanticManager } from '../packages/server/dist/semantic.js';

const argv = process.argv.slice(2);
const requireSemantic = argv.includes('--require-semantic');
const baselineMode = argv.includes('--baseline');
const updateBaseline = argv.includes('--update');
const extraQueries = argv.filter((arg) => !arg.startsWith('--'));

const config = loadConfig();
const db = openDb(config.indexFile);
const index = reindexAll(db, config);
console.log(`index: docs=${index.docs} facts=${index.facts} chunks=${index.chunks} changed=${index.changed}\n`);

// 与服务里 root token 的可见范围一致：主会话可读敏感。
const token = { surface: 'main', scopes: ['*', 'sensitive:read', 'work:read'], scenes: ['main'] };
const params = (query) => ({ query, k: 3, maxChars: 80, token, scene: 'main' });

/* ------------------------------------------------------------------ */
/* 检索基线（方案第十三节）：同一批查询、同一批锚点，每次比排名升降。      */
/* 只报告，不阻塞——退出码恒 0（除非还没生成基线）。                      */
/* ------------------------------------------------------------------ */

const BASELINE_FILE = join(config.dataDir, 'recall-baseline.json');

// 12 条查询，覆盖中文短语 / 长口语 / 时间线 / 跨场景 / 近期。
// 故意用「跟正文措辞不完全一致」的说法，才能测到召回而不是精确串匹配。
const BASELINE_QUERIES = [
  { id: 'q01', query: '记忆对账', note: '中文短语' },
  { id: 'q02', query: '桌宠', note: '中文短语' },
  { id: 'q03', query: 'QQ 桥接', note: '中文短语' },
  { id: 'q04', query: '夜间整理', note: '中文短语' },
  { id: 'q05', query: '我当时是怎么判断要不要上 GPU 的', note: '长口语' },
  { id: 'q06', query: '计划任务为什么会弹黑框', note: '长口语' },
  { id: 'q07', query: '打游戏的时候会不会被占资源', note: '长口语' },
  { id: 'q08', query: '上个月都做了些什么', note: '时间线类' },
  { id: 'q09', query: '昨晚实现了什么', note: '时间线类' },
  { id: 'q10', query: '群里聊天说的内容', note: '跨场景' },
  { id: 'q11', query: '今天做了什么', note: '近期' },
  { id: 'q12', query: '最近定了哪些决定', note: '近期' },
];

function runBaseline(update) {
  console.log('== 检索基线（只报告，不阻塞）==\n');
  const current = BASELINE_QUERIES.map((item) => {
    const outcome = searchChunks(db, { query: item.query, k: 10, maxChars: 600, token, scene: 'main' });
    return { ...item, hits: outcome.hits };
  });

  if (update) {
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      // 锚点 = 当前 top-3 的 id（去掉 chunk 的 `#序号`，落到文档/记忆本身——
      // 否则文档一更新分块重排，锚点就集体失效）。比「记全部命中」稳，也比「只记 top1」宽容。
      queries: current.map((item) => ({
        id: item.id,
        query: item.query,
        note: item.note,
        top: [...new Set(item.hits.map((hit) => String(hit.id).split('#')[0]))].slice(0, 3),
      })),
    };
    writeFileSync(BASELINE_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(`基线已写入 ${BASELINE_FILE}（${payload.queries.length} 条查询，锚点 top-3）\n`);
  }

  if (!existsSync(BASELINE_FILE)) {
    console.error(`还没有基线文件：${BASELINE_FILE}`);
    console.error('先生成一次：node scripts/verify-recall.mjs --baseline --update');
    return 1;
  }

  const saved = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
  const byId = new Map((saved.queries ?? []).map((item) => [item.id, item]));
  const tally = { same: 0, up: 0, down: 0, gone: 0, missing: 0 };
  const details = [];

  for (const item of current) {
    const anchor = byId.get(item.id);
    if (!anchor) {
      tally.missing += 1;
      continue;
    }
    const ranked = [...new Set(item.hits.map((hit) => String(hit.id).split('#')[0]))];
    const anchors = (anchor.top ?? []).map((id, index) => ({
      id,
      before: index + 1,
      after: ranked.indexOf(id) + 1, // 0 = 掉出 top-10
    }));
    // 判定看主锚点（基线里的 top-1）：平均法会把「1↔3 互换」判成持平，
    // 而那正是最值得报的退化。
    const primary = anchors[0];
    const aux = anchors.slice(1);
    const auxAlive = aux.filter((entry) => entry.after > 0).length;
    let verdict;
    if (!primary || primary.after === 0) verdict = 'gone';
    else if (primary.after > primary.before) verdict = 'down';
    else if (primary.after < primary.before) verdict = 'up';
    else if (aux.length > 0 && auxAlive === 0) verdict = 'down'; // 主锚点没动、其余全掉出去
    else verdict = 'same';
    tally[verdict] += 1;
    details.push({ item, verdict, anchors, anchor });
  }

  const label = { same: '保持', up: '上升', down: '下降', gone: '未命中' };
  for (const { item, verdict, anchors, anchor } of details) {
    const moved = anchors.map((entry) => `${entry.before}→${entry.after || '出局'}`).join(' ');
    const query = item.query.length > 16 ? `${item.query.slice(0, 16)}…` : item.query;
    console.log(`${label[verdict]}  ${item.id}「${query}」  ${moved}`);
    if (verdict === 'gone') {
      console.log(`      锚点全部掉出 top-10（基线记了 ${anchor.top.length} 个）：确认是不是被 forget，或索引没重建`);
    }
  }

  const total = tally.same + tally.up + tally.down + tally.gone;
  console.log(
    `\n${total} 查询：${tally.same} 保持，${tally.up} 上升，${tally.down} 下降，${tally.gone} 未命中` +
      (tally.missing > 0 ? `，${tally.missing} 条基线里没有` : ''),
  );
  if (tally.down > 0 || tally.gone > 0) {
    console.log('排名变差是报告项，不是失败——确认这是有意改动后再 --update 重写基线。');
  }
  return 0;
}

if (baselineMode) {
  const code = runBaseline(updateBaseline);
  db.close();
  process.exit(code);
}

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
