/**
 * 2026-10-27 的三处新契约：
 *
 *   1. `source` 只有 root 能标——否则群令牌能把写入伪装成 `sleep`，整批回滚会误删；
 *      非 root 时按场景落 `main` / `qq` / `pet`（pet 以前被算成 qq）。
 *   2. `rebuildDedupeKeys`：索引重建会丢 `dedupe:*`，这些键能从 JSONL 重算。
 *   3. `/v1/recent` 也支持 `format:"block"`，和 recall 一样由服务端渲染。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rebuildDedupeKeys } from '@memsvc/server/indexer';
import { createFixture, disposeFixture } from '../helpers/fixture.js';

test('source 只有 root 能标，非 root 按场景落值', async () => {
  const fixture = await createFixture();
  try {
    const asRoot = await fixture.built.app.inject({
      method: 'POST',
      url: '/v1/write',
      headers: { authorization: `Bearer ${fixture.tokens.main.token}` },
      payload: { kind: 'note', text: '整理产出（root 标 sleep）', source: 'sleep', subject: 'self' },
    });
    assert.equal(asRoot.statusCode, 200, JSON.stringify(asRoot.json()));
    const rootSource = fixture.built.db.prepare('SELECT source, scene FROM docs WHERE id = ?').get(asRoot.json().id) as {
      source: string;
      scene: string;
    };
    assert.equal(rootSource.source, 'sleep', 'root may label the source');

    const asPet = await fixture.built.app.inject({
      method: 'POST',
      url: '/v1/write',
      headers: { authorization: `Bearer ${fixture.tokens.pet.token}` },
      payload: { kind: 'note', text: '桌宠想冒充整理产出', source: 'sleep', scene: 'pet', subject: 'self' },
    });
    assert.equal(asPet.statusCode, 200, JSON.stringify(asPet.json()));
    const petSource = fixture.built.db.prepare('SELECT source FROM docs WHERE id = ?').get(asPet.json().id) as {
      source: string;
    };
    assert.equal(petSource.source, 'pet', 'non-root source is ignored; pet scene maps to pet, not qq');
  } finally {
    await disposeFixture(fixture);
  }
});

test('rebuildDedupeKeys 从 JSONL 重建 dedupe 键，重复调用是幂等的', async () => {
  const fixture = await createFixture();
  try {
    const count = () =>
      (fixture.built.db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'dedupe:%'").get() as { n: number }).n;
    const before = count();
    const restored = rebuildDedupeKeys(fixture.built.db, fixture.config);
    assert.ok(restored > 0, 'fixture has long facts, so at least one key should be rebuilt');
    assert.equal(count(), before + restored);

    const again = rebuildDedupeKeys(fixture.built.db, fixture.config);
    assert.equal(again, 0, 'second run must be a no-op');
    assert.equal(count(), before + restored);
  } finally {
    await disposeFixture(fixture);
  }
});

test('/v1/recent 传 format:block 时返回服务端渲染的块', async () => {
  const fixture = await createFixture();
  try {
    const plain = await fixture.built.app.inject({
      method: 'POST',
      url: '/v1/recent',
      headers: { authorization: `Bearer ${fixture.tokens.main.token}` },
      payload: { k: 5 },
    });
    assert.equal(plain.statusCode, 200);
    assert.equal(plain.json().block, undefined, 'block is opt-in');

    const rendered = await fixture.built.app.inject({
      method: 'POST',
      url: '/v1/recent',
      headers: { authorization: `Bearer ${fixture.tokens.main.token}` },
      payload: { k: 5, format: 'block' },
    });
    assert.equal(rendered.statusCode, 200);
    const body = rendered.json() as { block?: string; results: unknown[] };
    assert.equal(typeof body.block, 'string');
    assert.ok(body.results.length > 0, 'fixture has facts');
    assert.ok(body.block!.includes('【最近记下的】'), body.block);
  } finally {
    await disposeFixture(fixture);
  }
});
