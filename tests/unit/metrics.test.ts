import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendHealthSample, METRICS_HEADER } from '@memsvc/server/metrics';

test('metrics CSV keeps one header and appends rows', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'memsvc-metrics-')), 'metrics.csv');
  appendHealthSample(file, { at: 1, ok: true, latencyMs: 12, docs: 3, facts: 4, chunks: 5, uptimeS: 6 });
  appendHealthSample(file, { at: 2, ok: false, latencyMs: 3001, error: 'timeout, "no reply"' });

  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines[0], METRICS_HEADER);
  assert.equal(lines.length, 3, 'header + two samples');
  assert.equal(lines[1], '1,1970-01-01T00:00:00.001Z,1,12,3,4,5,6,');
  assert.ok(lines[2]?.includes('"timeout, ""no reply"""'), lines[2]);
});
