import { createHash, randomBytes } from 'node:crypto';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function shortHash(input: string, bytes = 6): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, bytes * 2);
}

/**
 * Fact id: `f_<epoch-ms>_<8 hex>`. Sortable by time, globally unique enough for
 * an append-only local log, and short enough to quote in transcripts.
 */
export function newFactId(now: number = Date.now()): string {
  return `f_${now}_${randomBytes(4).toString('hex')}`;
}

/** Deterministic ids for migrated rows (`import:<scene>:<hash>`). */
export function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}:${shortHash(parts.join('\u0000'), 8)}`;
}

export function newTokenId(now: number = Date.now()): string {
  return `tok_${now.toString(36)}_${randomBytes(3).toString('hex')}`;
}
