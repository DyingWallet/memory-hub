import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, disposeFixture, GROUP_ID, type Fixture } from '../helpers/fixture.js';

/**
 * Cross-scene disclosure: a group member asks in a private chat about what
 * happened in one group. The membership check happens in the bridge (it has the
 * QQ member table); memd only honours the `disclose:group` scope and keeps the
 * scope of the disclosure narrow: one group, chat/note, normal/personal only.
 */
let fixture: Fixture;

before(async () => {
  fixture = await createFixture();
  const post = (path: string, token: string, payload: unknown) =>
    fixture.built.app.inject({ method: 'POST', url: path, payload: payload as Record<string, unknown>, headers: { authorization: `Bearer ${token}` } });

  await post('/v1/ingest', fixture.tokens.group.token, {
    scene: `qq:group:${GROUP_ID}`,
    messages: [
      { message_id: 'disclose-1', role: 'user', text: '中午吃什么，群里投个票' },
      { message_id: 'disclose-2', role: 'assistant', text: '我投火锅' },
    ],
  });
  await post('/v1/ingest', fixture.tokens.privateB.token, {
    messages: [{ message_id: 'disclose-3', role: 'user', text: '私聊里说的是别的事' }],
  });
});

after(async () => {
  await disposeFixture(fixture);
});

function disclose(token: string, payload: Record<string, unknown>) {
  return fixture.built.app.inject({
    method: 'POST',
    url: '/v1/disclose',
    payload,
    headers: { authorization: `Bearer ${token}` },
  });
}

test('disclose 只返回目标群的消息，不串私聊', async () => {
  const response = await disclose(fixture.tokens.disclose.token, {
    requester: '10002',
    group: `qq:group:${GROUP_ID}`,
    since_hours: 24,
    k: 10,
  });
  assert.equal(response.statusCode, 200, JSON.stringify(response.json()));
  const body = response.json() as { group: string; count: number; results: { id: string; render: { text: string } }[] };
  assert.equal(body.group, `qq:group:${GROUP_ID}`);
  assert.ok(body.count > 0, 'group messages are returned');
  assert.ok(body.results.every((item) => item.id.includes(`qq:group:${GROUP_ID}`)), JSON.stringify(body.results.map((r) => r.id)));
  assert.equal(
    body.results.some((item) => /私聊里说的是别的事/.test(item.render.text)),
    false,
    'third-party private chat must never leak',
  );
});

test('不传 since_hours 时不限时间窗：成员看得到全部历史', async () => {
  // 把群消息的时间推到 30 天前，模拟「很久以前的历史」。
  const old = Date.now() - 30 * 24 * 3_600_000;
  fixture.built.db.prepare('UPDATE chunks SET updated_at = ? WHERE scene = ?').run(old, `qq:group:${GROUP_ID}`);
  fixture.built.db.prepare('UPDATE docs SET updated_at = ? WHERE scene = ?').run(old, `qq:group:${GROUP_ID}`);

  const response = await disclose(fixture.tokens.disclose.token, {
    requester: '10002',
    group: `qq:group:${GROUP_ID}`,
  });
  assert.equal(response.statusCode, 200, JSON.stringify(response.json()));
  const body = response.json() as { since_hours: number; count: number };
  assert.equal(body.since_hours, 0, '0 表示不限时间');
  assert.ok(body.count > 0, '30 天前的消息也应该披露');

  // 带时间窗时仍然遵守：24 小时以内没有消息。
  const bounded = await disclose(fixture.tokens.disclose.token, {
    requester: '10002',
    group: `qq:group:${GROUP_ID}`,
    since_hours: 24,
  });
  assert.equal((bounded.json() as { count: number }).count, 0);
});

test('没有 disclose:group 的令牌被拒绝', async () => {
  for (const token of [fixture.tokens.group.token, fixture.tokens.owner.token, fixture.tokens.privateB.token]) {
    const response = await disclose(token, { requester: '10002', group: `qq:group:${GROUP_ID}` });
    assert.equal(response.statusCode, 403, `${token === fixture.tokens.group.token ? 'group' : 'other'} token must be rejected`);
  }
});

test('群号格式不合法时返回 400', async () => {
  const response = await disclose(fixture.tokens.disclose.token, { requester: '10002', group: 'not-a-group' });
  assert.equal(response.statusCode, 400);
});

test('披露会写一条带 group 的审计', async () => {
  await disclose(fixture.tokens.disclose.token, { requester: '10002', group: `qq:group:${GROUP_ID}` });
  const { readFileSync } = await import('node:fs');
  const lines = readFileSync(fixture.config.auditFile, 'utf8').trim().split('\n');
  const entries = lines.map((line) => JSON.parse(line) as { route: string; group?: string; requester_hash?: string; query_hash?: string });
  const disclosure = entries.filter((entry) => entry.route === 'disclose');
  assert.ok(disclosure.length >= 1, 'disclose entries exist');
  const last = disclosure[disclosure.length - 1];
  assert.equal(last?.group, `qq:group:${GROUP_ID}`);
  assert.ok(last?.requester_hash && last.requester_hash.length === 16, 'requester is hashed, not stored raw');
  assert.equal(JSON.stringify(last).includes('10002'), false, 'raw QQ number never lands in the audit log');
});
