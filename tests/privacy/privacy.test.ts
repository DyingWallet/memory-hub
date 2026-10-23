import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, disposeFixture, GROUP_ID, type Fixture } from '../helpers/fixture.js';

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

test('group token cannot see work material', async () => {
  const response = await post('/v1/search', fixture.tokens.group.token, { query: '工资' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().results.length, 0, JSON.stringify(response.json()));
});

test('group token cannot get a work memory by id', async () => {
  const response = await post('/v1/get', fixture.tokens.group.token, { id: 'f_work_1' });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, 'not_found');
});

test('owner QQ private sees work material', async () => {
  const response = await post('/v1/search', fixture.tokens.owner.token, { query: '工资' });
  assert.equal(response.statusCode, 200);
  assert.ok(response.json().results.length >= 1);
});

test('main session sees work material', async () => {
  const response = await post('/v1/search', fixture.tokens.main.token, { query: '工资' });
  assert.ok(response.json().results.length >= 1);
});

test('a group token cannot pretend to be the owner scene', async () => {
  const response = await post('/v1/search', fixture.tokens.group.token, {
    query: '工资',
    scene: 'qq:owner',
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, 'forbidden');
});

test('private chats are invisible to each other and to the group', async () => {
  const a = await post('/v1/search', fixture.tokens.privateA.token, { query: '猫' });
  assert.equal(a.json().results.length, 0, 'A must not see B content');

  const b = await post('/v1/search', fixture.tokens.privateB.token, { query: '显示器' });
  assert.equal(b.json().results.length, 0, 'B must not see A content');

  const group = await post('/v1/search', fixture.tokens.group.token, { query: '显示器' });
  assert.equal(group.json().results.length, 0);
});

test('the owner view sees private chats (single star topology)', async () => {
  const response = await post('/v1/search', fixture.tokens.main.token, { query: '显示器' });
  assert.ok(response.json().results.length >= 1);
});

test('secret memories never leave the database', async () => {
  for (const token of [fixture.tokens.main.token, fixture.tokens.owner.token, fixture.tokens.group.token]) {
    const response = await post('/v1/search', token, { query: 'secret' });
    assert.equal(response.json().results.length, 0, 'secret leaked');
  }
});

test('group topic is visible inside its group only', async () => {
  const inside = await post('/v1/search', fixture.tokens.group.token, { query: '樱花' });
  assert.ok(inside.json().results.length >= 1);

  const outside = await post('/v1/search', fixture.tokens.privateB.token, { query: '樱花' });
  assert.equal(outside.json().results.length, 0);

  const groupId = `qq:group:${GROUP_ID}`;
  const otherGroup = fixture.built.tokens.issue({
    name: 'other-group',
    surface: 'qq:group:111',
    scopes: ['qq:group:111'],
  });
  const sibling = await post('/v1/search', otherGroup.token, { query: '樱花' });
  assert.equal(sibling.json().results.length, 0, `no leak into ${groupId}`);
});

test('shared identity is visible on every surface', async () => {
  for (const token of [fixture.tokens.main.token, fixture.tokens.owner.token, fixture.tokens.group.token, fixture.tokens.privateA.token]) {
    const response = await post('/v1/bootstrap', token, {});
    assert.equal(response.statusCode, 200);
    assert.match(response.json().identity, /助手/);
  }
});

test('a private token sees its own writes and nothing else', async () => {
  const written = await post('/v1/write', fixture.tokens.privateA.token, {
    kind: 'note',
    text: 'A 私聊里说想换一把椅子。',
  });
  assert.equal(written.statusCode, 200);

  const visible = await post('/v1/search', fixture.tokens.privateA.token, { query: '椅子' });
  assert.ok(visible.json().results.length >= 1);

  const sibling = await post('/v1/search', fixture.tokens.privateB.token, { query: '椅子' });
  assert.equal(sibling.json().results.length, 0);

  const group = await post('/v1/search', fixture.tokens.group.token, { query: '椅子' });
  assert.equal(group.json().results.length, 0);
});

test('owner-initiated disclosure: the owner bringing it up opens his own memories in that scene', async () => {
  const withoutOwner = await post('/v1/recall', fixture.tokens.group.token, {
    messages: [{ role: 'user', text: '上次桌宠接入那事' }],
    k: 3,
  });
  assert.equal(withoutOwner.json().results.length, 0, 'group must not see main-only memories by default');

  const withOwner = await post('/v1/recall', fixture.tokens.group.token, {
    messages: [{ role: 'user', text: '上次桌宠接入那事', from_owner: true }],
    k: 3,
  });
  const results = withOwner.json().results as { title: string; disclosure?: string }[];
  assert.ok(results.length >= 1, JSON.stringify(withOwner.json()));
  assert.equal(results[0]?.disclosure, 'owner_initiated');
});

test('owner-initiated disclosure does not leak work or other people privates', async () => {
  const work = await post('/v1/recall', fixture.tokens.group.token, {
    messages: [{ role: 'user', text: '工资到账多少', from_owner: true }],
    k: 3,
  });
  assert.equal(work.json().results.length, 0, 'work memory must stay closed even when owner speaks');

  const otherPrivate = await post('/v1/recall', fixture.tokens.group.token, {
    messages: [{ role: 'user', text: '显示器想换一个', from_owner: true }],
    k: 3,
  });
  assert.equal(otherPrivate.json().results.length, 0, 'other people private memories must stay closed');
});

test('owner-initiated disclosure is not a standing permission for search/get', async () => {
  const search = await post('/v1/search', fixture.tokens.group.token, { query: '桌宠' });
  assert.equal(search.json().results.length, 0);
  const get = await post('/v1/get', fixture.tokens.group.token, { id: 'f_work_1' });
  assert.equal(get.statusCode, 404);
});
