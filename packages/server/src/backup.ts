/**
 * Daily backup of the memory source of truth.
 *
 * Copies `memories/` (facts + docs + archives), `data/tokens.json` and
 * `config.json` into `<dest>/YYYY-MM-DD/`, writes a manifest, and prunes
 * snapshots older than `keepDays`. One snapshot per day; a second run on the
 * same day replaces it atomically (temp dir + rename).
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export interface BackupOptions {
  memoriesDir: string;
  dataDir: string;
  configFile: string;
  destDir: string;
  keepDays: number;
  now?: number;
}

export interface BackupResult {
  dir: string;
  files: number;
  bytes: number;
  pruned: string[];
}

function copyTree(source: string, target: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  if (!existsSync(source)) return { files, bytes };
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === '.' || entry.name === '..') continue;
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      const nested = copyTree(from, to);
      files += nested.files;
      bytes += nested.bytes;
    } else if (entry.isFile()) {
      copyFileSync(from, to);
      files += 1;
      bytes += statSync(to).size;
    }
  }
  return { files, bytes };
}

function localDay(now: number): string {
  const date = new Date(now);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function backupDirName(now = Date.now()): string {
  return localDay(now);
}

export function runBackup(options: BackupOptions): BackupResult {
  const now = options.now ?? Date.now();
  const day = backupDirName(now);
  mkdirSync(options.destDir, { recursive: true });
  const target = join(options.destDir, day);
  const staging = `${target}.tmp`;

  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  const memories = copyTree(options.memoriesDir, join(staging, 'memories'));
  let files = memories.files;
  let bytes = memories.bytes;

  for (const [source, name] of [
    [join(options.dataDir, 'tokens.json'), 'tokens.json'],
    [options.configFile, 'config.json'],
  ] as const) {
    if (!existsSync(source)) continue;
    copyFileSync(source, join(staging, name));
    files += 1;
    bytes += statSync(join(staging, name)).size;
  }

  writeFileSync(
    join(staging, 'manifest.json'),
    `${JSON.stringify(
      {
        created_at: new Date(now).toISOString(),
        source: {
          memories: options.memoriesDir,
          data: options.dataDir,
          config: options.configFile,
        },
        files,
        bytes,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  rmSync(target, { recursive: true, force: true });
  renameSync(staging, target);

  const cutoff = localDay(now - options.keepDays * 86_400_000);
  const pruned: string[] = [];
  for (const name of readdirSync(options.destDir)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue;
    if (name >= cutoff) continue;
    rmSync(join(options.destDir, name), { recursive: true, force: true });
    pruned.push(name);
  }

  return { dir: target, files: files + 1, bytes, pruned };
}
