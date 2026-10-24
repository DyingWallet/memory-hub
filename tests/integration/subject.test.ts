// `subject`：记忆是关于谁的（主人 / 我自己 / 第三方）。
//
// - 缺省 owner：`subject` 出现之前写下的所有记录都按 owner 读；
// - self 与 owner 分开存、分开召回，同文本也不会被内容去重合并；
// - bootstrap 带上我自己的最近判断。
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, disposeFixture, type Fixture } from '../helpers/fixture.js';

let fixture: Fixture;

before(async () => {
  fixture = await createFixture();
});

after(async () => {
  await disposeFixture(fixture);
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function post(path: string, token: string, payload: unknown) {
  return fixture.built.app.inject({
    method: 'POST',
    url: path,
    payload: payload as Record<string, unknown>,
    headers: bearer(token),
  });
}

test('旧数据没有 subject 字段：按 owner 读出来', async () => {
  // fixture 里的 facts 都是这次改动之前的样子，没有 subject。
  const hits = await post('/v1/search', fixture.tokens.owner.token, { query: '樱花季', scene: 'qq:owner' });
  assert.equal(hits.statusCode, 200, JSON.stringify(hits.json()));
  const results = hits.json().results as { subject: string }[];
  assert.ok(results.length > 0, JSON.stringify(results));
  assert.ok(results.every((item) => item.subject === 'owner'), JSON.stringify(results));
});

test('subject=self 与 owner 分开存、分开召回，同样的文本不会被去重合并', async () => {
  const text = '记忆应该允许记下我自己的判断，而不只是关于主人的事实。';
  const owner = await post('/v1/write', fixture.tokens.owner.token, { kind: 'stance', text, scene: 'qq:owner' });
  const self = await post('/v1/write', fixture.tokens.owner.token, {
    kind: 'stance',
    text,
    subject: 'self',
    scene: 'qq:owner',
  });
  assert.equal(owner.statusCode, 200, JSON.stringify(owner.json()));
  assert.equal(self.statusCode, 200, JSON.stringify(self.json()));
  assert.notEqual(owner.json().id, self.json().id, 'same text, different subject -> different memory');
  assert.equal(self.json().duplicate, false);

  const selfHits = await post('/v1/search', fixture.tokens.owner.token, {
    query: '记忆 判断',
    subject: 'self',
    scene: 'qq:owner',
  });
  const selfResults = selfHits.json().results as { id: string; subject: string }[];
  const selfIds = selfResults.map((item) => item.id);
  assert.ok(selfIds.includes(self.json().id as string), JSON.stringify(selfIds));
  assert.equal(selfIds.includes(owner.json().id as string), false, 'owner copy must not leak into subject=self');
  assert.ok(selfResults.every((item) => item.subject === 'self'), JSON.stringify(selfResults));

  const ownerHits = await post('/v1/search', fixture.tokens.owner.token, {
    query: '记忆 判断',
    subject: 'owner',
    scene: 'qq:owner',
  });
  const ownerResults = ownerHits.json().results as { id: string; subject: string }[];
  const ownerIds = ownerResults.map((item) => item.id);
  assert.ok(ownerIds.includes(owner.json().id as string), JSON.stringify(ownerIds));
  assert.equal(ownerIds.includes(self.json().id as string), false);
  assert.ok(ownerResults.every((item) => item.subject === 'owner'), JSON.stringify(ownerResults));
});

test('recall 也支持按 subject 过滤', async () => {
  const recall = await post('/v1/recall', fixture.tokens.owner.token, {
    messages: [{ role: 'user', text: '我自己怎么看记忆这件事' }],
    subject: 'self',
    scene: 'qq:owner',
  });
  assert.equal(recall.statusCode, 200, JSON.stringify(recall.json()));
  const results = recall.json().results as { subject: string }[];
  assert.ok(results.every((item) => item.subject === 'self'), JSON.stringify(results));
});

test('bootstrap 带上我自己的最近判断', async () => {
  const boot = await post('/v1/bootstrap', fixture.tokens.main.token, { scene: 'main' });
  assert.equal(boot.statusCode, 200, JSON.stringify(boot.json()));
  const payload = boot.json() as { self: { title: string }[] };
  assert.ok(Array.isArray(payload.self));
  assert.ok(payload.self.some((item) => item.title.includes('记忆应该允许')), JSON.stringify(payload.self));
});

test('写 entry 时 subject 会被记进 fact 记录', async () => {
  const written = await post('/v1/write', fixture.tokens.main.token, {
    kind: 'note',
    text: '这条是关于别人的一条观察。',
    subject: 'other',
    scene: 'main',
  });
  assert.equal(written.statusCode, 200, JSON.stringify(written.json()));
  const got = await post('/v1/get', fixture.tokens.main.token, { id: written.json().id });
  assert.equal(got.statusCode, 200);
  assert.equal((got.json() as { memory: { subject: string } }).memory.subject, 'other');
});
