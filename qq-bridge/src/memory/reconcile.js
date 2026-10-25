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
import { idemKey, mirrorKey } from './idem.js';

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
      if (text) {
        entries.push({ convKey, scene, category: 'activeTopic', kind: 'qq-topic', text, privacy: 'normal', id: topic?.id, rev: topic?.rev });
      }
    }
    for (const thought of conv.pendingThoughts ?? []) {
      const text = String(thought?.text ?? '').trim();
      if (text) {
        entries.push({ convKey, scene, category: 'pendingThought', kind: 'qq-topic', text, privacy: 'normal', id: thought?.id, rev: thought?.rev });
      }
    }
    for (const [target, impression] of Object.entries(conv.memberImpressions ?? {})) {
      const text = typeof impression === 'string' ? impression : String(impression?.text ?? impression?.traits?.join?.('、') ?? '');
      const trimmed = text.trim();
      if (trimmed) {
        entries.push({
          convKey,
          scene,
          category: 'memberImpression',
          kind: 'qq-impression',
          text: trimmed,
          target,
          // 成员印象的身份就是 target（id 派生成 m:<target>，rev 随 traits 追加递增）。
          id: impression?.id ?? `m:${target}`,
          rev: impression?.rev,
          privacy: 'personal',
        });
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
    const primary = mirrorKey(entry.scene, entry.category, entry, entry.text);
    const docId = index.idem.get(primary);
    const doc = docId ? docById.get(docId) : undefined;
    if (doc && doc.kind === entry.kind) {
      present.push({ ...entry, idemKey: primary, docId });
      continue;
    }
    // 旧键（迁移前写的、以及还没有 id 的条目）也要试：它们是同一段记忆的另一种指纹。
    const legacyKey = entry.id ? idemKey(entry.scene, entry.category, entry, entry.text) : primary;
    const legacyDocId = legacyKey !== primary ? index.idem.get(legacyKey) : undefined;
    const legacyDoc = legacyDocId ? docById.get(legacyDocId) : undefined;

    const sameKindScene = (candidate) => candidate.kind === entry.kind && candidate.scenes.has(entry.scene);
    const textHit = index.docs.find((candidate) => sameKindScene(candidate) && candidate.text.includes(normalize(entry.text)));
    // 迁移/截断留下的副本：开头对得上、后面被切掉了。它既不是「写好了」，
    // 也不该算「完全没有」——真去 --fix 补写会多出一条近似重复。
    const partialHit = textHit
      ? undefined
      : index.docs.find((candidate) => sameKindScene(candidate) && candidate.text.includes(normalize(entry.text).slice(0, 30)));
    const reason = legacyDoc
      ? 'legacy-key'
      : docId
        ? (doc ? 'kind-mismatch' : 'doc-gone')
        : textHit
          ? 'text-only'
          : partialHit
            ? 'partial-text'
            : 'no-idem';
    const record = {
      convKey: entry.convKey,
      scene: entry.scene,
      category: entry.category,
      ...(entry.target ? { target: entry.target } : {}),
      ...(entry.id ? { id: entry.id, rev: Number(entry.rev) || 1 } : {}),
      text: clip(entry.text),
      idemKey: primary,
      reason,
      ...(textHit && textHit.id !== docId ? { matchedDocId: textHit.id } : {}),
      ...(partialHit ? { matchedDocId: partialHit.id } : {}),
    };
    if (legacyDoc || textHit) legacy.push(record);
    else if (partialHit) partial.push(record);
    else missing.push(record);
  }

  // 同一条目的历史版本还留在 memd 里（编辑后忘了写新、没忘旧的）。
  const superseded = [];
  for (const entry of entries) {
    if (!entry.id) continue;
    const currentRev = Math.max(1, Number(entry.rev) || 1);
    for (let rev = 1; rev < currentRev; rev += 1) {
      const key = mirrorKey(entry.scene, entry.category, { ...entry, rev }, entry.text);
      const docId = index.idem.get(key);
      const doc = docId ? docById.get(docId) : undefined;
      if (!doc) continue;
      superseded.push({
        scene: entry.scene,
        category: entry.category,
        ...(entry.target ? { target: entry.target } : {}),
        id: entry.id,
        rev,
        currentRev,
        idemKey: key,
        docId,
        text: clip(doc.text),
      });
    }
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
    superseded,
    orphanIdem,
    staleDocs,
    counts: {
      live: entries.length,
      present: present.length,
      legacy: legacy.length,
      partial: partial.length,
      missing: missing.length,
      superseded: superseded.length,
      orphanIdem: orphanIdem.length,
      staleDocs: staleDocs.length,
    },
  };
}
