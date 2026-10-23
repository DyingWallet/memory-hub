#!/usr/bin/env node
/**
 * Installs the `dsh-memory` host plugin into the DSH desktop profile so every
 * DSH session reports its user messages to memd as short-term memories.
 *
 *   node scripts/setup-dsh-plugin.mjs --check
 *   node scripts/setup-dsh-plugin.mjs --dry-run
 *   node scripts/setup-dsh-plugin.mjs            # needs a non-sandbox shell
 *   node scripts/setup-dsh-plugin.mjs --remove
 *
 * The profile lives in ~/.dsh, so sandboxed processes get EPERM; run this from
 * a normal PowerShell window.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = join(root, 'plugins', 'dsh-memory').replaceAll('\\', '/');
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const profileDir = join(dshHome, 'profiles', process.env.DSH_PROFILE ?? 'desktop');
const manifestPath = join(profileDir, 'package.json');
const nodeExe = process.execPath;
const pnpmScript = 'D:/Software/dsh/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs';

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);

if (!existsSync(manifestPath)) {
  console.error(`missing profile manifest: ${manifestPath}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.dependencies ??= {};
manifest.dsh ??= {};
manifest.dsh.profile ??= {};
manifest.dsh.profile.bundles ??= [];

const linked = existsSync(join(profileDir, 'node_modules', 'dsh-memory'));
const hasDep = Boolean(manifest.dependencies['dsh-memory']);
const hasBundle = manifest.dsh.profile.bundles.includes('dsh-memory');

if (has('check')) {
  console.log(
    JSON.stringify(
      {
        profile: profileDir,
        pluginDir,
        dependency: hasDep,
        bundle: hasBundle,
        linked,
        ready: hasDep && hasBundle && linked,
      },
      null,
      2,
    ),
  );
  process.exit(hasDep && hasBundle && linked ? 0 : 1);
}

if (has('remove')) {
  backup(manifestPath);
  delete manifest.dependencies['dsh-memory'];
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((entry) => entry !== 'dsh-memory');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  runInstall(profileDir);
  console.log('removed dsh-memory from the profile');
  process.exit(0);
}

manifest.dependencies['dsh-memory'] = `link:${pluginDir}`;
if (!hasBundle) manifest.dsh.profile.bundles.push('dsh-memory');

if (has('dry-run')) {
  console.log(JSON.stringify({ profile: profileDir, dependency: manifest.dependencies['dsh-memory'], bundles: manifest.dsh.profile.bundles }, null, 2));
  process.exit(0);
}

backup(manifestPath);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`updated ${manifestPath}`);

runInstall(profileDir);

if (!existsSync(join(profileDir, 'node_modules', 'dsh-memory'))) {
  console.error('install finished but node_modules/dsh-memory is missing');
  process.exit(1);
}
console.log('dsh-memory installed; restart DeepSeek Harness to load it');
console.log('verify: node scripts/setup-dsh-plugin.mjs --check');

function backup(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = `${file}.bak-${stamp}`;
  copyFileSync(file, target);
  console.log(`backup: ${target}`);
}

function runInstall(cwd) {
  if (!existsSync(pnpmScript)) {
    console.error(`pnpm not found at ${pnpmScript}; add the dependency manually and run pnpm install in ${cwd}`);
    process.exit(1);
  }
  console.log(`pnpm install in ${cwd}`);
  execFileSync(nodeExe, [pnpmScript, 'install', '--reporter=append-only'], { cwd, stdio: 'inherit' });
}
