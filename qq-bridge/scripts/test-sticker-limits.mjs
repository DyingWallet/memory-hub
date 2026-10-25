// 表情大小上限（socialV2.sticker.maxBytes）离线测试：取值与边界、收藏/发送用它；
// 图片识别用上游 r4 的 socialV2.media.maxBytes（默认 8MB），两者互不影响。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stickerMaxBytes, DEFAULT_STICKER_MAX_BYTES, MIN_STICKER_MAX_BYTES, MAX_STICKER_MAX_BYTES } from '../src/lib/sticker-limits.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MB = 1024 * 1024;
const cfgWith = (v) => ({ socialV2: { sticker: { maxBytes: v } } });

test('默认 10MB；缺配置、非数字、≤0 都回到默认', () => {
  assert.equal(DEFAULT_STICKER_MAX_BYTES, 10 * MB);
  for (const c of [undefined, {}, { socialV2: {} }, cfgWith(undefined), cfgWith('abc'), cfgWith(0), cfgWith(-5), cfgWith(NaN)]) {
    assert.equal(stickerMaxBytes(c), 10 * MB);
  }
});

test('合法值原样使用；越界按 256KB / 40MB 截断；小数取整（safeFetchBuffer 要求整数）', () => {
  assert.equal(stickerMaxBytes(cfgWith(20 * MB)), 20 * MB);
  assert.equal(stickerMaxBytes(cfgWith(String(15 * MB))), 15 * MB, '字符串数字也接受');
  assert.equal(stickerMaxBytes(cfgWith(1)), MIN_STICKER_MAX_BYTES);
  assert.equal(stickerMaxBytes(cfgWith(999 * MB)), MAX_STICKER_MAX_BYTES);
  assert.ok(Number.isSafeInteger(stickerMaxBytes(cfgWith(5.7 * MB))));
  // base64 膨胀后仍在接口平台 64MB 单条消息上限内
  assert.ok(MAX_STICKER_MAX_BYTES * 4 / 3 < 64 * MB);
});

test('桥接接线：发送与收藏表情用表情上限；图片识别与 qq_get_sticker_image 用 socialV2.media 上限', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8');
  assert.match(src, /const MAX_MEDIA_BYTES = maxMediaBytesLimit;/, '图片识别上限来自 socialV2.media.maxBytes（r4）');
  assert.match(src, /cfg\.socialV2\?\.media\?\.maxBytes[\s\S]{0,200}: 8 \* 1024 \* 1024/, '图片识别默认 8MB（r4）');
  assert.match(src, /image = await safeFetchBuffer\(url, stickerMaxBytes\(cfg\)\);/, '发送收藏表情用表情上限');
  assert.match(src, /fetchOneBotImage\(media, \{ maxBytes: stickerMaxBytes\(cfg\) \}\)/, '收藏图片表情用表情上限');
  assert.match(src, /fetchFaceMedia\(media, \{ maxBytes: stickerMaxBytes\(cfg\) \}\)/, '收藏 QQ 表情用表情上限');
  assert.match(src, /async function fetchOneBotImage\(media, \{ maxBytes = MAX_MEDIA_BYTES \} = \{\}\)/, '默认仍是图片识别上限');
  assert.match(src, /async function fetchFaceMedia\(media, \{ maxBytes = MAX_MEDIA_BYTES \} = \{\}\)/);
  // 图片识别路径（resolveMediaList）不传 maxBytes，按 socialV2.media 上限
  const resolve = src.slice(src.indexOf('async function resolveMediaList('), src.indexOf('async function resolveMediaList(') + 6000);
  assert.ok(!/maxBytes: stickerMaxBytes/.test(resolve), '图片识别路径不得使用表情上限');
  assert.match(src, /safeFetchBuffer\(entry\.url, MAX_MEDIA_BYTES\)/, 'qq_get_sticker_image（给模型看图）用图片识别上限');
  // 表情仍以桥接校验过的字节交给网关，不把 URL 交给网关重新抓取
  assert.match(src, /segments\.push\(\{ type: 'image', data: \{ file: 'base64:\/\/' \+ image\.buffer\.toString\('base64'\) \} \}\);/);
});

test('示例配置、桥接内置默认值与模块默认值一致', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8');
  assert.equal((src.match(/maxBytes: 10 \* 1024 \* 1024,/g) ?? []).length, 2, 'bridge.js 的两处表情默认值都是 10MB');
  const ex = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf8'));
  assert.equal(ex.socialV2.sticker.maxBytes, DEFAULT_STICKER_MAX_BYTES);
  assert.equal(stickerMaxBytes(ex), DEFAULT_STICKER_MAX_BYTES);
});
