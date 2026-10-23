import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type BuiltApp } from '@memsvc/server/app';
import { loadConfig, type ServerConfig } from '@memsvc/server/config';
import { openDb } from '@memsvc/server/db';
import type { IssuedToken } from '@memsvc/server/tokens';

export interface Fixture {
  root: string;
  memoriesDir: string;
  factsDir: string;
  config: ServerConfig;
  built: BuiltApp;
  tokens: {
    main: IssuedToken;
    owner: IssuedToken;
    group: IssuedToken;
    privateA: IssuedToken;
    privateB: IssuedToken;
    pet: IssuedToken;
  };
}

export const GROUP_ID = '10001';
export const OWNER_QQ = '70903';
export const PRIVATE_A = '10002';
export const PRIVATE_B = '2791166082';

export async function createFixture(configOverrides: Partial<ServerConfig> = {}): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'memsvc-test-'));
  const memoriesDir = join(root, 'memories');
  const factsDir = join(memoriesDir, 'facts');
  const audiencesDir = join(memoriesDir, 'audiences');
  mkdirSync(join(memoriesDir, 'user'), { recursive: true });
  mkdirSync(join(memoriesDir, '50-knowledge'), { recursive: true });
  mkdirSync(factsDir, { recursive: true });
  mkdirSync(audiencesDir, { recursive: true });

  writeFileSync(
    join(memoriesDir, 'user', 'identity.md'),
    `---\ndate: 2026-10-23\nkind: identity\n---\n\n# 身份\n\n本地助手。\n`,
    'utf8',
  );
  writeFileSync(
    join(memoriesDir, '50-knowledge', 'pet.md'),
    `---\ndate: 2026-10-23\nkind: knowledge\ntags: [pet]\n---\n\n# 桌宠接入\n\nPC2005 的 dsh-pet 插件开放 HTTP API，可以广播文本进气泡。\n\n## 记忆简报\n\n记忆简报由 brief.mjs 生成，约 7k 字。\n`,
    'utf8',
  );
  writeFileSync(
    join(memoriesDir, 'user', 'preferences.md'),
    `---\ndate: 2026-10-21\nkind: preference\n---\n\n# 偏好\n\n喜欢轻软的语气，不用叠词。\n`,
    'utf8',
  );
  writeFileSync(
    join(audiencesDir, `qq-group-${GROUP_ID}.md`),
    `---\nid: qq:group:${GROUP_ID}\nkind: group\nname: 朋友群\nface: 群友，气氛比较松弛\nrelationship: 熟人\nboundaries: [工作, 股票]\nknown: [我叫助手]\n---\n`,
    'utf8',
  );

  const facts = [
    {
      schema_version: 1,
      id: 'f_work_1',
      ts: '2026-10-20T10:00:00.000Z',
      kind: 'event',
      text: '工资到账 1280 元，别记错。',
      audience: ['main', 'qq:owner'],
      privacy: 'sensitive',
      source: 'main',
      scene: 'main',
    },
    {
      schema_version: 1,
      id: 'f_group_1',
      ts: '2026-10-21T10:00:00.000Z',
      kind: 'qq-topic',
      text: '群里聊到樱花季的行程安排。',
      audience: [`qq:group:${GROUP_ID}`],
      privacy: 'normal',
      source: 'qq',
      scene: `qq:group:${GROUP_ID}`,
    },
    {
      schema_version: 1,
      id: 'f_secret_1',
      ts: '2026-10-22T10:00:00.000Z',
      kind: 'note',
      text: '这是 secret 级别的内容，谁都不该看到。',
      audience: ['main'],
      privacy: 'secret',
      source: 'main',
      scene: 'main',
    },
    {
      schema_version: 1,
      id: 'f_private_a',
      ts: '2026-10-22T11:00:00.000Z',
      kind: 'note',
      text: '和 A 的私聊里提过想换显示器。',
      audience: [`qq:private:${PRIVATE_A}`],
      privacy: 'personal',
      source: 'qq',
      scene: `qq:private:${PRIVATE_A}`,
    },
    {
      schema_version: 1,
      id: 'f_private_b',
      ts: '2026-10-22T12:00:00.000Z',
      kind: 'note',
      text: '和 B 的私聊里提过想养猫。',
      audience: [`qq:private:${PRIVATE_B}`],
      privacy: 'personal',
      source: 'qq',
      scene: `qq:private:${PRIVATE_B}`,
    },
  ];
  writeFileSync(join(factsDir, '2026-10.jsonl'), facts.map((fact) => JSON.stringify(fact)).join('\n') + '\n', 'utf8');

  const config = loadConfig({
    configFile: join(root, 'no-config.json'),
    dataDir: join(root, 'data'),
    memoriesDir,
    factsDir,
    audiencesDir,
    identityFile: join(memoriesDir, 'user', 'identity.md'),
    indexFile: join(root, 'data', 'index.db'),
    tokensFile: join(root, 'data', 'tokens.json'),
    auditFile: join(root, 'data', 'audit.jsonl'),
    hosts: ['127.0.0.1'],
    watch: false,
    logLevel: 'silent',
    ...configOverrides,
  });

  // Index once against a fresh DB, then hand the same DB to the app (reindex: false).
  const db = openDb(config.indexFile);
  const built = await buildApp({ config, db, logger: false });

  const tokens = {
    main: built.tokens.issue({ name: 'desktop-main', surface: 'main', scopes: ['*', 'sensitive:read'], scenes: ['main'] }),
    owner: built.tokens.issue({
      name: 'qq-owner',
      surface: 'qq:owner',
      scopes: ['*', 'sensitive:read'],
      scenes: ['qq:owner'],
    }),
    group: built.tokens.issue({
      name: 'qq-group',
      surface: `qq:group:${GROUP_ID}`,
      scopes: [`qq:group:${GROUP_ID}`],
      scenes: [`qq:group:${GROUP_ID}`],
    }),
    privateA: built.tokens.issue({
      name: 'qq-private-a',
      surface: `qq:private:${PRIVATE_A}`,
      scopes: [`qq:private:${PRIVATE_A}`],
      scenes: [`qq:private:${PRIVATE_A}`],
    }),
    privateB: built.tokens.issue({
      name: 'qq-private-b',
      surface: `qq:private:${PRIVATE_B}`,
      scopes: [`qq:private:${PRIVATE_B}`],
      scenes: [`qq:private:${PRIVATE_B}`],
    }),
    pet: built.tokens.issue({
      name: 'pet-brain',
      surface: 'pet',
      scopes: ['main', 'qq:owner', 'pet'],
      scenes: ['pet', 'main', 'qq:owner'],
    }),
  };

  return { root, memoriesDir, factsDir, config, built, tokens };
}

export async function disposeFixture(fixture: Fixture): Promise<void> {
  await fixture.built.app.close();
  fixture.built.db.close();
}
