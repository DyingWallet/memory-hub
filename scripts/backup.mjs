#!/usr/bin/env node
/**
 * Daily backup: memories/ + data/tokens.json + config.json into
 * `<backup.dir>/YYYY-MM-DD/`, with manifest and keepDays pruning.
 *
 *   node scripts/backup.mjs [--force]
 *
 * Exit codes: 0 ok / skipped, 1 failure. Safe to run while memd is up; it only
 * reads files and replaces today's snapshot atomically.
 */
import { loadConfig } from '../packages/server/dist/config.js';
import { runBackup } from '../packages/server/dist/backup.js';

const config = loadConfig();
if (!config.backup.enabled && !process.argv.includes('--force')) {
  console.log('backup disabled (config.json → backup.enabled=false); use --force to run once');
  process.exit(0);
}

try {
  const result = runBackup({
    memoriesDir: config.memoriesDir,
    dataDir: config.dataDir,
    configFile: config.configFile,
    destDir: config.backup.dir,
    keepDays: config.backup.keepDays,
  });
  console.log(`backup ok: ${result.dir}`);
  console.log(`files: ${result.files} | bytes: ${result.bytes}`);
  if (result.pruned.length > 0) console.log(`pruned: ${result.pruned.join(', ')}`);
} catch (error) {
  console.error(`backup failed: ${String((error && error.message) || error)}`);
  process.exit(1);
}
