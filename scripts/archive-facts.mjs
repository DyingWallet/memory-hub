#!/usr/bin/env node
/**
 * Compress old fact months into facts/archive/YYYY-MM.jsonl.gz.
 *
 * Disabled by default (`config.json` → `archive.enabled`). When enabled,
 * months older than `archive.keepMonths` are archived; the current month and
 * the last N finished months stay plain JSONL.
 *
 * Safe to run while memd is up: files are verified before the plain copy is
 * removed, and reindex reads .gz transparently.
 *
 *   node scripts/archive-facts.mjs [--dry-run] [--keep-months N] [--force]
 */
import { existsSync, readdirSync } from 'node:fs';
import { loadConfig } from '../packages/server/dist/config.js';
import { archiveOldFacts, monthKey } from '../packages/server/dist/archive.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const keepIndex = args.indexOf('--keep-months');
const keepOverride = keepIndex >= 0 ? Number(args[keepIndex + 1]) : undefined;

const config = loadConfig();
if (!config.archive.enabled && !force) {
  console.log('archive disabled (config.json → archive.enabled=false); use --force to run once');
  process.exit(0);
}
if (!existsSync(config.factsDir)) {
  console.log(`no facts dir at ${config.factsDir}`);
  process.exit(0);
}

const keepMonths = Number.isFinite(keepOverride) ? keepOverride : config.archive.keepMonths;
const now = Date.now();
if (dryRun) {
  const nowDate = new Date(now);
  const cutoffDate = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() - Math.max(0, keepMonths), 1));
  const cutoff = monthKey(cutoffDate.getTime());
  const pending = readdirSync(config.factsDir).filter((name) => {
    const match = /^(\d{4}-\d{2})\.jsonl$/.exec(name);
    return match && match[1] < cutoff;
  });
  console.log(`dry-run (keep ${keepMonths} months): ${pending.length} month(s) to archive: ${pending.join(', ') || '(none)'}`);
  process.exit(0);
}

const result = archiveOldFacts(config.factsDir, now, keepMonths);
console.log(`archived (keep ${keepMonths}): ${result.archived.join(', ') || '(none)'}`);
if (result.skipped.length > 0) console.log(`skipped (verify failed): ${result.skipped.join(', ')}`);
