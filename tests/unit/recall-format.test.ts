import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRecallBlock } from '@memsvc/server/recall-format';
import type { MemoryResult } from '@memsvc/protocol';

function result(id: string, text: string, extra: Partial<MemoryResult> = {}): MemoryResult {
  return {
    id,
    title: text.slice(0, 12),
    kind: 'note',
    render: { type: 'text', text },
    updated_at: '2026-10-27T03:10:00.000Z',
    ...extra,
  } as MemoryResult;
}

test('空结果返回空串', () => {
  assert.equal(renderRecallBlock([], undefined), '');
  assert.equal(renderRecallBlock([], []), '');
});

test('live 与长期记忆分块，live 带时间', () => {
  const block = renderRecallBlock(
    [result('f1', '主人喜欢轻软的语气')],
    [result('live1', '在改 README')],
    { liveMinutes: 30 },
  );
  assert.match(block, /【最近在聊的】（近 30 分钟/);
  assert.match(block, /- \d{2}:\d{2} 在改 README/);
  assert.match(block, /【长期记忆】（只是背景，不要原样复述）/);
  assert.match(block, /- 主人喜欢轻软的语气/);
});

test('没有 live 时只出长期记忆块', () => {
  const block = renderRecallBlock([result('f1', '一条事实')], undefined);
  assert.ok(!block.includes('最近在聊的'));
  assert.match(block, /【长期记忆】/);
});

test('owner_initiated 加标记', () => {
  const block = renderRecallBlock(
    [result('f1', '他提过那件事', { disclosure: 'owner_initiated' } as Partial<MemoryResult>)],
    undefined,
  );
  assert.match(block, /（对方自己提起过的）/);
});

test('每行按预算截断', () => {
  const long = '很长的内容'.repeat(200);
  const block = renderRecallBlock([result('f1', long)], undefined, { maxChars: 300 });
  const line = block.split('\n').find((l) => l.startsWith('- ')) ?? '';
  assert.ok(line.length <= 320, `行长应在预算内，实际 ${line.length}`);
});
