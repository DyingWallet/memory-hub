// /api/send/image 的处理逻辑（未接入 bridge.js，接入时只调 createSendImageHandler）
//
// 只做三件事：校验路径在白名单内、校验会话、把文件交给调用方发出去。
// 发消息的具体实现由桥接注入（sendGroupImage / sendPrivateImage），
// 这样这里不需要知道 OneBot 细节。
import { readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

export function isPathInside(root, target) {
  const r = resolve(root);
  const t = resolve(target);
  return t === r || t.startsWith(r + sep);
}

export function createSendImageHandler({
  allowRoot = 'D:\\deepseek_workspace\\outputs\\qq',
  sendGroupImage,
  sendPrivateImage,
  guardKey, // (key) => boolean，复用桥接的白名单校验
  log = () => {},
} = {}) {
  return async function handleSendImage({ key, path }) {
    if (!key || !path) return { ok: false, code: 'bad_args' };

    const abs = resolve(path);
    if (!isPathInside(allowRoot, abs)) return { ok: false, code: 'path_not_allowed' };

    const ext = abs.slice(abs.lastIndexOf('.')).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) return { ok: false, code: 'bad_ext' };

    let size;
    try {
      size = statSync(abs).size;
    } catch {
      return { ok: false, code: 'not_found' };
    }
    if (size > MAX_BYTES) return { ok: false, code: 'too_large', size };

    if (typeof guardKey === 'function' && !guardKey(key)) return { ok: false, code: 'key_not_allowed' };

    const base64 = readFileSync(abs).toString('base64');
    const [kind, id] = String(key).split(':');
    const payload = { base64, filename: abs.split(sep).pop(), size };

    try {
      if (kind === 'group') {
        if (typeof sendGroupImage !== 'function') return { ok: false, code: 'no_sender' };
        await sendGroupImage(id, payload);
      } else if (kind === 'private') {
        if (typeof sendPrivateImage !== 'function') return { ok: false, code: 'no_sender' };
        await sendPrivateImage(id, payload);
      } else {
        return { ok: false, code: 'bad_key' };
      }
    } catch (e) {
      log('send_image_failed', { key, error: e?.message ?? String(e) });
      return { ok: false, code: 'send_failed', error: e?.message ?? String(e) };
    }

    log('send_image_ok', { key, size, file: abs });
    return { ok: true, key, size };
  };
}
