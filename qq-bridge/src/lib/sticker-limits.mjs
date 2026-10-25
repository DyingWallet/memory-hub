// 表情（收藏 / 发送）的单张大小上限：socialV2.sticker.maxBytes。
//
// 和图片识别的上限（bridge.js 的 MAX_MEDIA_BYTES，来自上游 r4 的 socialV2.media.maxBytes，默认 8MB；图片要交给模型）分开：
// 表情只在 QQ 之间搬运，桥接下载校验后以 base64 交给网关，不进模型，所以可以放宽。
//
// 取值范围：256KB ～ 40MB。上界留给传输：base64 会膨胀约 1/3，40MB 编码后约 54MB，
// 仍在接口平台单条消息 64MB 的上限内。非法值（非数字、≤0）一律回到默认 10MB。

export const DEFAULT_STICKER_MAX_BYTES = 10 * 1024 * 1024;
export const MIN_STICKER_MAX_BYTES = 256 * 1024;
export const MAX_STICKER_MAX_BYTES = 40 * 1024 * 1024;

export function stickerMaxBytes(cfg) {
  const n = Number(cfg?.socialV2?.sticker?.maxBytes);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_STICKER_MAX_BYTES;
  return Math.min(MAX_STICKER_MAX_BYTES, Math.max(MIN_STICKER_MAX_BYTES, Math.floor(n)));
}
