#!/usr/bin/env node
/**
 * 只读核对：social-v2 的轻量条目 ↔ memd 里的 qq-* 文档，到底都是些什么。
 *
 *   node scripts\audit-mirror.mjs [--json]
 *
 * 输出四张清单（正文一律截断，避免把私聊原文刷到终端）：
 *   A. 轻量层现存条目：id / rev / 场景 / 内容摘要 / 最近提起时间
 *   B. 每条轻量记忆在 memd 里的对应物：精确副本、近似副本、还是没有
 *   C. memd 里的 qq-* 文档按来源分组：摘要 / 迁移 / 演练 / 历史遗留
 *   D. 孤儿 idem 键：键还在、但对应的轻量条目已经不存在了
 *
 * 只读：不写 memd、不改 social-v2。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { idemKey, mirrorKey } from '../src/memory/idem.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// 桥接部署目录本身就带 state/；从仓库里的 vendored 副本跑时没有 state/，要靠 BRIDGE_DIR。
const BRIDGE = process.env.BRIDGE_DIR
  || [ROOT, resolve(ROOT, '..', '..', 'qq-bridge')].find((candidate) => existsSync(join(candidate, 'state', 'social-v2.json')))
  || ROOT;
const indexFile = process.env.MEMD_INDEX
  || [resolve(ROOT, '..', 'memory-hub', 'data', 'index.db'), resolve(ROOT, '..', 'data', 'index.db')]
    .find((candidate) => existsSync(candidate))
  || resolve(ROOT, '..', 'memory-hub', 'data', 'index.db');
const wantJson = process.argv.includes('--json');

const clip = (value, n = 40) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > n ? `${text.slice(0, n)}…` : text;
};
const day = (ms) => (ms ? new Date(Number(ms)).toISOString().slice(0, 16).replace('T', ' ') : '-');

const social = JSON.parse(readFileSync(join(BRIDGE, 'state', 'social-v2.json'), 'utf8'));
const config = (() => {
  try {
    return JSON.parse(readFileSync(join(BRIDGE, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
})();
const ownerQQ = String(config.ownerQQ ?? '');

const sceneOf = (key) => {
  const i = key.indexOf(':');
  const kind = i === -1 ? '' : key.slice(0, i);
  const id = i === -1 ? key : key.slice(i + 1);
  if (kind === 'group') return `qq:group:${id}`;
  if (id === ownerQQ) return 'qq:owner';
  return `qq:private:${id}`;
};

/* ---------- A：轻量层现存条目 ---------- */
const entries = [];
for (const [convKey, conv] of Object.entries(social.conversations ?? {})) {
  const scene = sceneOf(convKey);
  for (const t of conv.activeTopics ?? []) {
    entries.push({ scene, convKey, category: 'activeTopic', id: t.id, rev: t.rev, text: t.text, at: t.lastMentionAt });
  }
  for (const t of conv.pendingThoughts ?? []) {
    entries.push({ scene, convKey, category: 'pendingThought', id: t.id, rev: t.rev, text: t.text, at: t.createdAt });
  }
  for (const [target, im] of Object.entries(conv.memberImpressions ?? {})) {
    const text = Array.isArray(im?.traits) ? im.traits.join('、') : '';
    entries.push({ scene, convKey, category: 'memberImpression', target, id: im?.id, rev: im?.rev, text, at: im?.lastSeenAt, traits: im?.traits?.length ?? 0 });
  }
}

/* ---------- 读索引 ---------- */
const db = new DatabaseSync(indexFile, { readOnly: true });
const rows = db.prepare("select doc_id, kind, audience, text, title, updated_at from chunks where kind in ('qq-topic','qq-impression')").all();
const docs = new Map();
for (const row of rows) {
  let audience = [];
  try {
    audience = JSON.parse(row.audience);
  } catch {
    audience = [row.audience];
  }
  const doc = docs.get(row.doc_id) ?? { id: row.doc_id, kind: row.kind, scenes: new Set(), text: '', updatedAt: 0 };
  for (const a of audience) doc.scenes.add(String(a));
  doc.text += `${row.text}\n`;
  doc.updatedAt = Math.max(doc.updatedAt, Number(row.updated_at) || 0);
  docs.set(row.doc_id, doc);
}
const idem = new Map(db.prepare("select key, value from meta where key like 'idem:%'").all().map((r) => [String(r.key).slice(5), r.value]));
const tombstoned = new Set(db.prepare("select value from meta where key like 'tomb:%'").all().map((r) => r.value));
const docsById = new Map([...docs.values()].map((d) => [d.id, d]));
db.close();

const norm = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

/* ---------- B：每条轻量记忆的对应物 ---------- */
const matches = [];
for (const entry of entries) {
  const key = mirrorKey(entry.scene, entry.category, entry, entry.text);
  const legacy = idemKey(entry.scene, entry.category, entry, entry.text);
  const exact = idem.get(key);
  const viaLegacy = idem.get(legacy);
  const textHit = [...docs.values()].find((d) => d.kind === (entry.category === 'memberImpression' ? 'qq-impression' : 'qq-topic') && d.scenes.has(entry.scene) && norm(d.text).includes(norm(entry.text)));
  const partialHit = textHit ? undefined : [...docs.values()].find((d) => d.kind === (entry.category === 'memberImpression' ? 'qq-impression' : 'qq-topic') && d.scenes.has(entry.scene) && norm(d.text).includes(norm(entry.text).slice(0, 30)));
  matches.push({
    ...entry,
    status: exact ? 'exact-new-key' : viaLegacy ? 'legacy-key' : textHit ? 'text-copy' : partialHit ? 'partial-copy' : 'missing',
    docId: exact ?? viaLegacy ?? textHit?.id ?? partialHit?.id ?? null,
  });
}

/* ---------- C：memd 里的 qq-* 按来源分组 ---------- */
const groups = { digest: [], import: [], drill: [], legacyNote: [], other: [] };
for (const doc of docs.values()) {
  if (doc.id.startsWith('import:')) groups.import.push(doc);
  else if (/演练|身份演练/.test(doc.text)) groups.drill.push(doc);
  else if (/^\[(群|聊天)摘要\]/.test(norm(doc.text))) groups.digest.push(doc);
  else if (/^\[(笔记|digest)\]/.test(norm(doc.text))) groups.legacyNote.push(doc);
  else groups.other.push(doc);
}

/* ---------- D：孤儿 idem 键 ---------- */
const liveKeys = new Set(entries.map((e) => mirrorKey(e.scene, e.category, e, e.text)));
const legacyKeys = new Set(entries.map((e) => idemKey(e.scene, e.category, e, e.text)));
const orphan = [...idem.entries()]
  .filter(([key]) => !liveKeys.has(key) && !legacyKeys.has(key))
  .map(([key, docId]) => ({ key, docId, live: docsById.has(docId), text: docsById.get(docId)?.text ?? '' }));

const output = { generatedAt: new Date().toISOString(), index: indexFile, entries, matches, groups: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])), orphan: orphan.length, detail: { groups, orphan } };
console.log(`核对 ${output.generatedAt}  索引 ${indexFile}`);
console.log(`\nA. 轻量层现存 ${entries.length} 条`);
for (const e of entries) {
  console.log(`  [${e.category}] ${e.scene} id=${e.id ?? '-'} rev=${e.rev ?? '-'} ${e.target ? `target=${e.target} ` : ''}${day(e.at)}`);
  console.log(`      ${clip(e.text, 60)}`);
}
console.log('\nB. 每条在 memd 里的对应物');
for (const m of matches) {
  console.log(`  ${m.status.padEnd(14)} ${m.category.padEnd(17)} ${m.docId ?? '(无)'}  ${clip(m.text, 40)}`);
}
console.log('\nC. memd 里的 qq-* 文档（共 ' + docs.size + '）');
for (const [name, list] of Object.entries(groups)) {
  if (!list.length) continue;
  const inputs = list.filter((d) => d.id.startsWith('import:')).length;
  console.log(`  ${name.padEnd(11)} ${String(list.length).padStart(3)} 条` + (inputs ? `（其中 import: ${inputs}）` : ''));
  for (const d of list.slice(0, 3)) console.log(`      ${d.id.padEnd(26)} ${day(d.updatedAt)} ${clip(d.text, 46)}`);
}
console.log(`\nD. 孤儿 idem 键 ${orphan.length} 个`);
const orphanLive = orphan.filter((o) => o.live);
console.log(`  指向的文档仍存在：${orphanLive.length}；指向已删除：${orphan.length - orphanLive.length}`);
for (const o of orphanLive.slice(0, 5)) console.log(`      ${clip(o.key, 46)} → ${o.docId} ${clip(o.text, 32)}`);

if (wantJson) console.log(JSON.stringify(output, null, 2));
