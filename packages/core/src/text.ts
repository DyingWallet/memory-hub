/** Small, dependency-free string helpers shared by the server and adapters. */

export function truncate(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join('')}…`;
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** First meaningful line, used as a result title. */
export function titleFrom(text: string, maxChars = 48): string {
  const firstLine = text
    .split('\n')
    .map((line) => line.replace(/^#{1,6}\s+/, '').trim())
    .find((line) => line.length > 0);
  return truncate(collapseWhitespace(firstLine ?? ''), maxChars);
}

export function isoNow(now: number = Date.now()): string {
  return new Date(now).toISOString();
}

/** `2026-10` — the facts file shard for a timestamp. */
export function monthShard(iso: string): string {
  return iso.slice(0, 7);
}
