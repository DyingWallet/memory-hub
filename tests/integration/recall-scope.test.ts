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
