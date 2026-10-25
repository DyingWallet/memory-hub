// 人格段抽取的回归测试（不依赖 QQ / 不联网）。
//
//   node scripts/test-persona-block.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonaReader, sectionBody } from '../src/persona-block.js';

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}\n     ${error?.message ?? error}`);
  }
}

const md = [
  '# 标题',
  '',
  '## 零、我是谁',
  '',
  '我是汐。',
  '',
  '## 一、语气',
  '',
  '- 轻软。',
  '- 不用叠词。',
  '',
  '## 二、专业',
  '',
  '带证据、路径行号。',
  '',
].join('\n');

check('抽到「我是谁」', () => {
  assert.equal(sectionBody(md, '我是谁'), '我是汐。');
});

check('抽到「语气」且不越界到下一节', () => {
  const body = sectionBody(md, '语气');
  assert.match(body, /轻软/);
  assert.equal(body.includes('带证据'), false);
});

check('标题带编号也能命中（包含匹配）', () => {
  assert.match(sectionBody(md, '零、我是谁'), /我是汐/);
});

check('不存在的节返回空串', () => {
  assert.equal(sectionBody(md, '不存在的节'), '');
});

const dir = mkdtempSync(join(tmpdir(), 'persona-'));
const file = join(dir, 'AGENTS.md');
writeFileSync(file, md, 'utf8');

check('reader 拼出两节，不包含桌面专用段落', () => {
  const reader = createPersonaReader({ file, log: () => {} });
  const text = reader.read();
  assert.match(text, /我是汐/);
  assert.match(text, /轻软/);
  assert.equal(text.includes('带证据'), false);
});

check('文件不存在时返回空串（不影响唤醒）', () => {
  const reader = createPersonaReader({ file: join(dir, 'nope.md'), log: () => {} });
  assert.equal(reader.read(), '');
});

check('whole 模式读整篇并去掉 frontmatter', () => {
  const wholeFile = join(dir, 'private-tone.md');
  writeFileSync(wholeFile, '---\ndate: 2026-10-25\nkind: profile\n---\n\n# 私密\n\n正文内容。\n', 'utf8');
  const reader = createPersonaReader({ file: wholeFile, whole: true, log: () => {} });
  const text = reader.read();
  assert.match(text, /私密/);
  assert.match(text, /正文内容/);
  assert.equal(text.includes('date: 2026-10-25'), false, 'frontmatter 必须去掉');
});

rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nall persona checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
