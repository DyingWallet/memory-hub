import { createHash, randomBytes } from 'node:crypto';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function shortHash(input: string, bytes = 6): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, bytes * 2);
}

/**
 * Fact id: `<source>-<scene>-<time36>-<rand4>`（2026-10-27 统一规则）。
 *
 * 与 `scripts/migrate-ids.mjs` 的映射格式一致——迁移之后新写入的 id 不会再
 * 分裂成另一种形状。旧的 `f_<epoch>_<hex>` 只存在于历史数据里。
 */
export function newFactId(options: { now?: number; scene?: string; source?: string } = {}): string {
  const now = options.now ?? Date.now();
  const source = options.source ?? 'fact';
  const scene = normalizeSceneForId(options.scene);
  const time = Math.max(1, Math.floor(now / 1000)).toString(36);
  const rand = randomBytes(2).toString('hex').slice(0, 4);
  return `${source}-${scene}-${time}-${rand}`;
}

/** 场景归一化：`qq:group:123` → `qq-group-123`。id 与迁移脚本共用同一规则。 */
export function normalizeSceneForId(scene?: string): string {
  if (!scene) return 'none';
  const cleaned = String(scene)
    .replace(/:/g, '-')
    .replace(/[^a-zA-Z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return cleaned || 'none';
}

/** Deterministic ids for migrated rows (`import:<scene>:<hash>`). */
export function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}:${shortHash(parts.join('\u0000'), 8)}`;
}

export function newTokenId(now: number = Date.now()): string {
  return `tok_${now.toString(36)}_${randomBytes(3).toString('hex')}`;
}
