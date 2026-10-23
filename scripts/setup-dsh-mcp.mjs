#!/usr/bin/env node
/**
 * Registers the memory MCP server with DSH (plan B from docs/SPIKE-DSH.md).
 *
 * Writes a managed block into the DSH profile's `cordis.patch.yml`:
 *
 *   # === memory-hub MCP BEGIN === ... # === memory-hub MCP END ===
 *
 * The block is replaced wholesale on every run, so re-running is idempotent.
 * A timestamped backup is written before each modification.
 *
 * MUST run outside the DSH sandbox: the profile lives in ~/.dsh and is
 * write-locked / ACL-restricted for sandboxed processes.
 *
 *   node scripts/setup-dsh-mcp.mjs --check
 *   node scripts/setup-dsh-mcp.mjs --with-token
 *   node scripts/setup-dsh-mcp.mjs --dry-run
 *   node scripts/setup-dsh-mcp.mjs --remove
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../packages/server/dist/config.js';
import { openDb } from '../packages/server/dist/db.js';
import { reindexAll } from '../packages/server/dist/indexer.js';
import { TokenStore } from '../packages/server/dist/tokens.js';

const BEGIN = '# === memory-hub MCP BEGIN ===';
const END = '# === memory-hub MCP END ===';
const SERVER_NAME = 'memory';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const next = args[index + 1];
  return next && !next.startsWith('--') ? next : 'true';
};
const has = (name) => args.includes(`--${name}`);

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const profile = flag('profile') ?? process.env.DSH_PROFILE ?? 'desktop';
const patchFile = join(dshHome, 'profiles', profile, 'cordis.patch.yml');
const tokenFile = flag('token-file') ?? join(dshHome, 'memory-token');
const endpoint = flag('endpoint') ?? 'http://127.0.0.1:8787';
const nodeExe = flag('node') ?? process.execPath;
const serverScript = join(root, 'packages', 'adapter-dsh', 'dist', 'mcp-server.js');

for (const required of [patchFile]) {
  if (!existsSync(required)) {
    console.error(`missing ${required}`);
    console.error('is DSH installed and the desktop profile created? (--profile <name>)');
    process.exit(1);
  }
}
if (!existsSync(serverScript)) {
  console.error(`missing build output: ${serverScript} (run: pnpm run build)`);
  process.exit(1);
}

const existing = readFileSync(patchFile, 'utf8');
const withoutBlock = stripBlock(existing);
const hasBlock = withoutBlock !== existing;

if (has('check')) {
  const report = {
    profile,
    patchFile,
    blockPresent: hasBlock,
    tokenFile,
    tokenPresent: existsSync(tokenFile),
    serverScript,
    serverBuilt: existsSync(serverScript),
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(hasBlock ? 0 : 1);
}

if (has('remove')) {
  if (!hasBlock) {
    console.log('no managed block found; nothing to remove');
    process.exit(0);
  }
  backup(patchFile);
  writeFileSync(patchFile, withoutBlock, 'utf8');
  console.log(`removed managed block from ${patchFile}`);
  process.exit(0);
}

if (has('with-token')) {
  const config = loadConfig();
  const store = new TokenStore(config.tokensFile);
  const issued = store.issue({
    name: `dsh-${profile}`,
    surface: 'main',
    scopes: ['*', 'work:read'],
    scenes: ['main'],
  });
  mkdirSync(dirname(tokenFile), { recursive: true });
  writeFileSync(tokenFile, `${issued.token}\n`, { encoding: 'utf8', mode: 0o600 });
  console.log(`issued token ${issued.record.id} -> ${tokenFile}`);
  console.log(`tighten ACLs on that file if the directory is shared:`);
  console.log(`  icacls "${tokenFile}" /inheritance:r /grant:r "%USERNAME%:R"`);

  // Make sure the index exists so the first search is not empty.
  const db = openDb(config.indexFile);
  try {
    const result = reindexAll(db, config);
    console.log(`index ready: docs=${result.docs} facts=${result.facts} chunks=${result.chunks}`);
  } finally {
    db.close();
  }
} else if (!existsSync(tokenFile)) {
  console.warn(`warning: token file missing (${tokenFile}); run with --with-token first`);
}

const block = [
  BEGIN,
  '- insert:',
  `    - id: mcp-${SERVER_NAME}`,
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  `        serverName: ${SERVER_NAME}`,
  '        transport: stdio',
  `        command: '${escapeYaml(nodeExe)}'`,
  '        args:',
  `          - '${escapeYaml(serverScript)}'`,
  '        env:',
  `          MEMD_ENDPOINT: '${escapeYaml(endpoint)}'`,
  `          MEMD_TOKEN_FILE: '${escapeYaml(tokenFile)}'`,
  "          MEMD_SURFACE: 'main'",
  '        toolCallTimeoutMs: 120000',
  END,
  '',
].join('\n');

if (has('dry-run')) {
  console.log(block);
  console.log(`(dry-run) would write to ${patchFile}`);
  process.exit(0);
}

backup(patchFile);
writeFileSync(patchFile, `${withoutBlock.replace(/\s*$/, '')}\n\n${block}`, 'utf8');
console.log(`wrote managed block to ${patchFile}`);
console.log('restart DSH Desktop (or let profile HMR pick it up), then check:');
console.log('  mcp__memory__memory_search should appear in the tool list');

function stripBlock(text) {
  const begin = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (begin === -1 || end === -1 || end < begin) return text;
  return `${text.slice(0, begin)}${text.slice(end + END.length)}`.replace(/\n{3,}/g, '\n\n');
}

function backup(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = `${file}.bak-${stamp}`;
  copyFileSync(file, target);
  console.log(`backup: ${target}`);
}

function escapeYaml(value) {
  return String(value).replaceAll("'", "''");
}
