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

test('owner can pull recent group messages for a vague question', async () => {
  await post('/v1/ingest', fixture.tokens.group.token, {
    scene: 'qq:group:10001',
    messages: [{ message_id: 'grp-1', role: 'user', text: '群里在聊龙猫和饲养箱' }],
  });
  await post('/v1/ingest', fixture.tokens.privateB.token, {
    messages: [{ message_id: 'priv-1', role: 'user', text: '私聊里说的是仓鼠' }],
  });

  const recall = await post('/v1/recall', fixture.tokens.owner.token, {
    scene: 'qq:owner',
    messages: [{ role: 'user', text: '今天群聊中聊了什么有意思的事情' }],
    scope: 'groups',
    since_hours: 24,
  });
  assert.equal(recall.statusCode, 200, JSON.stringify(recall.json()));
  const ids = (recall.json().results as { id: string }[]).map((item) => item.id);
  assert.ok(ids.some((id) => id.includes('qq:group:')), JSON.stringify(ids));
  assert.equal(ids.some((id) => id.includes('qq:private:')), false, 'third-party private must stay out');
});

test('scope=groups is owner-only', async () => {
  const recall = await post('/v1/recall', fixture.tokens.group.token, {
    scene: 'qq:group:10001',
    messages: [{ role: 'user', text: '今天群聊了什么' }],
    scope: 'groups',
  });
  assert.equal(recall.statusCode, 403);
});

test('live returns the main session chat to the pet, without sensitive rows', async () => {
  await post('/v1/ingest', fixture.tokens.main.token, {
    scene: 'main',
    messages: [
      { message_id: 'live-1', role: 'user', text: '我们在聊人是不是被经历塑造的' },
      { message_id: 'live-2', role: 'user', text: '把不满意的地方写到待办文档里' },
    ],
  });
  // A sensitive short-term row that must stay out of the pet's view.
  await post('/v1/write', fixture.tokens.main.token, {
    scene: 'main',
    kind: 'note',
    text: '工资到账 1280 元，别记错。',
    privacy: 'sensitive',
    stage: 'short',
  });

  const recall = await post('/v1/recall', fixture.tokens.pet.token, {
    messages: [{ role: 'user', text: '在吗' }],
    scene: 'pet',
    live: { k: 6, minutes: 30, scenes: ['main'] },
  });
  assert.equal(recall.statusCode, 200, JSON.stringify(recall.json()));
  const live = (recall.json().live ?? []) as { render: { text: string }; stage: string }[];
  const texts = live.map((item) => item.render.text).join('\n');
  assert.ok(texts.includes('经历塑造'), JSON.stringify(live));
  assert.ok(texts.includes('待办文档'), JSON.stringify(texts));
  assert.equal(texts.includes('1280'), false, 'sensitive rows must not leak into live');
  assert.ok(live.length > 0 && live.every((item) => item.stage === 'short'));
});

test('live without scenes stays inside the token scopes', async () => {
  await post('/v1/ingest', fixture.tokens.group.token, {
    scene: 'qq:group:10001',
    messages: [{ message_id: 'live-grp-1', role: 'user', text: '群里在聊龙猫和饲养箱' }],
  });

  const recall = await post('/v1/recall', fixture.tokens.pet.token, {
    messages: [{ role: 'user', text: '在吗' }],
    scene: 'pet',
    live: {},
  });
  assert.equal(recall.statusCode, 200, JSON.stringify(recall.json()));
  const texts = ((recall.json().live ?? []) as { render: { text: string } }[])
    .map((item) => item.render.text)
    .join('\n');
  assert.equal(texts.includes('龙猫'), false, 'group chat must not leak to the pet');
});
