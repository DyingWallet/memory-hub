// AI 收藏表情的后端适配（纯逻辑 + 受控临时文件），桥接负责接线。
//
// SnowLuma：add_custom_face 接受 `file: base64://…`，回执带 emoji_id；备注用 modify_custom_face。—— 桥接原样保留。
// NapCat（v4.18.38 源码核对，packages/napcat-onebot/action/extends/CustomFace.ts）：
//   · add_custom_face 的 file **必须是本地文件路径**（先 stat 再读文件），base64:// 会报 ENAMETOOLONG；
//   · 回执是 QQ 原生返回值，不含 emoji_id —— 收藏后按 MD5 在 fetch_custom_face_detail 列表里找到它；
//   · 备注用 set_custom_face_desc { emoji_id(emoId), res_id, md5, desc }。
//
// 安全边界不变：交给网关的路径只会是**桥接自己新建**的临时文件（随机名、0600、内容是桥接已校验过的图片字节），
// 调用结束立即删除；消息里的原始 url/file、AI 给的任何路径都不会交给网关。

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** get_version_info 的回执是否来自 NapCat。 */
export function isNapCatVersionInfo(data) {
  const s = [data?.app_name, data?.app_version, data?.protocol_version].map((x) => String(x ?? '')).join(' ');
  return /napcat/i.test(s);
}

/** 本次失败是否是「把 base64:// 当成本地路径」那一类（只在这种情况下才换 NapCat 路径重试）。 */
export function looksLikePathOnlyError(res) {
  const t = String(res?.wording ?? res?.message ?? res?.msg ?? '');
  return /ENAMETOOLONG|ENOENT|no such file|stat\b/i.test(t);
}

/**
 * 临时文件放哪：显式配置 > macOS 上 QQ 的沙盒容器 tmp（NapCat 跑在 QQ 进程里，App Store 版 QQ 有沙盒，
 * 读不到系统临时目录）> 系统临时目录。
 */
export function stickerTempBase({ configured = '', platform = process.platform, home = os.homedir(), exists = fs.existsSync } = {}) {
  if (configured) return path.resolve(String(configured));
  if (platform === 'darwin') {
    const container = path.join(home, 'Library', 'Containers', 'com.tencent.qq', 'Data', 'tmp');
    if (exists(container)) return container;
  }
  return os.tmpdir();
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** 写一个受控临时文件；返回 { file, md5, size, name, cleanup }。cleanup 幂等。 */
export function writeTempSticker(buffer, mimeType, baseDir) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('表情字节为空');
  fs.mkdirSync(baseDir, { recursive: true });
  const dir = fs.mkdtempSync(path.join(baseDir, 'qq-bridge-sticker-'));
  try { fs.chmodSync(dir, 0o700); } catch {}
  const name = `sticker-${crypto.randomBytes(8).toString('hex')}.${EXT[mimeType] ?? 'gif'}`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, buffer, { mode: 0o600, flag: 'wx' });
  const md5 = crypto.createHash('md5').update(buffer).digest('hex');
  let cleaned = false;
  return {
    file,
    md5,
    size: buffer.length,
    name,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

/** 在 fetch_custom_face_detail 的原始列表里按 MD5 找刚收藏的表情（大小写不敏感）。 */
export function findFavByMd5(list, md5) {
  const want = String(md5 ?? '').toLowerCase();
  if (!want || !Array.isArray(list)) return null;
  return list.find((x) => String(x?.md5 ?? '').toLowerCase() === want) ?? null;
}

/** NapCat 的 add_custom_face 是否成功：OneBot 层 ok，且原生返回值里没有明确的失败码。 */
export function napcatAddOk(res) {
  if (!res || res.status !== 'ok' || Number(res.retcode) !== 0) return false;
  const r = res.data?.result;
  return r === undefined || r === null || Number(r) === 0;
}
