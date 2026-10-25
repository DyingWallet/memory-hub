/**
 * 包 A 的回归测试：镜像痕迹（失败流水 / 遗忘队列）+ 对账判定 + 索引只读校验。
 *
 * 跑法：node scripts/test-memory-integrity.mjs
 * 也可以并入 node --test：node --test scripts/test-memory-integrity.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { idemKey, mirrorKey, forgetKeys } from '../src/memory/idem.js';
import { createMirrorJournal } from '../src/memory/mirror-journal.js';
import { classify, collectEntries, loadIndex, sceneOfConversationKey } from '../src/memory/reconcile.js';
import { createMemoryBridge } from '../src/memory/memory-bridge.js';

const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const quiet = { warn() {}, info() {} };
const tempRoot = () => mkdtempSync(join(tmpdir(), 'qq-mirror-'));

test('idemKey：形状稳定，场景/类别/目标/文本任一变化都换键', () => {
  const base = idemKey('qq:owner', 'activeTopic', {}, '桌宠那事');
  assert.match(base, /^qq:owner:activeTopic:[0-9a-f]{16}$/);
  assert.equal(idemKey('qq:owner', 'activeTopic', {}, '桌宠那事'), base, '同样输入必须同键（重试才对得上）');
  assert.notEqual(idemKey('qq:owner', 'activeTopic', {}, '桌宠那事！'), base);
  assert.notEqual(idemKey('qq:private:10001', 'activeTopic', {}, '桌宠那事'), base);
  assert.notEqual(idemKey('qq:private:10001', 'memberImpression', { target: '甲' }, '话少'), idemKey('qq:private:10001', 'memberImpression', { target: '乙' }, '话少'));
});

test('失败流水：追加 JSONL，字段齐全，写不进去也不抛', () => {
  const root = tempRoot();
  try {
    const journal = createMirrorJournal({ root, log: quiet, now: () => Date.UTC(2026, 9, 26, 1, 0, 0) });
    journal.recordFailure({ op: 'write', scene: 'qq:group:1', category: 'activeTopic', error: new Error('timeout 800ms') });
    journal.recordFailure({ op: 'forget', scene: 'qq:owner', category: 'memberImpression', target: '甲', error: 'ECONNREFUSED' });
    const lines = readFileSync(journal.files.failureFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].op, 'write');
    assert.equal(lines[0].scene, 'qq:group:1');
    assert.equal(lines[0].error, 'timeout 800ms');
    assert.equal(lines[1].target, '甲');
    assert.match(lines[0].ts, /^2026-10-26T01:00:00\.000Z$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('遗忘队列：同键去重、失败累计、超过上限留给人工且不静默丢弃', async () => {
  const root = tempRoot();
  try {
    const journal = createMirrorJournal({ root, log: quiet, maxAttempts: 2 });
    const key = idemKey('qq:owner', 'activeTopic', {}, '该忘掉的');
    journal.enqueueForget({ scene: 'qq:owner', category: 'activeTopic', text: '该忘掉的', error: 'boom' }, key);
    journal.enqueueForget({ scene: 'qq:owner', category: 'activeTopic', text: '该忘掉的', error: 'boom again' }, key);
    assert.equal(journal.readQueue().length, 1, '同一条不重复入队');
    assert.equal(journal.readQueue()[0].lastError, 'boom again');

    const first = await journal.drain(async () => false);
    assert.deepEqual({ drained: first.drained, left: first.left }, { drained: 0, left: 1 });
    assert.equal(journal.readQueue()[0].attempts, 1);

    await journal.drain(async () => false);
    const capped = await journal.drain(async () => false);
    assert.equal(capped.gaveUp, 1, '到上限后仍留在队列里（等人工），不算成功');
    assert.equal(journal.readQueue().length, 1);

    const ok = createMirrorJournal({ root, log: quiet });
    const result = await ok.drain(async () => true);
    assert.equal(result.drained, 1);
    assert.equal(ok.readQueue().length, 0, '成功后出队');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('轻量条目摊平：会话键 → 场景，类别 → kind', () => {
  assert.equal(sceneOfConversationKey('group:650866701', '709038511'), 'qq:group:650866701');
  assert.equal(sceneOfConversationKey('private:709038511', '709038511'), 'qq:owner');
  assert.equal(sceneOfConversationKey('private:10001', '709038511'), 'qq:private:10001');

  const social = {
    conversations: {
      'private:709038511': { activeTopics: [{ text: '桌宠那事' }], pendingThoughts: [{ text: '问他细节' }] },
      'private:10001': { memberImpressions: { 甲: '话少但会先自我介绍' } },
    },
  };
  const entries = collectEntries(social, '709038511');
  const byCategory = Object.fromEntries(entries.map((entry) => [`${entry.scene}|${entry.category}`, entry]));
  assert.equal(entries.length, 3);
  assert.equal(byCategory['qq:owner|activeTopic'].kind, 'qq-topic');
  assert.equal(byCategory['qq:owner|pendingThought'].kind, 'qq-topic');
  assert.equal(byCategory['qq:private:10001|memberImpression'].kind, 'qq-impression');
  assert.equal(byCategory['qq:private:10001|memberImpression'].target, '甲');
});

test('对账判定：present / legacy(text-only) / missing 分开，长期层多出的只报不删', () => {
  const social = {
    conversations: {
      'private:709038511': { activeTopics: [{ text: '原文原样' }, { text: '只迁移过文本' }, { text: '完全没写过' }] },
    },
  };
  const entries = collectEntries(social, '709038511');
  const keyPresent = idemKey('qq:owner', 'activeTopic', {}, '原文原样');
  const index = {
    schemaVersion: '3',
    docs: [
      { id: 'f_1', kind: 'qq-topic', scenes: new Set(['qq:owner']), text: '原文原样' },
      { id: 'import:1', kind: 'qq-topic', scenes: new Set(['qq:owner']), text: '只迁移过文本' },
      { id: 'f_digest', kind: 'qq-topic', scenes: new Set(['qq:owner']), text: '[群摘要] 与他无关' },
    ],
    idem: new Map([
      [keyPresent, 'f_1'],
      ['qq:owner:activeTopic:deadbeefdeadbeef', 'f_1'],
    ]),
  };
  const result = classify(entries, index);
  assert.deepEqual(result.counts, {
    live: 3,
    present: 1,
    legacy: 1,
    partial: 0,
    missing: 1,
    superseded: 0,
    orphanIdem: 1,
    staleDocs: 1,
  });
  assert.equal(result.legacy[0].reason, 'text-only');
  assert.equal(result.missing[0].reason, 'no-idem');
  assert.equal(result.missing[0].text, '完全没写过');
  assert.equal(result.orphanIdem[0].idemKey, 'qq:owner:activeTopic:deadbeefdeadbeef');
  assert.equal(result.staleDocs[0].id, 'f_digest', '摘要只统计，不进 missing/legacy');
});

test('mirrorKey：有 id 用身份键，没 id 回退内容指纹，成员印象按 target', () => {
  assert.equal(mirrorKey('qq:owner', 'activeTopic', { id: 'a3f91c07', rev: 2 }, '随便'), 'qq:mirror:qq:owner:activeTopic:a3f91c07:2');
  assert.equal(mirrorKey('qq:owner', 'activeTopic', { id: 'a3f91c07' }, '随便'), 'qq:mirror:qq:owner:activeTopic:a3f91c07:1');
  // 无 id → 旧格式（内容是唯一的输入）
  assert.equal(mirrorKey('qq:owner', 'activeTopic', {}, '旧条目'), idemKey('qq:owner', 'activeTopic', {}, '旧条目'));
  // 成员印象：id 是 m:<target>，键里用 target（编码后）
  assert.equal(
    mirrorKey('qq:private:10001', 'memberImpression', { id: 'm:甲', rev: 3, target: '甲' }, '整串'),
    `qq:mirror:qq:private:10001:memberImpression:${encodeURIComponent('甲')}:3`,
  );
  // 同一版本重复写必须同键（幂等），换 rev 必须换键（编辑）
  const a = mirrorKey('qq:owner', 'activeTopic', { id: 'x', rev: 1 }, '文本');
  assert.equal(mirrorKey('qq:owner', 'activeTopic', { id: 'x', rev: 1 }, '文本'), a);
  assert.notEqual(mirrorKey('qq:owner', 'activeTopic', { id: 'x', rev: 2 }, '文本'), a);

  // forget 要两把键都试：新键 + 旧内容键
  const keys = forgetKeys('qq:owner', 'activeTopic', { id: 'x', rev: 2 }, '文本');
  assert.equal(keys[0], 'qq:mirror:qq:owner:activeTopic:x:2');
  assert.equal(keys[1], idemKey('qq:owner', 'activeTopic', { id: 'x', rev: 2 }, '文本'));
  assert.deepEqual(forgetKeys('qq:owner', 'activeTopic', {}, '无 id'), [idemKey('qq:owner', 'activeTopic', {}, '无 id')]);
});

test('编辑遗留：同一条目的旧 rev 在 memd 里要被标成 superseded', () => {
  const social = { conversations: { 'private:709038511': { activeTopics: [{ id: 'abc12345', rev: 2, text: '第二版' }] } } };
  const entries = collectEntries(social, '709038511');
  const index = {
    schemaVersion: '3',
    docs: [
      { id: 'f_v2', kind: 'qq-topic', scenes: new Set(['qq:owner']), text: '第二版' },
      { id: 'f_v1', kind: 'qq-topic', scenes: new Set(['qq:owner']), text: '第一版' },
    ],
    idem: new Map([
      [mirrorKey('qq:owner', 'activeTopic', { id: 'abc12345', rev: 2 }, '第二版'), 'f_v2'],
      [mirrorKey('qq:owner', 'activeTopic', { id: 'abc12345', rev: 1 }, '第一版'), 'f_v1'],
    ]),
  };
  const result = classify(entries, index);
  assert.equal(result.counts.present, 1);
  assert.equal(result.counts.superseded, 1);
  assert.equal(result.superseded[0].docId, 'f_v1');
  assert.equal(result.superseded[0].rev, 1);
  assert.equal(result.superseded[0].currentRev, 2);
});

test('截断副本单独归类：不算 present，也不进 --fix 名单', () => {
  const text = '沐沐会问货币基金的分红方式、按月结转、节假日收益这类细节，大概自己在买货基，问起来还挺具体的';
  const social = { conversations: { 'private:709038511': { activeTopics: [{ text }] } } };
  const entries = collectEntries(social, '709038511');
  const index = {
    schemaVersion: '3',
    docs: [{ id: 'import:trunc', kind: 'qq-topic', scenes: new Set(['qq:owner']), text: 'member-0: 沐沐会问货币基金的分红方式、按月结转、节假日收益这类细节，大概自己在买货基' }],
    idem: new Map(),
  };
  const result = classify(entries, index);
  assert.equal(result.counts.partial, 1);
  assert.equal(result.counts.missing, 0);
  assert.equal(result.partial[0].reason, 'partial-text');
  assert.equal(result.partial[0].matchedDocId, 'import:trunc');
});

/**
 * adapter 客户端把任何失败都吞成 `false`（memory-client.ts: catch { return false }），
 * 所以只捕获异常的版本在真实环境里**一条痕迹都不会留下**。这条测试专门钉住
 * 「返回 false 也要留痕」——它是包 A 里最容易写错的一处。
 */
test('镜像失败即使只是返回 false，也要落失败流水与遗忘队列', async (t) => {
  const clientPath = ['../memory-hub/packages/adapter-qq/dist/memory-client.mjs', '../../memory-hub/packages/adapter-qq/dist/memory-client.mjs']
    .map((candidate) => resolve(ROOT_DIR, candidate))
    .find((candidate) => existsSync(candidate));
  if (!clientPath) return t.skip('adapter memory-client.mjs not built');

  const root = tempRoot();
  try {
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(join(root, 'state', 'dummy.token'), 'not-a-real-token', 'utf8');
    const bridge = createMemoryBridge({
      root,
      log: quiet,
      cfg: {
        ownerQQ: '10001',
        memory: { enabled: true, endpoint: 'http://127.0.0.1:1', tokens: { owner: 'state/dummy.token' }, timeoutMs: 300, clientPath },
      },
    });
    bridge.mirrorWrite('private:10001', 'activeTopic', '写不进去也要留痕');
    bridge.mirrorForget('private:10001', 'memberImpression', '忘不掉也要留痕', { target: '甲' });
    await new Promise((resolveDone) => setTimeout(resolveDone, 800));
    bridge.stopForgetQueue();

    const failures = readFileSync(join(root, 'logs', 'mirror-failures.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(failures.length, 2);
    assert.deepEqual(failures.map((entry) => entry.op).sort(), ['forget', 'write']);
    assert.equal(failures[0].error, 'client returned false');

    const queue = readFileSync(join(root, 'state', 'forget-queue.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(queue.length, 1, '只有 forget 进队列，write 不进（重写会重复）');
    assert.equal(queue[0].target, '甲');
    assert.equal(queue[0].attempts, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('遗忘队列要带着身份信息：重试算出的键必须与写入时一致', () => {
  const root = tempRoot();
  try {
    const journal = createMirrorJournal({ root, log: quiet });
    const scene = 'qq:private:10001';
    const entry = { id: 'abcd1234', rev: 2 };
    const key = mirrorKey(scene, 'activeTopic', entry, '要忘掉的文本');
    journal.enqueueForget({ scene, category: 'activeTopic', text: '要忘掉的文本', error: 'boom', entry }, key);
    const [item] = journal.readQueue();
    assert.deepEqual(item.entry, entry, '队列项必须落盘 id/rev，否则重试会算成另一把键');
    assert.equal(item.dedupeKey, key);
    assert.equal(mirrorKey(item.scene, item.category, item.entry, item.text), key);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('索引只读校验：schema_version 不对就拒绝，而不是猜', () => {
  const root = tempRoot();
  const file = join(root, 'index.db');
  try {
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);');
    db.exec('CREATE TABLE chunks (doc_id TEXT, id TEXT, kind TEXT, audience TEXT, text TEXT);');
    db.prepare("insert into meta (key, value) values ('schema_version', '3')").run();
    db.prepare("insert into chunks (doc_id, id, kind, audience, text) values ('f_1','c1','qq-topic','[\"qq:owner\"]','正文')").run();
    db.close();

    const loaded = loadIndex(file);
    assert.equal(loaded.schemaVersion, '3');
    assert.equal(loaded.docs.length, 1);
    assert.deepEqual([...loaded.docs[0].scenes], ['qq:owner']);
    assert.ok(existsSync(file));

    const db2 = new DatabaseSync(file);
    db2.prepare("update meta set value = '2' where key = 'schema_version'").run();
    db2.close();
    assert.throws(() => loadIndex(file), /schema_version is "2", expected 3/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
