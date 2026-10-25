import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanIngestText } from '@memsvc/server/ingest-filter';

test('纯占位消息被丢弃', () => {
  for (const raw of ['[图片]', '[表情124]', '[卡片消息]', '[语音]', '[转发消息]']) {
    const r = cleanIngestText(raw);
    assert.equal(r.drop, true, raw);
    assert.equal(r.reason, 'placeholder-only', raw);
  }
});

test('占位符后面有正文时保留正文', () => {
  const r = cleanIngestText('[图片] 今天天气不错');
  assert.equal(r.drop, false);
  assert.equal(r.text, '今天天气不错');
});

test('空串与只有空白被丢弃', () => {
  assert.equal(cleanIngestText('').reason, 'empty');
  assert.equal(cleanIngestText('   \n\t ').reason, 'empty');
});

test('一两个字的回应被丢弃', () => {
  for (const raw of ['好', '嗯', '6', '？']) {
    assert.equal(cleanIngestText(raw).reason, 'too-short', raw);
  }
});

test('两个字保留，阈值边界不误杀短回应', () => {
  // 「是的」「不行」这类两字回应可能有信息，交给排序/去重处理，不在入口误杀。
  assert.equal(cleanIngestText('是的').drop, false);
  assert.equal(cleanIngestText('不行').drop, false);
});

test('内部 prompt 被识别为噪音', () => {
  const petPrompt =
    '你是主人桌面上的Q版蓝发小女仆，会时不时碎碎念一句。说话要自然随意、短短一句（2-20字），' +
    '不要用 Markdown，不要自称 AI，不要解释自己怎么运作。你可以看到主会话最近在聊什么，' +
    '只在合适的时候插一句。';
  const r1 = cleanIngestText(petPrompt);
  assert.equal(r1.drop, true);
  assert.equal(r1.reason, 'internal-prompt');

  const slangPrompt =
    '你是一个群聊黑话学习器。请从下面的聊天记录中提取“可能是黑话/网络用语/抽象话/群内梗”的候选词，' +
    '只提取你无法确定含义、或需要群内语境才能理解的词，最多 20 个。';
  const r2 = cleanIngestText(slangPrompt);
  assert.equal(r2.drop, true);
  assert.equal(r2.reason, 'internal-prompt');

  const toolError =
    'You are repeating the exact same tool call over and over. Stop calling tools and answer the user directly.';
  assert.equal(cleanIngestText(toolError).reason, 'internal-prompt');
});

test('70 多字的内部 prompt 也会被识别（门槛 40）', () => {
  const slang =
    '你是一个群聊黑话学习器。请从下面的聊天记录中提取“可能是黑话/网络用语/抽象话/群内梗”的候选项，只提取你无法确定含义、或需要群内语境才能理解的词。';
  assert.equal(cleanIngestText(slang).reason, 'internal-prompt');
});

test('同开头但很短的话不会被误杀', () => {
  const r = cleanIngestText('你是主人桌面上的谁呀');
  assert.equal(r.drop, false);
  assert.equal(r.text, '你是主人桌面上的谁呀');
});

test('正常对话原样保留，空白折叠', () => {
  const r = cleanIngestText('  我们   今晚  把  memory-hub 的  去噪做完吧  ');
  assert.equal(r.drop, false);
  assert.equal(r.text, '我们 今晚 把 memory-hub 的 去噪做完吧');
});

test('自定义阈值生效', () => {
  assert.equal(cleanIngestText('1234', { minChars: 5 }).reason, 'too-short');
  assert.equal(cleanIngestText('12345', { minChars: 5 }).drop, false);
  assert.equal(
    cleanIngestText('SYSTEM PROMPT ' + 'x'.repeat(100), { internalPrefixes: ['SYSTEM PROMPT'], internalMinLength: 10 }).reason,
    'internal-prompt',
  );
});
