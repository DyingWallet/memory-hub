/**
 * Content-based de-duplication for `/v1/write`.
 *
 * The same fact written twice (same scene, kind, normalized text, audience and
 * privacy) reuses the existing id instead of appending another JSONL row. The
 * mapping lives in `meta` so it survives restarts; a tombstoned/deleted id is
 * ignored and the write proceeds normally.
 */
import { createHash } from 'node:crypto';

export function normalizeForDedupe(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function dedupeKey(parts: readonly (string | undefined)[]): string {
  return createHash('sha256').update(parts.map((part) => part ?? '').join('\u0000')).digest('hex').slice(0, 32);
}

/** CJK bigrams + latin words, used for near-duplicate detection. */
export function similarityTokens(text: string): Set<string> {
  const normalized = normalizeForDedupe(text).toLowerCase();
  const tokens = new Set<string>();
  for (const word of normalized.match(/[a-z0-9]+/g) ?? []) tokens.add(word);
  const cjk = normalized.replace(/[^\u4e00-\u9fff]+/g, ' ');
  for (const run of cjk.split(/\s+/).filter(Boolean)) {
    if (run.length === 1) tokens.add(run);
    for (let index = 0; index + 1 < run.length; index += 1) tokens.add(run.slice(index, index + 2));
  }
  return tokens;
}

export function similarity(a: string, b: string): number {
  const left = similarityTokens(a);
  const right = similarityTokens(b);
  if (left.size === 0 || right.size === 0) return normalizeForDedupe(a) === normalizeForDedupe(b) ? 1 : 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** Exact after normalization, or Jaccard >= threshold with comparable length. */
export function isNearDuplicate(a: string, b: string, threshold = 0.8): boolean {
  const left = normalizeForDedupe(a);
  const right = normalizeForDedupe(b);
  if (left.length === 0 || right.length === 0) return false;
  if (left === right) return true;
  const ratio = Math.min(left.length, right.length) / Math.max(left.length, right.length);
  if (ratio < 0.6) return false;
  return similarity(left, right) >= threshold;
}
