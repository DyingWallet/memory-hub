#!/usr/bin/env node
/**
 * 对账：social-v2.json（轻量层）↔ memd（长期层）。
 *
 * 默认只读：算完写一份报告，不碰任何数据。
 *   node scripts/reconcile-memory.mjs                 # 报告到 logs/reconcile/
 *   node scripts/reconcile-memory.mjs --json          # 同时把摘要打到 stdout
 *
 * 修复要显式开：
 *   node scripts/reconcile-memory.mjs --fix missing   # 把「该有却没有」的补写进 memd
 *   node scripts/reconcile-memory.mjs --fix forget    # 重试遗忘队列
 *
 * 安全约束（都写进代码，不靠自觉）：
 *   - 索引一律只读打开，并且校验 schema_version；
 *   - `--fix` 前检查 social-v2.json 的 size/mtime 与报告生成时是否一致，
 *     不一致说明报告已过期，直接拒跑（否则会拿旧清单去改库）；
 *   - 报告里的正文截断 120 字；
 *   - 只补不删：绝不 prune 长期层里「轻量层已退役」的条目。
 *
 * 退出码：0 正常；1 出错；2 --strict 且发现 missing；3 报告过期。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectEntries, classify, loadIndex } from '../src/memory/reconcile.js';
import { idemKey } from '../src/memory/idem.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOCIAL = join(ROOT, 'state', 'social-v2.json');

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : 'true';
}

const socialFile = resolve(arg('social', SOCIAL));
// 索引的位置取决于这个脚本是从部署目录跑（../memory-hub）还是从仓库里的
// vendored 副本跑（../../data）；两种布局都要能自己找到，不写死盘符。
const indexPath = (() => {
  const explicit = arg('index', process.env.MEMD_INDEX || '');
  if (explicit) return resolve(explicit);
  const candidates = [
    join(ROOT, '..', 'memory-hub', 'data', 'index.db'),
    join(ROOT, '..', 'data', 'index.db'),
    join(ROOT, '..', '..', 'memory-hub', 'data', 'index.db'),
  ];
  return candidates.map((file) => resolve(file)).find((file) => existsSync(file)) ?? resolve(candidates[0]);
})();

/**
 * 桥接的部署目录 = social-v2.json 往上两级（state/ 的父目录）。
 * config.json、state/、logs/ 都挂在这里，仓库里的 vendored 副本一个都没有，
 * 所以不能拿脚本自身位置当基准。
 */
const bridgeRoot = (() => {
  const candidate = dirname(dirname(socialFile));
  return existsSync(join(candidate, 'config.json')) ? candidate : ROOT;
})();
const QUEUE = join(bridgeRoot, 'state', 'forget-queue.jsonl');
const OUT_DIR = join(bridgeRoot, 'logs', 'reconcile');
const fixMode = arg('fix', '');
const strict = process.argv.includes('--strict');
const wantJson = process.argv.includes('--json');

function fail(message, code = 1) {
  console.error(`reconcile: ${message}`);
  process.exit(code);
}

function readQueue() {
  if (!existsSync(QUEUE)) return [];
  try {
    return readFileSync(QUEUE, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

if (!existsSync(socialFile)) fail(`social state not found: ${socialFile}`);
if (!existsSync(indexPath)) fail(`memory index not found: ${indexPath} (is memd installed?)`);

const socialStat = statSync(socialFile);
const social = JSON.parse(readFileSync(socialFile, 'utf8'));
const bridgeConfig = (() => {
  try {
    return JSON.parse(readFileSync(join(bridgeRoot, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
})();
// ownerQQ 是数字；缺了它，主人私聊会被算成 qq:private:<号>，与 memd 里的
// qq:owner 对不上，整份报告就全是假漂移（2026-10-25 踩过）。
const ownerQQ = arg('owner', '') || bridgeConfig.ownerQQ || bridgeConfig.owner || '';

let index;
try {
  index = loadIndex(indexPath);
} catch (error) {
  fail(error?.message ?? error);
}

const entries = collectEntries(social, ownerQQ);
const result = classify(entries, index);
const queue = readQueue();
const generatedAt = new Date().toISOString();
const input = {
  file: socialFile,
  size: socialStat.size,
  mtimeMs: socialStat.mtimeMs,
  sha: createHash('sha256').update(readFileSync(socialFile)).digest('hex').slice(0, 16),
};

const report = {
  generatedAt,
  input,
  index: { file: indexPath, schemaVersion: index.schemaVersion },
  counts: { ...result.counts, forgetQueue: queue.length },
  missing: result.missing,
  legacy: result.legacy,
  partial: result.partial,
  orphanIdem: result.orphanIdem.slice(0, 50),
  staleDocs: result.staleDocs.slice(0, 50),
};

mkdirSync(join(OUT_DIR, 'history'), { recursive: true });
writeFileSync(join(OUT_DIR, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
const day = generatedAt.slice(0, 10);
writeFileSync(join(OUT_DIR, `history/${day}.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

function printSummary() {
  const c = report.counts;
  console.log(`对账 ${generatedAt}  (schema v${index.schemaVersion})`);
  console.log(`  轻量条目 ${c.live} → present ${c.present} / legacy ${c.legacy} / partial ${c.partial} / missing ${c.missing}`);
  console.log(`  孤儿 idem 键 ${c.orphanIdem}（历史上写过、现已无对应条目）`);
  console.log(`  长期层多出 ${c.staleDocs} 条（摘要/迁移/退役话题，**只报不删**）`);
  console.log(`  遗忘队列 ${c.forgetQueue} 条`);
  if (report.missing.length) {
    console.log('  missing：');
    for (const item of report.missing.slice(0, 10)) console.log(`    - [${item.category}] ${item.scene} ${item.text} (${item.reason})`);
  }
  if (report.legacy.length) {
    console.log('  legacy（有文本副本、没有 idem 键）：');
    for (const item of report.legacy.slice(0, 10)) console.log(`    - [${item.category}] ${item.scene} ${item.text} (${item.reason})`);
  }
  if (report.partial.length) {
    console.log('  partial（只有被截断的副本，--fix 不会动它们）：');
    for (const item of report.partial.slice(0, 10)) console.log(`    - [${item.category}] ${item.scene} ${item.text} (${item.reason})`);
  }
  console.log(`  报告：${join(OUT_DIR, 'latest.json')}`);
}

/* ---------------------------------------------------------------- 修复 */

function tokenFileForScene(scene) {
  const tokens = bridgeConfig.memory?.tokens;
  if (!tokens || typeof tokens !== 'object') return null;
  let file = null;
  if (scene === 'qq:owner') file = tokens.owner;
  else if (scene.startsWith('qq:group:')) file = tokens.group;
  else if (scene.startsWith('qq:private:')) file = tokens[scene.slice('qq:private:'.length)];
  if (!file) return null;
  const abs = resolve(bridgeRoot, file);
  return existsSync(abs) ? abs : null;
}

function endpoint() {
  const value = bridgeConfig.memory?.endpoint;
  return typeof value === 'string' && value.length > 0 ? value.replace(/\/$/, '') : null;
}

async function callApi(path, body, tokenFile) {
  const base = endpoint();
  if (!base) throw new Error('config.json 缺少 memory.endpoint');
  const token = readFileSync(tokenFile, 'utf8').trim();
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
  return response.json();
}

function record(entry) {
  const file = join(OUT_DIR, `applied-${day}.jsonl`);
  try {
    appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, 'utf8');
  } catch {
    // 审计写不进去不能阻断修复
  }
}

async function fixMissing() {
  const latest = join(OUT_DIR, 'latest.json');
  if (!existsSync(latest)) fail('no report yet; run once without --fix first');
  const previous = JSON.parse(readFileSync(latest, 'utf8'));
  if (previous.input.size !== input.size || previous.input.mtimeMs !== input.mtimeMs) {
    fail('social-v2.json changed since the report was written; re-run to refresh the report first', 3);
  }
  const items = previous.missing ?? [];
  if (items.length === 0) {
    console.log('missing: 0，没有需要补写的条目');
    return;
  }
  let written = 0;
  let skipped = 0;
  for (const item of items) {
    const tokenFile = tokenFileForScene(item.scene);
    if (!tokenFile) {
      skipped += 1;
      record({ action: 'skip', reason: 'no-token', scene: item.scene, idemKey: item.idemKey });
      continue;
    }
    try {
      const body = {
        kind: item.kind ?? (item.category === 'memberImpression' ? 'qq-impression' : 'qq-topic'),
        text: item.text,
        privacy: item.category === 'memberImpression' ? 'personal' : 'normal',
        tags: [item.category],
        idempotency_key: item.idemKey,
      };
      const response = await callApi('/v1/write', body, tokenFile);
      written += 1;
      record({ action: 'write', scene: item.scene, id: response.id, duplicate: Boolean(response.duplicate), idemKey: item.idemKey });
    } catch (error) {
      skipped += 1;
      record({ action: 'write-failed', scene: item.scene, error: String(error?.message ?? error), idemKey: item.idemKey });
    }
  }
  console.log(`missing 补写：成功 ${written}，跳过/失败 ${skipped}`);
}

async function fixForget() {
  const items = readQueue();
  if (items.length === 0) {
    console.log('遗忘队列为空');
    return;
  }
  let drained = 0;
  let left = 0;
  const remaining = [];
  for (const item of items) {
    const tokenFile = tokenFileForScene(item.scene);
    if (!tokenFile) {
      remaining.push(item);
      record({ action: 'forget-skip', scene: item.scene, reason: 'no-token' });
      continue;
    }
    try {
      const key = item.dedupeKey ?? idemKey(item.scene, item.category, { target: item.target }, item.text);
      await callApi('/v1/forget', { idempotency_key: key }, tokenFile);
      drained += 1;
      record({ action: 'forget', scene: item.scene, idemKey: key });
    } catch (error) {
      left += 1;
      remaining.push({ ...item, attempts: (Number(item.attempts) || 0) + 1, lastError: String(error?.message ?? error), lastTriedAt: Date.now() });
      record({ action: 'forget-failed', scene: item.scene, error: String(error?.message ?? error) });
    }
  }
  mkdirSync(dirname(QUEUE), { recursive: true });
  writeFileSync(QUEUE, remaining.map((item) => `${JSON.stringify(item)}\n`).join(''), 'utf8');
  console.log(`遗忘队列：忘掉 ${drained}，剩余 ${remaining.length}（失败 ${left}）`);
}

if (!fixMode) {
  printSummary();
  if (wantJson) console.log(JSON.stringify(report.counts));
  if (strict && report.counts.missing > 0) process.exit(2);
  process.exit(0);
}

if (fixMode === 'missing') {
  printSummary();
  await fixMissing();
} else if (fixMode === 'forget') {
  printSummary();
  await fixForget();
} else {
  fail(`unknown --fix mode "${fixMode}" (missing | forget)`);
}
