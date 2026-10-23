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

async function post(path: string, token: string, payload: unknown) {
  return fixture.built.app.inject({ method: 'POST', url: path, payload: payload as Record<string, unknown>, headers: bearer(token) });
}

test('pet sees owner memories but not work / group / third-party private', async () => {
  const work = await post('/v1/search', fixture.tokens.pet.token, { query: '工资', k: 5 });
  assert.equal(work.json().results.length, 0, 'work label must be hidden from pet');

  const group = await post('/v1/search', fixture.tokens.pet.token, { query: '樱花季', k: 5 });
  assert.equal(group.json().results.length, 0, 'group audience must be hidden from pet');

  const privateA = await post('/v1/search', fixture.tokens.pet.token, { query: '显示器', k: 5 });
  assert.equal(privateA.json().results.length, 0, 'third-party private must be hidden from pet');

  const own = await post('/v1/search', fixture.tokens.pet.token, { query: '轻软', k: 5 });
  assert.ok(own.json().results.length > 0, 'owner preference docs stay visible');

  const owner = await post('/v1/search', fixture.tokens.main.token, { query: '工资', k: 5 });
  assert.ok(owner.json().results.length > 0, 'owner still sees work memories');
});

test('pet ingest lands in the pet audience and stays reviewable', async () => {
  const ingest = await post('/v1/ingest', fixture.tokens.pet.token, {
    messages: [{ message_id: 'pet-m1', role: 'user', text: '桌宠这边记一下：今晚想听爵士' }],
  });
  assert.equal(ingest.statusCode, 200, JSON.stringify(ingest.json()));

  const petSearch = await post('/v1/search', fixture.tokens.pet.token, { query: '爵士' });
  assert.equal(petSearch.json().results[0]?.stage, 'short');
  assert.equal(petSearch.json().results[0]?.expires_at !== undefined, true);

  const ownerSearch = await post('/v1/search', fixture.tokens.main.token, { query: '爵士' });
  assert.ok(ownerSearch.json().results.length > 0, 'owner (root) can audit pet short-term memories');

  const groupSearch = await post('/v1/search', fixture.tokens.group.token, { query: '爵士' });
  assert.equal(groupSearch.json().results.length, 0, 'pet memories must not leak into groups');
});

test('pet recall returns context but never work content', async () => {
  const recall = await post('/v1/recall', fixture.tokens.pet.token, {
    messages: [
      { role: 'user', text: '桌宠接入的 HTTP API 是怎么广播的' },
      { role: 'user', text: '顺便问下工资到账了吗' },
    ],
    k: 5,
  });
  assert.equal(recall.statusCode, 200);
  const texts = (recall.json().results as { render: { text: string } }[]).map((result) => result.render.text);
  assert.ok(texts.length > 0, 'pet still gets some context');
  assert.equal(texts.some((text) => text.includes('1280')), false, 'work amount must never reach pet recall');
});
