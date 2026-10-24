#!/usr/bin/env node
/**
 * Issues one memory token per QQ scene and stages the plaintext files for the
 * bridge (`state/memory-*.token`). Secrets are never printed: the script writes
 * them to `memory-hub/data/qq-tokens/` and reports ids only.
 *
 * Scenes:
 *   - group:   every id in qq-bridge config.allow.groups   (shared + that group)
 *   - owner:   qq:owner                                    (root + work:read)
 *   - private: every id in config.allow.private except ownerQQ (shared + that DM)
 *
 *   node scripts/issue-qq-tokens.mjs [--bridge-config <path>]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../packages/server/dist/config.js';
import { TokenStore } from '../packages/server/dist/tokens.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const next = args[index + 1];
  return next && !next.startsWith('--') ? next : undefined;
};

const bridgeConfigPath = resolve(flag('bridge-config') ?? join(root, '..', 'qq-bridge', 'config.json'));
const bridgeConfig = JSON.parse(readFileSync(bridgeConfigPath, 'utf8'));
const ownerQQ = String(bridgeConfig.ownerQQ ?? '');
const groups = (bridgeConfig.allow?.groups ?? []).map(String);
const privates = (bridgeConfig.allow?.private ?? []).map(String).filter((qq) => qq !== ownerQQ);

if (!ownerQQ) {
  console.error('ownerQQ missing in bridge config');
  process.exit(1);
}

const config = loadConfig();
const store = new TokenStore(config.tokensFile);
const stageDir = join(config.dataDir, 'qq-tokens');
mkdirSync(stageDir, { recursive: true });

const issued = [];

/** Re-running should not pile up active tokens: revoke the same-named one first. */
function issueFresh(name, surface, scopes, file) {
  for (const existing of store.list()) {
    if (existing.name === name && existing.revoked_at === null) {
      store.revoke(existing.id);
    }
  }
  const result = store.issue({ name, surface, scopes });
  writeFileSync(join(stageDir, file), `${result.token}\n`, { encoding: 'utf8', mode: 0o600 });
  issued.push({ name, surface, id: result.record.id, file: join(stageDir, file) });
}

for (const group of groups) {
  issueFresh(`qq-group-${group}`, `qq:group:${group}`, [`qq:group:${group}`], `memory-group-${group}.token`);
}
issueFresh('qq-owner', 'qq:owner', ['*', 'work:read'], 'memory-owner.token');
// 跨场景披露专用：桥接先用 QQ 成员表校验提问者，再用这个令牌读该群的最近消息。
// 只有 disclose:group，没有敏感、没有通配 scope。
issueFresh('qq-disclose', 'qq:bridge', ['disclose:group'], 'memory-disclose.token');
for (const qq of privates) {
  issueFresh(`qq-private-${qq}`, `qq:private:${qq}`, [`qq:private:${qq}`], `memory-private-${qq}.token`);
}

console.log(
  JSON.stringify(
    {
      bridgeConfig: bridgeConfigPath,
      stagedIn: stageDir,
      tokens: issued.map(({ name, surface, id, file }) => ({ name, surface, id, file })),
    },
    null,
    2,
  ),
);
