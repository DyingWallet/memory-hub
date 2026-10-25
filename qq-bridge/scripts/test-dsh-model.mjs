// 控制台选择 DSH 模型（提供方 / 模型 / 思考强度 / 看图能力）。全部离线、假数据（虚构的提供方与模型）。
//   ① 模块：档位规范化、目录校验（不在目录 → 拒绝；档位不在该模型列表 → 拒绝并列出支持的档位；无档位模型忽略档位）；
//   ② 模块：selectModel 参数（无档位不带 reasoningEffort、不支持的档位交给模型默认、目录不可用按配置原样）；
//   ③ 模块：目录缓存（TTL、并发去重、超时、失败不缓存）、看图能力、第三方与价格提示、图片降级成文字；
//   ④ 桥接接口：GET 返回目录、POST 校验后写 config.json 并热生效、目录不可用拒绝保存、agent token 拒绝；
//   ⑤ 桥接运行时：会话按目录 selectModel；不能看图时聊天图片与工具图片都降级成文字、表情图 / 形象图拒绝返回。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  normalizeEffortId, validateModelSelection, resolveSelectModelParams, createModelCatalogCache,
  buildCatalogView, canSeeImages, knownVision, isFirstPartyProvider, isPriced, selectionNotices,
  mediaTextParts, mediaTextEntries, KNOWN_EFFORTS,
} from '../src/dsh-model.js';
import { DEFAULT_PRICE_TABLE } from '../src/model-prices.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const effort = (id) => ({ id, name: id.toUpperCase() });
const CATALOG = {
  default: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
  routableProviders: ['deepseek-official', 'example-cloud'],
  groups: [
    { id: 'deepseek-official', name: 'DeepSeek', models: [
      { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', reasoning: { efforts: ['off', 'low', 'high', 'max'].map(effort), defaultEffort: 'high' } },
    ] },
    { id: 'example-cloud', name: 'Example Cloud', models: [
      { id: 'example-chat', name: 'Example Chat' },
      { id: 'example-reasoner', name: 'Example Reasoner', reasoning: { efforts: ['low', 'high', 'max'].map(effort) } },
    ] },
  ],
  failures: [{ id: 'example-broken', name: 'Example Broken', message: 'not configured' }],
};

test('① 档位与目录校验：不在目录 / 档位不支持都拒绝，无档位模型忽略档位', () => {
  assert.deepEqual([...KNOWN_EFFORTS], ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(normalizeEffortId(' MAX '), 'max');
  assert.equal(normalizeEffortId(''), '', '空值 = 模型默认');
  assert.throws(() => normalizeEffortId('', { allowNone: false }), /请选择/);
  assert.throws(() => normalizeEffortId('turbo'), /只能是/);

  assert.deepEqual(validateModelSelection(CATALOG, { provider: 'example-cloud', model: 'example-reasoner', reasoningEffort: 'low', vision: 'yes' }),
    { provider: 'example-cloud', model: 'example-reasoner', reasoningEffort: 'low', vision: 'yes' });
  assert.throws(() => validateModelSelection(CATALOG, { provider: 'example-cloud', model: 'no-such-model' }), /模型目录里没有 example-cloud\/no-such-model/);
  assert.throws(() => validateModelSelection(CATALOG, { provider: 'nobody', model: 'x' }), /没有提供方 nobody/);
  assert.throws(() => validateModelSelection(CATALOG, { provider: 'example-cloud', model: 'example-reasoner', reasoningEffort: 'minimal' }), /只支持思考强度 low \/ high \/ max/);
  assert.throws(() => validateModelSelection(CATALOG, { provider: '', model: '' }), /请选择/);
  assert.equal(validateModelSelection(CATALOG, { provider: 'example-cloud', model: 'example-chat', reasoningEffort: 'low' }).reasoningEffort, '', '无档位模型：档位归一为空');
  assert.equal(validateModelSelection(CATALOG, { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off' }).reasoningEffort, 'off', 'off 档放开');
  assert.equal(validateModelSelection(CATALOG, { provider: 'deepseek-official', model: 'deepseek-flash', vision: 'weird' }).vision, 'auto');
});

test('② selectModel 参数：无档位不带字段、不支持的档位交给默认、目录不可用按配置原样', () => {
  assert.deepEqual(resolveSelectModelParams({ provider: 'example-cloud', model: 'example-chat', reasoningEffort: 'max' }, CATALOG),
    { params: { provider: 'example-cloud', model: 'example-chat' }, warning: '' });
  const r = resolveSelectModelParams({ provider: 'example-cloud', model: 'example-reasoner', reasoningEffort: 'off' }, CATALOG);
  assert.deepEqual(r.params, { provider: 'example-cloud', model: 'example-reasoner' });
  assert.match(r.warning, /不支持思考强度 off/);
  assert.deepEqual(resolveSelectModelParams({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' }, null).params,
    { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' }, '目录不可用：按配置原样，不阻塞聊天');
  assert.deepEqual(resolveSelectModelParams({}, null).params, { provider: 'deepseek-official', model: 'deepseek-flash' }, '默认值不变');
  assert.deepEqual(resolveSelectModelParams({ reasoningEffort: '' }, CATALOG).params, { provider: 'deepseek-official', model: 'deepseek-flash' }, '空档位 = 模型默认');
});

test('③ 目录缓存、看图能力、提示与图片降级', async () => {
  let now = 0;
  let calls = 0;
  let mode = 'ok';
  const cache = createModelCatalogCache({
    now: () => now, ttlMs: 1000, timeoutMs: 50,
    fetchCatalog: async () => {
      calls += 1;
      if (mode === 'fail') throw new Error('boom');
      if (mode === 'hang') return new Promise(() => {});
      if (mode === 'bad') return { nope: true };
      return CATALOG;
    },
  });
  const [a, b] = await Promise.all([cache.get(), cache.get()]);
  assert.ok(a.ok && b.ok);
  assert.equal(calls, 1, '并发去重');
  now = 500; await cache.get(); assert.equal(calls, 1, 'TTL 内用缓存');
  await cache.get({ force: true }); assert.equal(calls, 2, 'force 强刷');
  now = 5000; mode = 'fail';
  const failed = await cache.get();
  assert.equal(failed.ok, false); assert.match(failed.error, /boom/);
  mode = 'hang'; const hung = await cache.get(); assert.match(hung.error, /超时/);
  mode = 'bad'; assert.match((await cache.get()).error, /缺少 groups/);

  assert.equal(knownVision('deepseek-official', 'deepseek-flash'), 'yes');
  assert.equal(knownVision('deepseek-account', 'deepseek-flash'), 'yes', '桌面版 0.2.1 的提供方名');
  assert.equal(knownVision('example-cloud', 'deepseek-flash'), 'unknown', '第三方同名模型不算已知');
  assert.equal(canSeeImages({}), false, '没有提供方 / 模型时不猜');
  assert.equal(canSeeImages({ provider: 'deepseek-official', model: 'deepseek-flash' }), true, '默认模型能看图（QQ 收图不受影响）');
  assert.equal(canSeeImages({ provider: 'example-cloud', model: 'example-chat' }), false, '未知按不能看图');
  assert.equal(canSeeImages({ provider: 'example-cloud', model: 'example-chat', vision: 'yes' }), true, '管理员可手动指定');
  assert.equal(canSeeImages({ provider: 'deepseek-official', model: 'deepseek-flash', vision: 'no' }), false);

  assert.equal(isFirstPartyProvider('deepseek-official') && isFirstPartyProvider('deepseek-account'), true);
  assert.equal(isFirstPartyProvider('example-cloud'), false);
  assert.equal(isPriced('deepseek-official', 'deepseek-flash', DEFAULT_PRICE_TABLE), true);
  assert.equal(isPriced('example-cloud', 'deepseek-flash', DEFAULT_PRICE_TABLE), false, '第三方同名模型不按 DeepSeek 价目');

  const view = buildCatalogView(CATALOG, { priceTable: DEFAULT_PRICE_TABLE });
  assert.equal(view.providers.length, 2);
  assert.equal(view.providers[1].thirdParty, true);
  assert.deepEqual(view.providers[1].models[0].efforts, []);
  assert.equal(view.providers[0].models[0].defaultEffort, 'high');
  assert.equal(view.providers[0].models[0].vision, 'yes');
  assert.equal(view.failures[0].id, 'example-broken');

  const codes = (x) => selectionNotices(x).map((n) => n.code).sort();
  assert.deepEqual(codes({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max', vision: 'auto', priced: true }), [], '默认配置没有提示');
  assert.deepEqual(codes({ provider: 'example-cloud', model: 'example-chat', reasoningEffort: 'off', vision: 'auto', priced: false }), ['effort-off', 'no-vision', 'third-party', 'unpriced']);
  assert.match(selectionNotices({ provider: 'example-cloud', model: 'm', vision: 'yes', priced: true })[0].text, /隐私/);

  const media = [{ kind: 'image', file: 'a.jpg' }, { kind: 'sticker', summary: '开心' }, { kind: 'face', faceId: '14' }, null];
  const parts = mediaTextParts(media, 'example-cloud/example-chat');
  assert.deepEqual(parts.map((p) => p.type), ['text', 'text', 'text']);
  assert.match(parts[0].text, /\[图片1：当前模型 example-cloud\/example-chat不能看图，已省略\]/);
  assert.match(parts[1].text, /表情:开心/);
  assert.equal(parts[2].text, '[表情#14]');
  const entries = mediaTextEntries(media);
  assert.ok(entries.every((e) => !('data' in e) && /不能看图/.test(e.text)), '工具条目不带图片数据');
});

function request(port, pathName, method = 'GET', headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathName, method, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch {} resolve({ status: res.statusCode, json }); });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('request hung')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const listenPort = (server) => new Promise((resolve) => { if (server.listening) resolve(server.address().port); else server.once('listening', () => resolve(server.address().port)); });

test('④ 接口：GET 给出目录；POST 校验后写 config.json 并热生效；目录不可用拒绝保存；AI 令牌调不了', async () => {
  const h = await bridgeHarness();
  const selected = [];
  let catalogUp = true;
  h.api.callUnary = async (method) => {
    if (method === 'session.modelCatalog') return catalogUp ? { result: { ok: true, value: CATALOG } } : { result: { ok: false, error: { code: 'gateway/unavailable', message: 'down' } } };
    return { result: { ok: true, value: {} } };
  };
  // 桥接跑在 VM 里，对象原型和测试这边不是同一个，先转成普通对象再比较
  h.api.sessions.selectModel = async (p) => { selected.push(JSON.parse(JSON.stringify(p))); return { result: { ok: true, value: { selected: { provider: p.provider, model: p.model, reasoningEffort: p.reasoningEffort } } } }; };
  const server = h.startConsoleServer();
  const admin = { 'x-console-token': 'fixture-console-token' };
  try {
    const port = await listenPort(server);
    const got = await request(port, '/api/dsh/model', 'GET', admin);
    assert.equal(got.status, 200);
    assert.equal(got.json.catalogSource, 'dsh');
    assert.equal(got.json.provider, 'deepseek-official', '默认值不变');
    assert.equal(got.json.model, 'deepseek-flash');
    assert.deepEqual(got.json.options, ['off', 'low', 'high', 'max'], 'off 不再被过滤');
    assert.equal(got.json.providers.length, 2);
    assert.equal(got.json.canSeeImages, true);
    assert.equal(got.json.globalSideEffect, true);
    assert.deepEqual(got.json.notices, []);

    // 先建一个会话，记下它用的模型
    await h.ensureSession('group:456');
    assert.deepEqual(selected.at(-1), { sessionId: 'fixture-1', provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' });

    const bad = await request(port, '/api/dsh/model', 'POST', admin, { provider: 'example-cloud', model: 'no-such-model' });
    assert.equal(bad.status, 400); assert.match(bad.json.error, /没有 example-cloud\/no-such-model/);
    const badEffort = await request(port, '/api/dsh/model', 'POST', admin, { provider: 'example-cloud', model: 'example-reasoner', reasoningEffort: 'minimal' });
    assert.equal(badEffort.status, 400); assert.match(badEffort.json.error, /只支持思考强度 low \/ high \/ max/);

    const ok = await request(port, '/api/dsh/model', 'POST', admin, { provider: 'example-cloud', model: 'example-chat', reasoningEffort: 'low', vision: 'auto' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.reasoningEffort, '', '无档位模型归一为空');
    assert.equal(ok.json.canSeeImages, false);
    assert.deepEqual(ok.json.notices.map((n) => n.code).sort(), ['no-vision', 'third-party', 'unpriced']);
    const saved = JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8'));
    assert.deepEqual({ p: saved.dsh.provider, m: saved.dsh.model, e: saved.dsh.reasoningEffort, v: saved.dsh.vision },
      { p: 'example-cloud', m: 'example-chat', e: '', v: 'auto' }, 'config.json 落盘');
    assert.equal(saved.dsh.authToken, 'fixture-only', '其它 dsh 字段原样保留');

    // 热生效：已有会话下一次 ensureSession 重新 selectModel，且不带 reasoningEffort
    await h.ensureSession('group:456');
    assert.deepEqual(selected.at(-1), { sessionId: 'fixture-1', provider: 'example-cloud', model: 'example-chat' });

    // 只改档位的旧接口：同样按当前模型的目录校验
    await request(port, '/api/dsh/model', 'POST', admin, { provider: 'example-cloud', model: 'example-reasoner', reasoningEffort: 'high' });
    const oldBad = await request(port, '/api/dsh/effort', 'POST', admin, { reasoningEffort: 'minimal' });
    assert.equal(oldBad.status, 400);
    const keepVision = await request(port, '/api/dsh/model', 'POST', admin, { provider: 'example-cloud', model: 'example-reasoner', reasoningEffort: 'max', vision: 'yes' });
    assert.equal(keepVision.json.vision, 'yes');
    const noVisionField = await request(port, '/api/dsh/model', 'POST', admin, { provider: 'example-cloud', model: 'example-reasoner', reasoningEffort: 'max' });
    assert.equal(noVisionField.json.vision, 'yes', '没传 vision 时保留原设置');

    // 目录不可用：不能校验就不保存
    catalogUp = false;
    const before = fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8');
    const down = await request(port, '/api/dsh/model', 'POST', admin, { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' });
    assert.equal(down.status, 503);
    assert.equal(fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8'), before, '目录不可用时 config.json 不变');
    const fallback = await request(port, '/api/dsh/model?refresh=1', 'GET', admin);
    assert.equal(fallback.json.catalogSource, 'fallback');
    assert.ok(fallback.json.catalogError, '页面要能标注「目录不可用」');
    assert.ok(fallback.json.options.includes('max'), '退化到当前值 + 内置档位');

    // AI 的令牌（MCP 同时带控制台令牌和 agent 令牌）改不了模型
    const asAgent = { ...admin, 'x-agent-token': 'fixture-agent-token' };
    for (const [method, p] of [['GET', '/api/dsh/model'], ['POST', '/api/dsh/model'], ['POST', '/api/dsh/effort']]) {
      const res = await request(port, p, method, asAgent, method === 'POST' ? { provider: 'deepseek-official', model: 'deepseek-flash' } : undefined);
      assert.equal(res.status, 403, `${method} ${p} 必须对 agent token 拒绝`);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
});

test('⑤ 不能看图时：聊天图片、工具图片都降级成文字，不去下载；表情图 / 形象图拒绝返回给 AI', async () => {
  const h = await bridgeHarness({ config: { dsh: { authToken: 'fixture-only', provider: 'example-cloud', model: 'example-chat' } } });
  try {
    const media = [{ kind: 'image', file: 'fixture.jpg', url: 'https://example.invalid/a.jpg' }, { kind: 'face', faceId: '14' }];
    const parts = await h.resolveMediaList(media);
    assert.ok(parts.every((p) => p.type === 'text'), '不带 image 段');
    assert.match(parts[0].text, /不能看图，已省略/);
    const entries = await h.fetchMediaData(media);
    assert.ok(entries.every((e) => !e.data), '工具条目不带 data');
    assert.equal(h.calls.images.length + h.calls.faces.length, 0, '不去下载图片');

    // 手动指定能看图后恢复正常链路（这里只看是否还走降级）
    h.cfg.dsh.vision = 'yes';
    const parts2 = await h.resolveMediaList([{ kind: 'face', faceId: '14' }]);
    assert.ok(!parts2.some((p) => /不能看图/.test(p.text ?? '')), '能看图时不降级');
  } finally {
    await h.close();
  }
  // 源码层：表情图 / 形象图接口在不能看图时对 AI 拒绝
  const src = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  for (const marker of ["url.pathname === '/api/socialV2/sticker-image'", "url.pathname === '/api/socialV2/self-image'"]) {
    const i = src.indexOf(marker);
    const block = src.slice(i, src.indexOf('try {', i));
    assert.match(block, /if \(req\.headers\['x-agent-token'\] && !modelCanSeeImages\(\)\)/, marker);
  }
});
