// 时间线：按时间而不是相似度倒出「那阵子发生了什么」。
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

interface TimelineBody {
  from: string;
  to: string;
  total: number;
  months: { month: string; count: number; items: { id: string; updated_at: string; subject: string; title: string; supersedes?: string; superseded_by?: string }[] }[];
}

test('timeline 按月分组、按时间正序，且不做相似度筛选', async () => {
  const res = await post('/v1/timeline', fixture.tokens.owner.token, { from: '2026-10', to: '2026-11', scene: 'qq:owner' });
  assert.equal(res.statusCode, 200, JSON.stringify(res.json()));
  const body = res.json() as TimelineBody;
  assert.equal(body.months.length, 1, JSON.stringify(body.months.map((m) => m.month)));
  const month = body.months[0];
  assert.ok(month, 'one month bucket');
  assert.equal(month.month, '2026-10');
  assert.equal(month.count, month.items.length);

  const ids = month.items.map((item) => item.id);
  assert.ok(ids.includes('f_group_1'), JSON.stringify(ids));
  assert.ok(ids.includes('f_work_1'), 'root token sees the sensitive row');
  assert.equal(ids.includes('f_secret_1'), false, 'secret never shows up');

  const times = month.items.map((item) => item.updated_at);
  assert.deepEqual(times, [...times].sort(), 'oldest first');
});

test('timeline 受场景可见性限制：群令牌看不到主会话', async () => {
  const res = await post('/v1/timeline', fixture.tokens.group.token, { from: '2026-10', to: '2026-11', scene: 'qq:group:10001' });
  assert.equal(res.statusCode, 200, JSON.stringify(res.json()));
  const ids = (res.json() as TimelineBody).months.flatMap((month) => month.items.map((item) => item.id));
  assert.ok(ids.includes('f_group_1'), JSON.stringify(ids));
  assert.equal(ids.includes('f_work_1'), false);
  assert.equal(ids.includes('f_private_a'), false);
});

test('timeline 支持 subject=self，并能标出替代关系', async () => {
  const first = await post('/v1/write', fixture.tokens.main.token, {
    kind: 'stance',
    text: '一开始我认为记忆只要够全就够了。',
    subject: 'self',
    scene: 'main',
  });
  const second = await post('/v1/write', fixture.tokens.main.token, {
    kind: 'stance',
    text: '后来我改了主意：记忆得能记下自己的判断。',
    subject: 'self',
    supersedes: first.json().id,
    scene: 'main',
  });
  assert.equal(first.statusCode, 200, JSON.stringify(first.json()));
  assert.equal(second.statusCode, 200, JSON.stringify(second.json()));

  const res = await post('/v1/timeline', fixture.tokens.main.token, {
    from: '2026-01',
    to: '2027-01',
    subject: 'self',
    scene: 'main',
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.json()));
  const items = (res.json() as TimelineBody).months.flatMap((month) => month.items);
  assert.ok(items.every((item) => item.subject === 'self'), JSON.stringify(items));

  const older = items.find((item) => item.id === first.json().id);
  const newer = items.find((item) => item.id === second.json().id);
  assert.ok(older && newer);
  assert.equal(older.superseded_by, second.json().id, 'old judgement is marked as replaced');
  assert.equal(newer.supersedes, first.json().id);
});

test('timeline 拒绝倒序的区间', async () => {
  const res = await post('/v1/timeline', fixture.tokens.owner.token, { from: '2026-11', to: '2026-10' });
  assert.equal(res.statusCode, 400);
});
