/**
 * 镜像写入的「身份」：一条 QQ 轻量记忆对应 memd 里哪一行。
 *
 * 两套键并存（2026-10-26 起）：
 *
 *   新键（B-full）：`qq:mirror:<scene>:<category>:<id>:<rev>`
 *     - 单条式（activeTopic / pendingThought）：id 是条目自带的 8 位十六进制；
 *     - 聚合式（memberImpression）：id 就是 `m:<target>`，rev 随 traits 追加递增。
 *     - rev 进键是有原因的：routes.ts 的 idem 命中直接返回 duplicate，
 *       不会回查文档是否已被 tombstone，所以「同键覆盖写」写不进去。
 *       带 rev 之后：同一版本重试幂等，编辑后自然变成新键。
 *
 *   旧键（无 id 的历史条目）：`<scene>:<category>:<sha256(scene+category+target+text) 前16位>`
 *     - 2026-10-23 迁移进来的那批只能用这个；forget 时要**两把键都试**。
 *
 * 这个文件是桥接（memory-bridge.js）与对账脚本（reconcile.js）共用的唯一实现，
 * 两边各写一份迟早漂——10-25 就是靠文本猜，猜出 24 条假漂移。
 */
import { createHash } from 'node:crypto';

/** 旧格式：内容指纹。没有 id 的条目、以及迁移前的数据仍然用它。 */
export function idemKey(scene, category, extra, text) {
  const digest = createHash('sha256')
    .update(`${scene}\u0000${category}\u0000${extra?.target ?? ''}\u0000${text}`)
    .digest('hex')
    .slice(0, 16);
  return `${scene}:${category}:${digest}`;
}

/** 遗忘队列去重键：与写入键一致，才能保证「重试的是同一条」。 */
export function forgetKey(scene, category, extra, text) {
  return mirrorKey(scene, category, extra, text);
}

/**
 * 新格式：带身份的键。
 * @param {string} scene
 * @param {string} category
 * @param {{id?: string, rev?: number, target?: string}} entry
 */
export function mirrorKey(scene, category, entry, text = '') {
  const id = String(entry?.id ?? '').trim();
  if (!id) return idemKey(scene, category, entry, text);
  const rev = Math.max(1, Math.trunc(Number(entry?.rev) || 1));
  const tail = category === 'memberImpression' ? encodeURIComponent(String(entry?.target ?? id)) : id;
  return `qq:mirror:${scene}:${category}:${tail}:${rev}`;
}

/** 一个条目可能对应的所有键：新键在前，旧内容键在后（仅当有 id 时才需要补旧键）。 */
export function forgetKeys(scene, category, entry, text) {
  const primary = mirrorKey(scene, category, entry, text);
  if (!entry?.id) return [primary];
  const legacy = idemKey(scene, category, entry, text);
  return primary === legacy ? [primary] : [primary, legacy];
}

/** 8 位十六进制条目 id。碰撞概率在这个量级（单会话 ≤ 20~50 条）可以忽略。 */
export function newEntryId(randomBytes) {
  return randomBytes(4).toString('hex');
}
