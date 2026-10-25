// 黑话库页面：「候选词-待研究 / 候选词-已研究」分栏的离线测试（不需要浏览器）。
// 直接从 public/console.html 取出分栏判定函数，用假数据验证；分栏只是页面视图，数据仍是 status=candidate。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const html = fs.readFileSync(path.join(root, 'public', 'console.html'), 'utf8');

function extractFn(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `找不到 ${name}`);
  let i = html.indexOf('{', start); let depth = 0;
  for (; i < html.length; i++) { if (html[i] === '{') depth++; else if (html[i] === '}' && --depth === 0) break; }
  return html.slice(start, i + 1);
}
const ctx = {};
vm.runInNewContext(['slangIsResearched', 'slangTabStatus', 'slangInTab'].map(extractFn).join('\n') + '\nthis.f = { slangIsResearched, slangTabStatus, slangInTab };', ctx);
const { slangIsResearched, slangTabStatus, slangInTab } = ctx.f;

const entries = [
  { id: 'a', status: 'candidate', meaning: '' },
  { id: 'b', status: 'candidate', meaning: '很厉害' },
  { id: 'c', status: 'candidate', meaning: '', usage: '夸人时用' },
  { id: 'd', status: 'candidate', example: '  ' },
  { id: 'e', status: 'confirmed', meaning: '已确认的' },
  { id: 'f', status: 'rejected' },
];
const ids = (tab) => entries.filter((e) => slangInTab(e, tab)).map((e) => e.id).join('');

test('有含义 / 用法 / 示例之一就算已研究；纯空白不算', () => {
  assert.equal(slangIsResearched(entries[0]), false);
  assert.equal(slangIsResearched(entries[1]), true);
  assert.equal(slangIsResearched(entries[2]), true);
  assert.equal(slangIsResearched(entries[3]), false);
});

test('两个候选分栏互不重叠且合起来等于全部候选；已确认/已拒绝不受影响', () => {
  assert.equal(ids('candidate'), 'ad');
  assert.equal(ids('researched'), 'bc');
  assert.equal(ids('confirmed'), 'e');
  assert.equal(ids('rejected'), 'f');
  assert.equal(slangTabStatus('researched'), 'candidate', '已研究栏仍按候选处理（确认/拒绝/批量操作接口不变）');
});

test('页面标签：待研究在前、已研究紧随其后，已确认 / 已拒绝保留', () => {
  const tabs = [...html.matchAll(/data-slang-tab="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(tabs.slice(0, 4), ['candidate', 'researched', 'confirmed', 'rejected']);
  assert.ok(html.includes('候选词-待研究') && html.includes('候选词-已研究'));
  assert.ok(html.includes('slangInTab(e, slangActiveTab)'), '批量勾选只作用于当前分栏');
});
