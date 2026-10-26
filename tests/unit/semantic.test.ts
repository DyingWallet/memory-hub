import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { buildVocabulary, tokenizeText } from '@memsvc/server/embedding';
import { SemanticIndex, distanceToCosine, mergeHybrid, normalizeScores } from '@memsvc/server/semantic';
import type { SearchHit } from '@memsvc/server/search';
import { normalizeSemantic } from '@memsvc/server/config';
import { openDb } from '@memsvc/server/db';

function hit(id: string, score: number, updatedAt = 0): SearchHit {
  return {
    id,
    path: `facts/${id}.md`,
    title: id,
    heading: '',
    text: id,
    kind: 'note',
    updated_at: updatedAt,
    stage: 'long',
    expires_at: null,
    subject: 'owner',
    score,
  };
}

test('tokenizeText 加 CLS/SEP，中文一字一 token，常见文本没有 UNK', () => {
  const vocab = buildVocabulary(['[PAD]', '[UNK]', '[CLS]', '[SEP]', '主', '人', '喜', '欢', '爵', '士', '乐'].join('\n'));
  const ids = tokenizeText('主人喜欢爵士乐', vocab, 256);
  assert.equal(ids[0], 2, 'starts with [CLS]');
  assert.equal(ids[ids.length - 1], 3, 'ends with [SEP]');
  assert.equal(ids.length, 9, '7 chars + CLS + SEP');
  assert.ok(!ids.includes(1), 'no [UNK] for in-vocab characters');
  assert.deepEqual(ids.slice(1, 8), [4, 5, 6, 7, 8, 9, 10]);
});

test('tokenizeText 按 maxLen 截断，未登录词记 [UNK]', () => {
  const vocab = buildVocabulary(['[PAD]', '[UNK]', '[CLS]', '[SEP]', '主', '人'].join('\n'));
  const ids = tokenizeText('主人主主人主人', vocab, 5);
  assert.equal(ids.length, 5, 'maxLen includes CLS/SEP');
  assert.equal(ids[0], 2);
  assert.equal(ids[4], 3);
  const unknown = tokenizeText('Ω', vocab, 16);
  assert.equal(unknown[1], 1, 'unknown char becomes [UNK]');
});

test('distanceToCosine：归一化向量的 L2 距离可以换回余弦', () => {
  assert.equal(distanceToCosine(0), 1);
  // √2 距离对应正交；注意 1 - 2/2 在 JS 里是 -0，所以比大小而不是比相等。
  assert.ok(Math.abs(distanceToCosine(Math.SQRT2)) < 1e-9);
  assert.equal(distanceToCosine(2), -1);
});

test('normalizeScores 压到 [0,1]；全相等给 1；空数组给空', () => {
  assert.deepEqual(normalizeScores([1, 2, 3]), [0, 0.5, 1]);
  assert.deepEqual(normalizeScores([5, 5]), [1, 1]);
  assert.deepEqual(normalizeScores([]), []);
});

test('mergeHybrid：RRF 按排名融合，两边都命中的项排最前', () => {
  const fts = [hit('a', 10), hit('b', 5)];
  const semantic = [hit('b', 0.9), hit('c', 0.6)];
  const ids = (list: SearchHit[]): string[] => list.map((entry) => entry.id);
  const scoreAt = (list: SearchHit[], index: number): number => list[index]?.score ?? -1;

  // alpha 只剩「两路各自贡献多少」的比例，不再和裸分混算（RRF 只吃排名）。
  assert.deepEqual(ids(mergeHybrid(fts, semantic, 1, 3)), ['a', 'b', 'c'], 'alpha=1 时只有 FTS 排名生效，语义独有的 c 垫底');
  assert.deepEqual(ids(mergeHybrid(fts, semantic, 0, 3)), ['b', 'c', 'a'], 'alpha=0 时只有语义排名生效，FTS 独有的 a 垫底');

  const balanced = mergeHybrid(fts, semantic, 0.5, 3);
  // RRF_K=60：b 两边都进前二 → 0.5/62 + 0.5/61；a 只 FTS 第一 → 0.5/61；c 只语义第二 → 0.5/62。
  assert.deepEqual(ids(balanced), ['b', 'a', 'c'], '两边都命中的 b 拿到两份贡献，反超只在单边第一的 a');
  assert.ok(scoreAt(balanced, 0) > scoreAt(balanced, 1), 'b（两端命中）应高于只看 FTS 的 a');
  assert.ok(scoreAt(balanced, 1) > scoreAt(balanced, 2), 'a 应高于只看语义的 c');
});

test('mergeHybrid 只出现在一边的项不会被丢掉，且 k 生效', () => {
  const merged = mergeHybrid([hit('fts-only', 3)], [hit('sem-only', 0.8)], 0.5, 2);
  assert.deepEqual(merged.map((entry) => entry.id).sort(), ['fts-only', 'sem-only']);
  assert.equal(mergeHybrid([hit('x', 1)], [], 0.5, 1).length, 1);
});

test('normalizeSemantic 把越界配置夹回安全区间', () => {
  const config = normalizeSemantic(undefined, {
    enabled: true,
    alpha: 3,
    maxLen: 4096,
    batchSize: 64,
    threads: 99,
    backfillThreads: 0,
    maxCandidates: 99999,
  });
  assert.equal(config.enabled, true);
  assert.equal(config.alpha, 1);
  assert.equal(config.maxLen, 512);
  assert.equal(config.batchSize, 16);
  assert.equal(config.threads, 8);
  assert.equal(config.backfillThreads, 1);
  assert.equal(config.maxCandidates, 2000);
  assert.equal(normalizeSemantic(undefined, {}).enabled, false, '默认关闭');
});

test('模型不在时优雅不可用：不抛错、给出原因（检索退回 FTS）', async () => {
  const db = openDb(':memory:');
  try {
    const config = normalizeSemantic(undefined, { enabled: true, modelDir: 'models/definitely-not-here' });
    const opened = await SemanticIndex.create({ db, config });
    assert.equal(opened.index, null, 'no index when the model is missing');
    assert.equal(opened.status.enabled, true);
    assert.equal(opened.status.ready, false);
    assert.match(opened.status.reason ?? '', /model missing/);
  } finally {
    db.close();
  }
});

test('sqlite-vec：向量表可以写、可以查（扩展缺失时跳过）', async (t) => {
  let loadable = '';
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    loadable = (req('sqlite-vec') as { getLoadablePath(): string }).getLoadablePath();
  } catch {
    loadable = '';
  }
  if (!loadable) {
    t.skip('sqlite-vec not installed');
    return;
  }

  const db = new DatabaseSync(':memory:', { allowExtension: true });
  (db as unknown as { loadExtension(path: string): void }).loadExtension(loadable);
  db.exec('CREATE VIRTUAL TABLE chunk_vecs USING vec0(chunk_id TEXT PRIMARY KEY, embedding float[4])');
  const insert = db.prepare('INSERT INTO chunk_vecs(chunk_id, embedding) VALUES (?, ?)');
  const vector = (values: number[]): Uint8Array => new Uint8Array(new Float32Array(values).buffer);
  insert.run('a', vector([1, 0, 0, 0]));
  insert.run('b', vector([0, 1, 0, 0]));
  insert.run('c', vector([0.9, 0.1, 0, 0]));

  const rows = db
    .prepare('SELECT chunk_id, distance FROM chunk_vecs WHERE embedding MATCH ? ORDER BY distance LIMIT 2')
    .all(vector([1, 0, 0, 0])) as { chunk_id: string; distance: number }[];
  assert.deepEqual(rows.map((row) => row.chunk_id), ['a', 'c'], '最近的两个是 a 和 c');
  const [first, second] = rows;
  assert.ok(first && second, 'two rows returned');
  assert.ok(first.distance < second.distance);
  assert.ok(Math.abs(distanceToCosine(first.distance) - 1) < 1e-6, 'a 与查询完全一致');
  assert.ok(distanceToCosine(second.distance) > 0.9, 'c 的方向也很接近');
  db.close();
});
