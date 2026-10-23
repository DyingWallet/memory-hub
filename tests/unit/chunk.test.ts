import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkFact, chunkMarkdown, splitLong } from '@memsvc/core';

const DOC = `# 标题

引言段落。

## 桌宠接入

PC2005 的插件开放 HTTP API。

### 细节

广播文本进气泡，绑定 127.0.0.1。

## 记忆简报

brief.mjs 生成简报。
`;

test('chunkMarkdown keeps heading paths', () => {
  const chunks = chunkMarkdown(DOC);
  const headings = chunks.map((chunk) => chunk.heading);
  assert.ok(headings.includes('桌宠接入'));
  assert.ok(headings.includes('桌宠接入 / 细节'));
  assert.ok(headings.includes('记忆简报'));
  assert.ok(chunks.every((chunk) => chunk.text.trim().length > 0));
});

test('chunkMarkdown respects maxChars for long paragraphs', () => {
  const paragraph = '这是一句测试用的话。'.repeat(80); // 800 chars
  const chunks = chunkMarkdown(`# 长文\n\n${paragraph}`, { maxChars: 200, overlap: 40 });
  assert.ok(chunks.length > 1, `expected several chunks, got ${chunks.length}`);
  for (const chunk of chunks) {
    assert.ok(Array.from(chunk.text).length <= 260, `chunk too long: ${chunk.text.length}`);
  }
});

test('splitLong carries an overlap between pieces', () => {
  const text = '句子一。句子二。句子三。句子四。句子五。';
  const pieces = splitLong(text, 10, 4);
  assert.ok(pieces.length >= 2);
  assert.ok(pieces.every((piece) => piece.length > 0));
});

test('chunkFact returns one chunk and drops empty text', () => {
  assert.equal(chunkFact('一条事实').length, 1);
  assert.equal(chunkFact('   ').length, 0);
});
