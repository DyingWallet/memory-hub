/**
 * 镜像写入的「身份」：一条 QQ 轻量记忆对应 memd 里哪一行。
 *
 * 单独一个文件是有原因的：桥接侧（memory-bridge.js）要用它算键，
 * 对账脚本（scripts/reconcile-memory.mjs）要用同一套规则反算，
 * 两边各写一份迟早会漂——2026-10-25 就是靠文本猜，猜出 24 条假漂移。
 *
 * 注意：这里算的是**内容指纹**，不是条目的身份。
 * 文本一改键就变，所以 mirrorUpdate 才要「先忘旧的再写新的」；
 * 第 2 步会换成 `qq:mirror:<scene>:<entryId>`，那时这个文件的实现会变，调用方不变。
 */
import { createHash } from 'node:crypto';

/** Stable idempotency key for one QQ memory entry (write/forget must agree). */
export function idemKey(scene, category, extra, text) {
  const digest = createHash('sha256')
    .update(`${scene}\u0000${category}\u0000${extra?.target ?? ''}\u0000${text}`)
    .digest('hex')
    .slice(0, 16);
  return `${scene}:${category}:${digest}`;
}

/** 遗忘队列里去重用的键：同一 scene + category + target + 文本只留一条。 */
export function forgetKey(scene, category, extra, text) {
  return idemKey(scene, category, extra, text);
}
