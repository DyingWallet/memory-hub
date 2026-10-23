import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { getMeta, setMeta } from '@memsvc/server/db';
import { markScenesNeedingReview, reminderSince } from '@memsvc/server/review';
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

test('a scene that needs review is marked and the next recall reports it', async () => {
  await post('/v1/ingest', fixture.tokens.main.token, {
    messages: [{ message_id: 'sched-1', role: 'user', text: '周六记得去取体检报告' }],
  });

  // Pretend the last review was long ago.
  setMeta(fixture.built.db, 'review:last:main', '0');
  const marked = markScenesNeedingReview(fixture.built.db, 20);
  assert.ok(marked.includes('main'), `expected main to be marked, got ${marked.join(',')}`);
  assert.ok(reminderSince(fixture.built.db, 'main'));

  const recall = await post('/v1/recall', fixture.tokens.main.token, {
    messages: [{ role: 'user', text: '体检报告' }],
  });
  assert.equal(recall.json().review.should_review, true);
  assert.ok(recall.json().review.reminder_since, JSON.stringify(recall.json().review));
});

test('looking at the review clears the reminder and restarts the interval', async () => {
  const review = await post('/v1/review', fixture.tokens.main.token, {});
  assert.equal(review.json().should_review, true);
  assert.ok(review.json().results.length >= 1);
  assert.equal(reminderSince(fixture.built.db, 'main'), undefined);

  const last = Number(getMeta(fixture.built.db, 'review:last:main'));
  assert.ok(last > 0, 'review records the time it was seen');

  const recall = await post('/v1/recall', fixture.tokens.main.token, {
    messages: [{ role: 'user', text: '体检报告' }],
  });
  assert.equal(recall.json().review.should_review, false, 'just reviewed, interval restarted');
});

test('status_only does not clear the reminder', async () => {
  setMeta(fixture.built.db, 'review:last:main', '0');
  markScenesNeedingReview(fixture.built.db, 20);

  const status = await post('/v1/review', fixture.tokens.main.token, { status_only: true });
  assert.equal(status.json().should_review, true);
  assert.deepEqual(status.json().results, []);
  assert.ok(reminderSince(fixture.built.db, 'main'), 'status_only is read-only');
});
