// 账号发现的读错误分类。
//
// 「目录 / 文件不存在」= 账号真的没了，可以关链路；
// 「读不了」（权限被拒、macOS 隐私保护拦截访问其他 App 的数据、I/O 错误等）≠ 账号没了 ——
// 这时抛 DiscoveryUnreadableError，连接器保留现有链路、不当成账号消失。

const MISSING = new Set(['ENOENT', 'ENOTDIR']);

export class DiscoveryUnreadableError extends Error {
  constructor(target, cause) {
    super(`读不到 ${target}（${cause?.code ?? cause?.message ?? cause}）`);
    this.name = 'DiscoveryUnreadableError';
    this.code = 'DISCOVERY_UNREADABLE';
    this.cause = cause;
  }
}

/** 不存在的错误返回 true（调用方按「没有」处理）；其他读错误抛 DiscoveryUnreadableError；JSON 等内容错误返回 false。 */
export function classifyReadError(err, target) {
  if (MISSING.has(err?.code)) return true;
  if (typeof err?.code === 'string' && /^E[A-Z]+$/.test(err.code)) throw new DiscoveryUnreadableError(target, err);
  return false;
}
