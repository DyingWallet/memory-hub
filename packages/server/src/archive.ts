/**
 * Monthly archive for fact shards.
 *
 * `facts/YYYY-MM.jsonl` is the append-only source of truth. Once a month is
 * over, it is compressed to `facts/archive/YYYY-MM.jsonl.gz` and the plain file
 * is removed. Reindex still sees archived months because `readFactLines`
 * transparently gunzips them.
 *
 * Archive is verified before deletion: if gunzip(archive) !== original, the
 * plain file is left untouched and the month is reported as skipped.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

export interface ArchiveResult {
  archived: string[];
  skipped: string[];
}

/** UTC month key, matching `monthShard()` in indexer.ts. */
export function monthKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 7);
}

export function archiveOldFacts(factsDir: string, now = Date.now(), keepMonths = 0): ArchiveResult {
  const result: ArchiveResult = { archived: [], skipped: [] };
  if (!existsSync(factsDir)) return result;
  const archiveDir = join(factsDir, 'archive');
  const nowDate = new Date(now);
  // Keep the current month plus the last `keepMonths` finished months plain.
  const cutoffDate = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() - Math.max(0, keepMonths), 1));
  const cutoff = monthKey(cutoffDate.getTime());

  for (const entry of readdirSync(factsDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = /^(\d{4}-\d{2})\.jsonl$/.exec(entry.name);
    if (!match) continue;
    const month = match[1]!;
    if (month >= cutoff) continue;

    const source = join(factsDir, entry.name);
    const original = readFileSync(source);
    const gz = gzipSync(original, { level: 9 });
    mkdirSync(archiveDir, { recursive: true });
    const target = join(archiveDir, `${month}.jsonl.gz`);
    const staging = `${target}.tmp`;
    writeFileSync(staging, gz);
    if (!gunzipSync(readFileSync(staging)).equals(original)) {
      result.skipped.push(entry.name);
      continue;
    }
    renameSync(staging, target);
    unlinkSync(source);
    result.archived.push(entry.name);
  }
  return result;
}

/** Active shards plus archived .gz shards, chronological (archive before active). */
export function listFactFiles(factsDir: string): string[] {
  if (!existsSync(factsDir)) return [];
  const entries: { file: string; month: string; archived: boolean }[] = [];
  for (const entry of readdirSync(factsDir, { withFileTypes: true })) {
    const match = /^(\d{4}-\d{2})\.jsonl$/.exec(entry.name);
    if (entry.isFile() && match) entries.push({ file: join(factsDir, entry.name), month: match[1]!, archived: false });
  }
  const archiveDir = join(factsDir, 'archive');
  if (existsSync(archiveDir)) {
    for (const name of readdirSync(archiveDir)) {
      const match = /^(\d{4}-\d{2})\.jsonl\.gz$/.exec(name);
      if (match) entries.push({ file: join(archiveDir, name), month: match[1]!, archived: true });
    }
  }
  entries.sort((a, b) => a.month.localeCompare(b.month) || (a.archived === b.archived ? 0 : a.archived ? -1 : 1));
  return entries.map((entry) => entry.file);
}

/** Lines of one fact file, decompressing `.gz` transparently. */
export function readFactFileLines(file: string): string[] {
  const raw = file.endsWith('.gz')
    ? gunzipSync(readFileSync(file)).toString('utf8')
    : readFileSync(file, 'utf8');
  return raw.split('\n').filter((line) => line.trim().length > 0);
}

/** All fact lines, transparently decompressing archived months. */
export function readFactLines(factsDir: string): string[] {
  const lines: string[] = [];
  for (const file of listFactFiles(factsDir)) lines.push(...readFactFileLines(file));
  return lines;
}
