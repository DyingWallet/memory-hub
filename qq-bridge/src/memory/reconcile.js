/**
 * 两层记忆的对账逻辑（纯函数 + 只读索引加载）。
 *
 * 判定方向只有两个（**不做反向修剪**）：
 *   1. 轻量层有、长期层没有 → 该有却没有（missing）；
 *   2. 有，但只有文本副本、没有 idem 键 → legacy（2026-10-23 迁移进来的那批）。
 *
 * 明确不做：把「长期层比轻量层多」当成漂移。摘要是桥接自己写的、话题退役是
 * 轻量层的生命周期，长期层本来就该活得更久（见 40-decisions/2026-10-25-0012）。
 * 那些条目只统计成 staleDocs，供人看，不进任何修复路径。
 */
import { DatabaseSync } from 'node:sqlite';
import { idemKey } from './idem.js';

/** `packages/server/src/db.ts` 的 SCHEMA_VERSION；索引结构一变就该报警，而不是猜。 */
export const EXPECTED_SCHEMA_VERSION = '3';

export function sceneOfConversationKey(key, ownerQQ) {
  const raw = String(key ?? '');
  const index = raw.indexOf(':');
  const kind = index === -1 ? '' : raw.slice(0, index);
  const id = index === -1 ? raw : raw.slice(index + 1);
  if (kind === 'group') return `qq:group:${id}`;
  if (String(id) === String(ownerQQ ?? '')) return 'qq:owner';
  return `qq:private:${id}`;
}

/**
 * 把 social-v2.json 摊平成【应该存在于长期层】的条目清单。
 * activeTopics / pendingThoughts 记成 qq-topic，memberImpressions 记成 qq-impression
 * ——与 memory-bridge.js 的 mirrorWrite 映射保持一致。
 */
export function collectEntries(social, ownerQQ) {
  const entries = [];
  for (const [convKey, conv] of Object.entries(social?.conversations ?? {})) {
    if (!conv || typeof conv !== 'object') continue;
    const scene = sceneOfConversationKey(convKey, ownerQQ);
    for (const topic of conv.activeTopics ?? []) {
      const text = String(topic?.text ?? '').trim();
      if (text) entries.push({ convKey, scene, category: 'activeTopic', kind: 'qq-topic', text, privacy: 'normal' });
    }
    for (const thought of conv.pendingThoughts ?? []) {
      const text = String(thought?.text ?? '').trim();
      if (text) entries.push({ convKey, scene, category: 'pendingThought', kind: 'qq-topic', text, privacy: 'normal' });
    }
    for (const [target, impression] of Object.entries(conv.memberImpressions ?? {})) {
      const text = typeof impression === 'string' ? impression : String(impression?.text ?? impression?.traits ?? '');
      const trimmed = text.trim();
      if (trimmed) {
        entries.push({ convKey, scene, category: 'memberImpression', kind: 'qq-impression', text: trimmed, target, privacy: 'personal' });
      }
    }
  }
  return entries;
}

const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const clip = (value, limit = 120) => {
  const text = normalize(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};

/**
 * 只读打开索引。schema 版本对不上就直接抛错：宁可这份报告跑不出来，
 * 也不能拿错的表结构算出一份看起来正常的报告。
 */
export function loadIndex(indexFile) {
  const db = new DatabaseSync(indexFile, { readOnly: true });
  const schemaVersion = db.prepare("select value from meta where key = 'schema_version'").get()?.value;
  if (String(schemaVersion ?? '') !== EXPECTED_SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `index schema_version is ${JSON.stringify(schemaVersion)}, expected ${EXPECTED_SCHEMA_VERSION} — refusing to reconcile`,
    );
  }

  const chunks = db.prepare("select doc_id, kind, audience, text from chunks where kind in ('qq-topic','qq-impression')").all();
  const docs = new Map();
  for (const row of chunks) {
    let audience = [];
    try {
      audience = JSON.parse(row.audience);
    } catch {
      audience = [row.audience];
    }
    if (!Array.isArray(audience)) audience = [String(audience)];
    const doc = docs.get(row.doc_id) ?? { id: row.doc_id, kind: row.kind, scenes: new Set(), text: '' };
    for (const value of audience) doc.scenes.add(String(value));
    doc.text += `${row.text}\n`;
    docs.set(row.doc_id, doc);
  }

  const idemRows = db.prepare("select key, value from meta where key like 'idem:%'").all();
  const idem = new Map(idemRows.map((row) => [String(row.key).slice('idem:'.length), row.value]));
  db.close();

  return {
    schemaVersion: String(schemaVersion),
    docs: [...docs.values()].map((doc) => ({ ...doc, text: normalize(doc.text) })),
    idem,
  };
}

/**
 * 分类。返回的每一项都带 `reason`，方便人判断而不是只看一个数字。
 * reason: no-idem（从来没有键）/ doc-gone（键在、文档被删了）/ text-only（有文本副本没键）
 */
export function classify(entries, index) {
  const docById = new Map(index.docs.map((doc) => [doc.id, doc]));
  const present = [];
  const legacy = [];
  const partial = [];
  const missing = [];

  for (const entry of entries) {
    const key = idemKey(entry.scene, entry.category, { target: entry.target }, entry.text);
    const docId = index.idem.get(key);
    const doc = docId ? docById.get(docId) : undefined;
    if (doc && doc.kind === entry.kind) {
      present.push({ ...entry, idemKey: key, docId });
      continue;
    }
    const sameKindScene = (candidate) => candidate.kind === entry.kind && candidate.scenes.has(entry.scene);
    const textHit = index.docs.find((candidate) => sameKindScene(candidate) && candidate.text.includes(normalize(entry.text)));
    // 迁移/截断留下的副本：开头对得上、后面被切掉了。它既不是「写好了」，
    // 也不该算「完全没有」——真去 --fix 补写会多出一条近似重复。
    const partialHit = textHit
      ? undefined
      : index.docs.find((candidate) => sameKindScene(candidate) && candidate.text.includes(normalize(entry.text).slice(0, 30)));
    const reason = docId ? (doc ? 'kind-mismatch' : 'doc-gone') : textHit ? 'text-only' : partialHit ? 'partial-text' : 'no-idem';
    const record = {
      convKey: entry.convKey,
      scene: entry.scene,
      category: entry.category,
      ...(entry.target ? { target: entry.target } : {}),
      text: clip(entry.text),
      idemKey: key,
      reason,
      ...(textHit && textHit.id !== docId ? { matchedDocId: textHit.id } : {}),
      ...(partialHit ? { matchedDocId: partialHit.id } : {}),
    };
    if (textHit) legacy.push(record);
    else if (partialHit) partial.push(record);
    else missing.push(record);
  }

  const liveKeys = new Set(entries.map((entry) => idemKey(entry.scene, entry.category, { target: entry.target }, entry.text)));
  const liveTexts = entries.map((entry) => normalize(entry.text));
  const orphanIdem = [...index.idem.entries()]
    .filter(([key, docId]) => !liveKeys.has(key) && docById.has(docId))
    .map(([key, docId]) => ({ idemKey: key, docId }));

  const staleDocs = index.docs
    .filter((doc) => !liveTexts.some((text) => doc.text.includes(text)))
    .map((doc) => ({ id: doc.id, kind: doc.kind, scenes: [...doc.scenes], text: clip(doc.text) }));

  return {
    present,
    legacy,
    partial,
    missing,
    orphanIdem,
    staleDocs,
    counts: {
      live: entries.length,
      present: present.length,
      legacy: legacy.length,
      partial: partial.length,
      missing: missing.length,
      orphanIdem: orphanIdem.length,
      staleDocs: staleDocs.length,
    },
  };
}
