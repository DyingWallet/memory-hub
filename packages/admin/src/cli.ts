#!/usr/bin/env node
/**
 * memd admin CLI — token lifecycle, reindex, health, migration.
 * Token issuance/rotation lives here (host side), never in the DSH settings page.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '@memsvc/server/config';
import { openDb, readStats } from '@memsvc/server/db';
import { appendFact, reindexAll } from '@memsvc/server/indexer';
import { TokenStore, type TokenRecord } from '@memsvc/server/tokens';
import { normalizeAudience, stableId } from '@memsvc/core';
import type { TFactRecord } from '@memsvc/protocol';

interface ParsedArgs {
  command: string[];
  flags: Map<string, string[]>;
}

const argv = parseArgs(process.argv.slice(2));
const config = loadConfig();

main().catch((error) => {
  console.error(`error: ${(error as Error).message}`);
  process.exit(1);
});

async function main(): Promise<void> {
  const [group, action] = argv.command;

  if (group === 'token') {
    handleToken(action);
    return;
  }
  if (group === 'reindex') {
    handleReindex();
    return;
  }
  if (group === 'health') {
    await handleHealth();
    return;
  }
  if (group === 'stats') {
    const db = openDb(config.indexFile);
    printJson(readStats(db));
    db.close();
    return;
  }
  if (group === 'import-social') {
    handleImportSocial();
    return;
  }
  usage();
  process.exit(2);
}

function handleToken(action: string | undefined): void {
  const store = new TokenStore(config.tokensFile);
  switch (action) {
    case 'issue': {
      const name = flag('name');
      const surface = flag('surface') ?? 'main';
      if (!name) throw new Error('--name is required');
      const scopes = collect('scope', 'scopes');
      const scenes = collect('scene', 'scenes');
      const issued = store.issue({
        name,
        surface,
        scopes: scopes.length > 0 ? scopes : defaultScopes(surface),
        ...(scenes.length > 0 ? { scenes } : {}),
      });
      console.log(`token id : ${issued.record.id}`);
      console.log(`name     : ${issued.record.name}`);
      console.log(`surface  : ${issued.record.surface}`);
      console.log(`scenes   : ${issued.record.scenes.join(', ')}`);
      console.log(`scopes   : ${issued.record.scopes.join(', ')}`);
      console.log('');
      console.log('token (shown once, store it in the ACL file now):');
      console.log(issued.token);
      return;
    }
    case 'list': {
      const rows = store.list().map((token: TokenRecord) => ({
        id: token.id,
        name: token.name,
        surface: token.surface,
        scenes: token.scenes,
        scopes: token.scopes,
        created: token.created_at,
        revoked: token.revoked_at,
        last_used: token.last_used_at ?? null,
      }));
      printJson(rows);
      return;
    }
    case 'revoke': {
      const id = flag('id') ?? argv.command[2];
      if (!id) throw new Error('token id required: token revoke <id>');
      const revoked = store.revoke(id);
      if (!revoked) throw new Error(`no such token: ${id}`);
      console.log(`revoked ${revoked.id} (${revoked.name}) at ${revoked.revoked_at}`);
      return;
    }
    default:
      throw new Error('usage: token <issue|list|revoke>');
  }
}

function handleReindex(): void {
  const db = openDb(config.indexFile);
  try {
    const result = reindexAll(db, config, { force: has('force') });
    printJson({ ...result, index: config.indexFile, memories: config.memoriesDir });
  } finally {
    db.close();
  }
}

async function handleHealth(): Promise<void> {
  const endpoint = flag('endpoint') ?? `http://127.0.0.1:${config.port}`;
  const response = await fetch(`${endpoint.replace(/\/+$/, '')}/v1/health`, {
    signal: AbortSignal.timeout(4000),
  });
  const payload = await response.json();
  console.log(JSON.stringify(payload, null, 2));
  if (!response.ok) process.exitCode = 1;
}

/**
 * Imports the QQ bridge's social-v2 state into facts.
 *
 * Supports the real file shape `{ paused, conversations: { '<convKey>': {...} } }`
 * as well as the older flat shape. Idempotent: the fact id is derived from
 * (scene, kind, text), so a second run skips everything.
 */
function handleImportSocial(): void {
  const file = flag('file');
  const sceneFilter = flag('scene');
  const dryRun = has('dry-run');
  if (!file) throw new Error('usage: import-social --file <social-v2.json> [--scene <qq:group:...>] [--owner-qq <qq>] [--dry-run]');
  if (!existsSync(file)) throw new Error(`no such file: ${file}`);

  const ownerQQ = flag('owner-qq') ?? readOwnerQQ();
  const state = JSON.parse(readFileSync(file, 'utf8')) as {
    paused?: boolean;
    conversations?: Record<string, unknown>;
    activeTopics?: unknown;
    pendingThoughts?: unknown;
    memberImpressions?: unknown;
  };

  const conversations =
    state.conversations && typeof state.conversations === 'object'
      ? Object.entries(state.conversations)
      : [[sceneFilter ?? '', state] as [string, unknown]];

  const facts: FactRecordInput[] = [];
  for (const [convKey, value] of conversations) {
    if (!convKey) continue;
    const scene = sceneForKey(convKey, ownerQQ);
    if (sceneFilter && scene !== sceneFilter) continue;
    const conv = (value ?? {}) as Record<string, unknown>;
    for (const [index, topic] of asArray(conv.activeTopics).entries()) {
      pushFact(facts, scene, 'qq-topic', stringOf(topic.text), 'normal', `activeTopic:${index}`, ['activeTopic']);
    }
    for (const [index, thought] of asArray(conv.pendingThoughts).entries()) {
      pushFact(facts, scene, 'qq-topic', stringOf(thought.text), 'normal', `pendingThought:${index}`, ['pendingThought']);
    }
    for (const [index, impression] of asArray(conv.memberImpressions).entries()) {
      const name = stringOf(impression.name) || stringOf(impression.userId) || `member-${index}`;
      const traits = Array.isArray(impression.traits) ? impression.traits.map(String).join('、') : stringOf(impression.traits);
      pushFact(facts, scene, 'qq-impression', `${name}: ${traits}`.trim(), 'personal', `impression:${index}`, ['memberImpression']);
    }
  }

  if (dryRun) {
    const byScene: Record<string, number> = {};
    for (const fact of facts) byScene[fact.scene] = (byScene[fact.scene] ?? 0) + 1;
    printJson({ count: facts.length, byScene, sample: facts.slice(0, 3).map((fact) => ({ scene: fact.scene, kind: fact.kind })) });
    return;
  }

  const db = openDb(config.indexFile);
  try {
    let written = 0;
    for (const fact of facts) {
      const id = stableId('import', fact.scene, fact.kind, fact.text);
      if (db.prepare('SELECT 1 FROM docs WHERE id = ?').get(id)) continue;
      const record: TFactRecord = {
        schema_version: 1,
        id,
        ts: new Date().toISOString(),
        kind: fact.kind,
        text: fact.text,
        tags: fact.tags,
        audience: normalizeAudience([fact.scene], fact.kind, fact.scene),
        privacy: fact.privacy,
        source: 'import',
        scene: fact.scene,
        meta: { import_id: id },
      };
      appendFact(db, config, record);
      written += 1;
    }
    printJson({ candidates: facts.length, written, index: readStats(db) });
  } finally {
    db.close();
  }
}

interface FactRecordInput {
  scene: string;
  kind: TFactRecord['kind'];
  text: string;
  privacy: 'normal' | 'personal';
  tags: string[];
}

function pushFact(
  out: FactRecordInput[],
  scene: string,
  kind: TFactRecord['kind'],
  text: string,
  privacy: 'normal' | 'personal',
  label: string,
  tags: string[],
): void {
  const trimmed = text.trim();
  if (trimmed.length === 0) return;
  out.push({ scene, kind, text: trimmed, privacy, tags: [...tags, label] });
}

function sceneForKey(convKey: string, ownerQQ: string): string {
  const match = /^(group|private):(.+)$/.exec(convKey.trim());
  if (!match) return convKey.trim();
  const [, kind, id] = match;
  if (kind === 'group') return `qq:group:${id}`;
  return String(id) === String(ownerQQ) ? 'qq:owner' : `qq:private:${id}`;
}

/** Reads `../qq-bridge/config.json` when present, so private:owner maps correctly. */
function readOwnerQQ(): string {
  const bridgeConfig = resolve(config.memoriesDir, '..', 'qq-bridge', 'config.json');
  if (!existsSync(bridgeConfig)) return '';
  try {
    const parsed = JSON.parse(readFileSync(bridgeConfig, 'utf8')) as { ownerQQ?: number | string };
    return parsed.ownerQQ === undefined ? '' : String(parsed.ownerQQ);
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function parseArgs(input: string[]): ParsedArgs {
  const command: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < input.length; i += 1) {
    const token = input[i] ?? '';
    if (token.startsWith('--')) {
      const [rawKey, inlineValue] = token.slice(2).split('=', 2);
      const key = rawKey ?? '';
      const values = flags.get(key) ?? [];
      if (inlineValue !== undefined) values.push(inlineValue);
      else {
        const next = input[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          values.push(next);
          i += 1;
        } else {
          values.push('true');
        }
      }
      flags.set(key, values);
    } else {
      command.push(token);
    }
  }
  return { command, flags };
}

function flag(name: string): string | undefined {
  return argv.flags.get(name)?.[0];
}

function has(name: string): boolean {
  return argv.flags.has(name);
}

function collect(...names: string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    for (const value of argv.flags.get(name) ?? []) {
      for (const part of value.split(',')) {
        const trimmed = part.trim();
        if (trimmed.length > 0) out.push(trimmed);
      }
    }
  }
  return out;
}

function defaultScopes(surface: string): string[] {
  if (surface === 'main' || surface === 'qq:owner') return ['*', 'sensitive:read'];
  return [surface];
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function asArray(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  if (value && typeof value === 'object') return Object.values(value) as Record<string, unknown>[];
  return [];
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

function usage(): void {
  console.log(`memd admin — ${config.version}

usage:
  node packages/admin/dist/cli.js token issue --name <name> [--surface main] [--scope "*" --scope sensitive:read] [--scene "*"]
  node packages/admin/dist/cli.js token list
  node packages/admin/dist/cli.js token revoke <token-id>
  node packages/admin/dist/cli.js reindex [--force]
  node packages/admin/dist/cli.js stats
  node packages/admin/dist/cli.js health [--endpoint http://127.0.0.1:8787]
  node packages/admin/dist/cli.js import-social --file <social-v2.json> --scene <qq:group:ID> [--dry-run]

config: ${JSON.stringify({ dataDir: config.dataDir, memoriesDir: config.memoriesDir, port: config.port })}`);
}
