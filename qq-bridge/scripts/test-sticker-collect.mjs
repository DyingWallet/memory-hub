// AI 收藏表情的后端适配离线测试：SnowLuma 行为不变；NapCat（add_custom_face 只收本地路径）走受控临时文件。全部假数据。
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isNapCatVersionInfo, looksLikePathOnlyError, stickerTempBase, writeTempSticker, findFavByMd5, napcatAddOk } from '../src/social/sticker-collect.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

// 最小合法 GIF（1x1）
const GIF = Buffer.from('47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b', 'hex');
const GIF_MD5 = crypto.createHash('md5').update(GIF).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sticker-collect-'));

test('识别 NapCat、识别「base64 被当成路径」类错误、判断 NapCat 原生回执', () => {
  assert.equal(isNapCatVersionInfo({ app_name: 'NapCat.Onebot', app_version: '4.18.38' }), true);
  assert.equal(isNapCatVersionInfo({ app_name: 'SnowLuma', app_version: '1.14.22' }), false);
  assert.equal(isNapCatVersionInfo(null), false);
  assert.equal(looksLikePathOnlyError({ wording: "ENAMETOOLONG: name too long, stat 'base64:///9j/…'" }), true);
  assert.equal(looksLikePathOnlyError({ message: 'ENOENT: no such file or directory' }), true);
  assert.equal(looksLikePathOnlyError({ wording: '被禁言' }), false);
  assert.equal(napcatAddOk({ status: 'ok', retcode: 0, data: { result: 0, errMsg: '' } }), true);
  assert.equal(napcatAddOk({ status: 'ok', retcode: 0, data: null }), true);
  assert.equal(napcatAddOk({ status: 'ok', retcode: 0, data: { result: 2, errMsg: 'fail' } }), false);
  assert.equal(napcatAddOk({ status: 'failed', retcode: 100 }), false);
});

test('临时目录：显式配置优先；macOS 用 QQ 沙盒容器 tmp（存在时）；否则系统临时目录', () => {
  assert.equal(stickerTempBase({ configured: '/x/y' }), path.resolve('/x/y'));
  const home = tmp();
  const container = path.join(home, 'Library', 'Containers', 'com.tencent.qq', 'Data', 'tmp');
  assert.equal(stickerTempBase({ platform: 'darwin', home }), os.tmpdir(), '容器不存在时用系统临时目录');
  fs.mkdirSync(container, { recursive: true });
  assert.equal(stickerTempBase({ platform: 'darwin', home }), container);
  assert.equal(stickerTempBase({ platform: 'win32', home }), os.tmpdir());
});

test('受控临时文件：随机名、0600、MD5 正确、cleanup 删除整个目录且幂等', () => {
  const base = tmp();
  const t = writeTempSticker(GIF, 'image/gif', base);
  assert.ok(t.file.startsWith(base + path.sep));
  assert.match(path.basename(t.file), /^sticker-[0-9a-f]{16}\.gif$/);
  assert.equal(t.md5, GIF_MD5);
  assert.deepEqual(fs.readFileSync(t.file), GIF);
  if (process.platform !== 'win32') assert.equal(fs.statSync(t.file).mode & 0o777, 0o600);
  t.cleanup(); t.cleanup();
  assert.equal(fs.existsSync(path.dirname(t.file)), false);
  assert.throws(() => writeTempSticker(Buffer.alloc(0), 'image/gif', base), /为空/);
});

test('按 MD5 找刚收藏的表情（大小写不敏感）', () => {
  const list = [{ emoId: 1, resId: 'a', md5: 'AAA' }, { emoId: 2, resId: 'b', md5: GIF_MD5.toUpperCase() }];
  assert.equal(findFavByMd5(list, GIF_MD5).emoId, 2);
  assert.equal(findFavByMd5(list, 'zzz'), null);
  assert.equal(findFavByMd5(null, GIF_MD5), null);
});

// ── 集成：真实 bridge.js 夹具，模拟两种网关 ──────────────────────────────────

const KEY = 'group:456';
async function withHarness(botRequest, run, { tempDir } = {}) {
  const h = await bridgeHarness({
    botRequest,
    config: { socialV2: { sticker: { collect: { tempDir: tempDir ?? '' } } } },
    globals: { safeFetchBuffer: async () => ({ buffer: GIF }) },
  });
  try {
    await h.initControllerOnce('reserved2');
    h.setMode('reserved2');
    h.appendSocialV2Message(KEY, '甲', '[表情]', '[表情]', false, false, '777', [{ kind: 'image', url: 'https://public.invalid/a.gif' }], '20001');
    await run(h);
  } finally {
    h.ext.controller.stop();
    await h.close();
  }
}

test('SnowLuma：base64:// 一次成功，用回执里的 emoji_id、modify_custom_face 写备注；不探测版本、不写临时文件', async () => {
  await withHarness((action) => {
    if (action === 'add_custom_face') return { status: 'ok', retcode: 0, data: { emoji_id: 'snow-1' } };
    if (action === 'modify_custom_face') return { status: 'ok', retcode: 0, data: null };
    if (action === 'fetch_custom_face_detail') return { status: 'ok', retcode: 0, data: [{ emoji_id: 'snow-1', url: 'https://public.invalid/s.gif' }] };
    return { status: 'ok', retcode: 0, data: null };
  }, async (h) => {
    const r = await h.collectStickerV2(KEY, '777', '好图');
    assert.equal(r.emojiId, 'snow-1');
    const acts = h.calls.requests.map((x) => x.action);
    assert.ok(acts.includes('modify_custom_face'));
    assert.ok(!acts.includes('get_version_info'), 'SnowLuma 成功时不探测后端');
    const add = h.calls.requests.find((x) => x.action === 'add_custom_face');
    assert.match(add.params.file, /^base64:\/\//, 'SnowLuma 仍按 base64:// 交字节');
    assert.ok(!JSON.stringify(h.calls.requests).includes('public.invalid/a.gif'), '消息里的原始 URL 不交给网关');
  });
});

test('NapCat：base64 被拒后改用桥接自建的临时文件；按 MD5 找到表情；set_custom_face_desc 写备注；临时文件用完即删', async () => {
  const base = tmp();
  let seenFile = null;
  await withHarness((action, params) => {
    if (action === 'add_custom_face' && String(params.file).startsWith('base64://')) {
      return { status: 'failed', retcode: 200, data: null, wording: "ENAMETOOLONG: name too long, stat 'base64:///9j'" };
    }
    if (action === 'get_version_info') return { status: 'ok', retcode: 0, data: { app_name: 'NapCat.Onebot', app_version: '4.18.38' } };
    if (action === 'add_custom_face') {
      seenFile = params.file;
      assert.deepEqual(fs.readFileSync(params.file), GIF, '交给 NapCat 的是桥接已校验的字节');
      assert.equal(params.md5, GIF_MD5);
      return { status: 'ok', retcode: 0, data: { result: 0, errMsg: '' } };
    }
    if (action === 'fetch_custom_face_detail') return { status: 'ok', retcode: 0, data: [{ emoId: 42, resId: '10001_0_0_0_ABC_0_0', md5: GIF_MD5.toUpperCase(), url: 'https://public.invalid/n.gif', desc: '' }] };
    if (action === 'set_custom_face_desc') return { status: 'ok', retcode: 0, data: null };
    return { status: 'ok', retcode: 0, data: null };
  }, async (h) => {
    const r = await h.collectStickerV2(KEY, '777', '好图');
    assert.equal(r.emojiId, '10001_0_0_0_ABC_0_0');
    assert.ok(seenFile && seenFile.startsWith(base + path.sep), '临时文件在配置的目录里');
    assert.equal(fs.existsSync(seenFile), false, '用完即删');
    const desc = h.calls.requests.find((x) => x.action === 'set_custom_face_desc');
    // 夹具里的对象来自另一个 VM 上下文（原型不同），按 JSON 比较内容
    assert.deepEqual(JSON.parse(JSON.stringify(desc.params)), { emoji_id: 42, res_id: '10001_0_0_0_ABC_0_0', md5: GIF_MD5.toUpperCase(), desc: '好图' });
    assert.ok(!h.calls.requests.some((x) => x.action === 'modify_custom_face'), 'NapCat 不调 SnowLuma 的 modify_custom_face');
  }, { tempDir: base });
});

test('不是 NapCat 时不改走本地路径：原样报错，也不写临时文件', async () => {
  const base = tmp();
  await withHarness((action) => {
    if (action === 'add_custom_face') return { status: 'failed', retcode: 200, data: null, wording: 'ENOENT: no such file' };
    if (action === 'get_version_info') return { status: 'ok', retcode: 0, data: { app_name: 'OtherBot' } };
    return { status: 'ok', retcode: 0, data: null };
  }, async (h) => {
    await assert.rejects(h.collectStickerV2(KEY, '777', ''), /add_custom_face 失败/);
    assert.equal(h.calls.requests.filter((x) => x.action === 'add_custom_face').length, 1, '只试一次');
    assert.deepEqual(fs.readdirSync(base), [], '没有写临时文件');
  }, { tempDir: base });
});

test('NapCat 收藏失败或找不到表情时报错，且临时文件同样被删除', async () => {
  const base = tmp();
  await withHarness((action, params) => {
    if (action === 'add_custom_face' && String(params.file).startsWith('base64://')) return { status: 'failed', retcode: 200, wording: 'ENAMETOOLONG' };
    if (action === 'get_version_info') return { status: 'ok', retcode: 0, data: { app_name: 'NapCat.Onebot' } };
    if (action === 'add_custom_face') return { status: 'ok', retcode: 0, data: { result: 0 } };
    if (action === 'fetch_custom_face_detail') return { status: 'ok', retcode: 0, data: [] };
    return { status: 'ok', retcode: 0, data: null };
  }, async (h) => {
    await assert.rejects(h.collectStickerV2(KEY, '777', ''), /还没找到/);
    assert.deepEqual(fs.readdirSync(base), [], '失败路径也清理临时文件');
  }, { tempDir: base });
});
