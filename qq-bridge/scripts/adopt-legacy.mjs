#!/usr/bin/env node
/**
 * 接管 / 丢弃 10-23 迁移进来的历史条目（它们只有 import: 副本，没有身份键）。
 *
 *   node scripts\adopt-legacy.mjs --list                       # 只看有哪些可接管
 *   node scripts\adopt-legacy.mjs --adopt qq:private:1225292178:黑天炎 --apply
 *   node scripts\adopt-legacy.mjs --drop  qq:private:1793813578:404 --apply
 *
 * `--adopt`：用身份键重写一份完整文本，再把 import: 旧副本 tombstone →
 *            对账从 legacy 变 present，以后编辑/删除能精确命中。
 * `--drop` ：删掉 light 层条目（走 memory-remove）+ tombstone import: 副本 →
 *            两层都不留，适合「数据太少、不值得留」的。
 *
 * 安全：
 *   - 不加 --apply 一律只打印计划（dry-run）；
 *   - 只操作显式点名的那一条，不做批量猜测；
 *   - 每个动作写 logs/reconcile/adopt-<日期>.jsonl，含旧文档 id 与文本摘要，可逐条回滚。
 */
import { existsSync, appendFileSync, readFileSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mirrorKey } from '../src/memory/idem.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BRIDGE = process.env.BRIDGE_DIR
  || [ROOT, resolve(ROOT, '..', '..', 'qq-bridge')].find((candidate) => existsSync(join(candidate, 'state', 'social-v2.json')))
  || ROOT;
const INDEX = process.env.MEMD_INDEX
  || [resolve(ROOT, '..', 'memory-hub', 'data', 'index.db'), resolve(ROOT, '..', 'data', 'index.db')]
    .find((candidate) => existsSync(candidate))
  || resolve(ROOT, '..', 'memory-hub', 'data', 'index.db');
const OUT_DIR = join(BRIDGE, 'logs', 'reconcile');
const apply = process.argv.includes('--apply');

const argOf = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return '';
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : '';
};
const sceneArg = argOf('adopt') || argOf('drop');
const mode = process.argv.includes('--drop') ? 'drop' : process.argv.includes('--adopt') ? 'adopt' : '';

const config = JSON.parse(readFileSync(join(BRIDGE, 'config.json'), 'utf8'));
const ownerQQ = String(config.ownerQQ ?? '');
const social = JSON.parse(readFileSync(join(BRIDGE, 'state', 'social-v2.json'), 'utf8'));

function convKeyOf(scene) {
  if (scene === 'qq:owner') return `private:${ownerQQ}`;
  if (scene.startsWith('qq:group:')) return `group:${scene.slice('qq:group:'.length)}`;
  if (scene.startsWith('qq:private:')) return `private:${scene.slice('qq:private:'.length)}`;
  return '';
}
function tokenFileForScene(scene) {
  const tokens = config.memory?.tokens ?? {};
  const file = scene === 'qq:owner' ? tokens.owner : scene.startsWith('qq:group:') ? tokens.group : scene.startsWith('qq:private:') ? tokens[scene.slice('qq:private:'.length)] : null;
  if (!file) return null;
  const abs = resolve(BRIDGE, file);
  return existsSync(abs) ? abs : null;
}
async function call(path, body, tokenFile) {
  const base = String(config.memory?.endpoint ?? '').replace(/\/$/, '');
  const token = readFileSync(tokenFile, 'utf8').trim();
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': token, authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} -> ${response.status} ${JSON.stringify(json)}`);
  return json;
}
async function consolePost(path, body) {
  const token = readFileSync(join(BRIDGE, 'state', 'console-token'), 'utf8').trim();
  const response = await fetch(`http://127.0.0.1:3100${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} -> ${response.status} ${JSON.stringify(json)}`);
  return json;
}

/* ---------- 列出可接管的历史条目 ---------- */
const db = new DatabaseSync(INDEX, { readOnly: true });
const rows = db.prepare("select doc_id, audience, text from chunks where kind = 'qq-impression'").all();
db.close();
const importDocs = [];
const byDoc = new Map();
for (const row of rows) {
  const entry = byDoc.get(row.doc_id) ?? { id: row.doc_id, audience: row.audience, text: '' };
  entry.text += row.text;
  byDoc.set(row.doc_id, entry);
}
for (const doc of byDoc.values()) {
  if (!doc.id.startsWith('import:')) continue;
  let audience = [];
  try {
    audience = JSON.parse(doc.audience);
  } catch {
    audience = [doc.audience];
  }
  importDocs.push({ ...doc, scene: audience[0] ?? '' });
}

const candidates = [];
for (const [convKey, conv] of Object.entries(social.conversations ?? {})) {
  const scene = convKey.startsWith('group:') ? `qq:group:${convKey.slice(6)}` : convKey.endsWith(`:${ownerQQ}`) ? 'qq:owner' : `qq:private:${convKey.split(':')[1]}`;
  for (const [target, im] of Object.entries(conv.memberImpressions ?? {})) {
    const text = Array.isArray(im?.traits) ? im.traits.join('、') : '';
    const doc = importDocs.find((d) => d.scene === scene && d.text.includes(text.slice(0, 20)));
    candidates.push({ scene, convKey, target, id: im?.id, rev: im?.rev, text, importDoc: doc ?? null });
  }
}

if (process.argv.includes('--list') || !mode) {
  console.log(`可接管 / 丢弃的历史条目（${candidates.length}）`);
  for (const c of candidates) {
    console.log(`  ${c.scene}:${c.target}  id=${c.id} rev=${c.rev}  import=${c.importDoc?.id ?? '(无)'}`);
    console.log(`      ${c.text.slice(0, 70)}`);
  }
  process.exit(0);
}

/* ---------- 执行单条 ---------- */
const [scene, target] = sceneArg.split(/:(?=[^:]+$)/);
const candidate = candidates.find((c) => c.scene === scene && c.target === target);
if (!candidate) {
  console.error(`找不到条目：${sceneArg}`);
  process.exit(1);
}

const tokenFile = tokenFileForScene(scene);
if (!tokenFile) {
  console.error(`没有该场景的令牌：${scene}`);
  process.exit(1);
}

console.log(`模式：${mode}  条目：${scene}:${target}  import 副本：${candidate.importDoc?.id ?? '(无)'}`);
console.log(`  文本：${candidate.text.slice(0, 80)}`);

const key = mirrorKey(scene, 'memberImpression', { id: candidate.id, rev: candidate.rev, target }, candidate.text);
const plan = mode === 'adopt'
  ? [
      { action: 'write', path: '/v1/write', body: { kind: 'qq-impression', text: candidate.text, scene, audience: [scene], privacy: 'personal', tags: ['memberImpression'], idempotency_key: key } },
      ...(candidate.importDoc ? [{ action: 'forget-import', path: '/v1/forget', body: { id: candidate.importDoc.id } }] : []),
    ]
  : [
      { action: 'remove-light', console: { path: '/api/socialV2/memory-remove', body: { key: candidate.convKey, category: 'memberImpression', target } } },
      ...(candidate.importDoc ? [{ action: 'forget-import', path: '/v1/forget', body: { id: candidate.importDoc.id } }] : []),
    ];

console.log(`计划：${plan.map((step) => step.action).join(' → ')}  身份键：${key}`);
if (!apply) {
  console.log('\ndry-run：加 --apply 才执行。');
  process.exit(0);
}

mkdirSync(OUT_DIR, { recursive: true });
const logFile = join(OUT_DIR, `adopt-${new Date().toISOString().slice(0, 10)}.jsonl`);
const record = (entry) => appendFileSync(logFile, `${JSON.stringify({ ts: new Date().toISOString(), mode, scene, target, ...entry })}\n`, 'utf8');

for (const step of plan) {
  try {
    if (step.console) {
      await consolePost(step.console.path, step.console.body);
      record({ action: step.action, ok: true });
    } else {
      const result = await call(step.path, step.body, tokenFile);
      record({ action: step.action, ok: true, ...step.body, result });
    }
    console.log(`  OK  ${step.action}`);
  } catch (error) {
    record({ action: step.action, ok: false, error: String(error?.message ?? error) });
    console.log(`  FAIL ${step.action}: ${error?.message ?? error}`);
    process.exit(1);
  }
}
console.log(`\n完成，记录：${logFile}`);
