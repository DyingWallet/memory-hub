// 黑话研究「未确认」时的 AI 推测（lastGuess）：只给控制台管理员看，不是含义。全部离线、假数据。
//   ① 词库字段：清洗、限长、空推测为 null，旧词库没有该字段也能读；
//   ② 不进提示词、不算含义：buildSlangContext 不读它，有推测的候选不会被注入；
//   ③ 不进给 AI 的数据：publicSlangEntry 字段白名单不含它，GET /api/slang 拒绝 agent token；
//   ④ bridge 研究流程：未确认时写 lastGuess（不写 meaning），确认 / 管理员填含义 / 批量确认时清空；
//   ⑤ 控制台页面：推测只显示在「待研究」里，内容转义，「采用为含义」只填编辑框、不直接保存。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  normalizeSlangEntry, createSlangEntry, slangGuessFromResult, buildSlangContext, saveSlang, loadSlang, SLANG_STATUS,
} from '../src/slang-learner.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const GUESS = '示例推测：表示「很厉害」的夸张说法';

test('① lastGuess 字段：清洗控制字符、限长、空推测为 null，旧词库能读、能存回', () => {
  assert.equal(normalizeSlangEntry({ content: '示例词' }).lastGuess, null, '旧词条没有该字段 → null');
  assert.equal(slangGuessFromResult({ meaning: '  ', usage: '' }), null, '没有推测内容 → null');
  assert.equal(slangGuessFromResult(null), null);
  const g = slangGuessFromResult({ meaning: ` ${GUESS}\u0001 `, usage: '用于夸人', example: 'x'.repeat(500) }, '2026-01-02T03:04:05.000Z');
  assert.equal(g.meaning, GUESS, '去掉首尾空白和控制字符');
  assert.equal(g.usage, '用于夸人');
  assert.ok(g.example.length <= 300, '限长与其它字段一致');
  assert.equal(g.at, '2026-01-02T03:04:05.000Z');
  assert.ok(Number.isFinite(Date.parse(normalizeSlangEntry({ content: 'a', lastGuess: { meaning: 'm', at: 'bad' } }).lastGuess.at)), '非法时间换成当前时间');
  assert.equal(normalizeSlangEntry({ content: 'a', lastGuess: 'not-object' }).lastGuess, null);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-slang-guess-'));
  try {
    const file = path.join(dir, 'slang.json');
    saveSlang(file, [{ ...createSlangEntry({ content: '示例词' }), lastGuess: g }]);
    const back = loadSlang(file);
    assert.deepEqual(back[0].lastGuess, g, '存盘再读回不丢');
    assert.equal(back[0].meaning, '', '推测不会变成含义');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('② 不进提示词：有推测的候选不注入；已确认词条也只注入 meaning / usage', () => {
  const candidate = normalizeSlangEntry({ content: '候选词', status: SLANG_STATUS.CANDIDATE, lastGuess: { meaning: GUESS } });
  assert.equal(buildSlangContext([candidate]), '', '只有推测、没有含义的候选不进黑话表');
  const confirmedWithStale = normalizeSlangEntry({ content: '已确认词', meaning: '正式含义', status: SLANG_STATUS.CONFIRMED, lastGuess: { meaning: GUESS } });
  const block = buildSlangContext([candidate, confirmedWithStale]);
  assert.match(block, /已确认词：正式含义/);
  assert.ok(!block.includes(GUESS), '推测文本不出现在注入内容里');
  const src = read('src/slang-learner.js');
  const fn = src.slice(src.indexOf('export function buildSlangContext'), src.indexOf('export function buildExtractionPrompt'));
  assert.ok(!fn.includes('lastGuess'), 'buildSlangContext 不读 lastGuess');
  const research = src.slice(src.indexOf('export function buildResearchPrompt'), src.indexOf('export function extractJsonArray'));
  assert.ok(!research.includes('lastGuess'), '重新研究时不把上次的推测喂回去（每次独立判断）');
});

test('③ 不进给 AI 的数据：publicSlangEntry 白名单不含 lastGuess；/api/slang 不在 agent token 白名单里', () => {
  const src = read('src/bridge.js');
  const pub = src.slice(src.indexOf('function publicSlangEntry(e) {'), src.indexOf('function confirmedSlangListV2()'));
  assert.ok(pub.length > 0);
  assert.ok(!pub.includes('lastGuess') && !pub.includes('...e'), '公开条目是字段白名单');
  const gate = src.slice(src.indexOf("if (req.headers['x-agent-token']) {\n          const agentAllowed"), src.indexOf("if (!agentAllowed) {"));
  assert.ok(gate.length > 0);
  assert.ok(!gate.includes('/api/slang'), 'AI 的令牌访问不了原始黑话库');
});

test('④ 研究流程：未确认写 lastGuess 不写含义；研究确认、管理员填含义、单条 / 批量确认时清空', () => {
  const src = read('src/bridge.js');
  const start = src.indexOf('const results = parseResearchJson(output);');
  const loop = src.slice(start, src.indexOf('saveSlangStore();', start));
  const skip = loop.slice(loop.indexOf('if (r.confirmed !== true)'), loop.indexOf('if (r.meaning) entry.meaning'));
  assert.match(skip, /const lastGuess = slangGuessFromResult\(r\);\s*if \(lastGuess\) entry\.lastGuess = lastGuess;\s*continue;/, '有推测才覆盖，没给推测保留上一次');
  assert.ok(!/entry\.(meaning|usage|example)\s*=/.test(skip), '未确认分支不改含义 / 用法 / 示例');
  const written = loop.slice(loop.indexOf('if (r.meaning) entry.meaning'));
  assert.match(written, /entry\.lastGuess = null;/, '研究确认后清空推测');

  const patch = src.slice(src.indexOf("if (req.method === 'PATCH' && slangMatch && !slangMatch[2])"), src.indexOf("if (req.method === 'POST' && slangMatch && slangMatch[2] === 'confirm')"));
  assert.match(patch, /if \(String\(entry\.meaning \?\? ''\)\.trim\(\)\) entry\.lastGuess = null;/, '管理员填了含义就清空');
  assert.ok(!/body\.lastGuess/.test(src), '接口不接受外部写入 lastGuess');
  const confirm = src.slice(src.indexOf("if (req.method === 'POST' && slangMatch && slangMatch[2] === 'confirm')"), src.indexOf("if (req.method === 'POST' && slangMatch && slangMatch[2] === 'reject')"));
  assert.match(confirm, /entry\.lastGuess = null;/);
  const batch = src.slice(src.indexOf("url.pathname === '/api/slang/batch-confirm'"), src.indexOf("url.pathname === '/api/slang/batch-reject'"));
  assert.match(batch, /entry\.lastGuess = null;/);
  assert.match(src, /slangGuessFromResult,\n\s*SLANG_STATUS,/, 'bridge.js 从模块导入，不自己拼字段');
});

test('⑤ 控制台：推测只在「待研究」显示且转义；「采用为含义」只填空栏位、不直接保存', () => {
  const html = read('public/console.html');
  const fnSrc = html.slice(html.indexOf('function slangGuessHtml(e) {'), html.indexOf('function slangSearchFields(e) {'));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ctx = vm.createContext({ esc, Date });
  vm.runInContext(`${fnSrc}; globalThis.slangGuessHtml = slangGuessHtml;`, ctx);
  const out = ctx.slangGuessHtml({ lastGuess: { meaning: '<img src=x onerror=alert(1)>', usage: '夸人', at: '2026-01-02T03:04:05.000Z' } });
  assert.match(out, /AI 推测（未确认/);
  assert.ok(!out.includes('<img'), '推测内容转义后再放进页面');
  assert.match(out, /用法：夸人/);
  assert.equal(ctx.slangGuessHtml({}), '');
  assert.equal(ctx.slangGuessHtml({ lastGuess: { meaning: '', usage: '', example: '' } }), '');

  assert.match(html, /const guessHtml = status === 'candidate' && !e\.meaning \? slangGuessHtml\(e\) : '';/, '只在没有含义的候选（待研究）上显示');
  assert.match(html, /data-slang-adopt="\$\{esc\(e\.id\)\}"/);
  assert.match(html, /openSlangModal\(btn\.dataset\.slangAdopt, 'edit', \{ adoptGuess: true \}\)/, '采用 = 打开编辑框（保存后仍是候选）');
  const open = html.slice(html.indexOf('function openSlangModal('), html.indexOf('function closeSlangModal()'));
  assert.match(open, /if \(!input\.value\.trim\(\) && e\.lastGuess\[field\]\) input\.value = e\.lastGuess\[field\];/, '只填空着的栏位');
  assert.ok(!/api\(/.test(open), '打开编辑框时不调接口、不自动保存');
  const isResearched = html.slice(html.indexOf('function slangIsResearched(e) {'), html.indexOf('function slangTabStatus(tab)'));
  assert.ok(!isResearched.includes('lastGuess'), '有推测不算「已研究」');
});
