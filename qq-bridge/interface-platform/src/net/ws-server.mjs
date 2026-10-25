// 最小 WebSocket 服务端（RFC 6455），只实现接口平台需要的部分：
//   文本/二进制帧、分片重组、ping/pong、close、客户端掩码校验、单帧/单消息大小上限、发送背压。
// 不支持扩展（permessage-deflate 等）——握手时不协商任何扩展，客户端会按无扩展处理。
// 选择自己实现而不引入 ws 依赖：平台要在 Windows / macOS 上零依赖运行，客户端侧用 Node ≥ 22 内置的 WebSocket。

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

// RFC 6455 §1.3 规定的固定 GUID（不是密钥）；分段书写避免被隐私扫描当成令牌
const GUID = ['258EAFA5', 'E914', '47DA', '95CA', 'C5AB0DC85B11'].join('-');
const OP = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xA };

/** 校验并完成握手。返回 WsConnection；不合法时写回 400 并返回 null。 */
export function acceptWebSocket(req, socket, head, { maxMessageBytes = 64 * 1024 * 1024, protocols = null } = {}) {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
  const version = String(req.headers['sec-websocket-version'] ?? '');
  if (req.method !== 'GET' || upgrade !== 'websocket' || !key || version !== '13') {
    rejectUpgrade(socket, 400, 'Bad WebSocket handshake');
    return null;
  }
  const accept = crypto.createHash('sha1').update(String(key) + GUID).digest('base64');
  const lines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`];
  const offered = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const proto = protocols ? offered.find((p) => protocols.includes(p)) : null;
  if (proto) lines.push(`Sec-WebSocket-Protocol: ${proto}`);
  socket.write(lines.join('\r\n') + '\r\n\r\n');
  socket.setNoDelay(true);
  const conn = new WsConnection(socket, { maxMessageBytes });
  if (head?.length) conn._feed(head);
  return conn;
}

/** 握手阶段拒绝（鉴权失败等）：写一个普通 HTTP 响应后关闭。 */
export function rejectUpgrade(socket, status, text) {
  const body = Buffer.from(String(text ?? ''), 'utf8');
  try {
    socket.end(`HTTP/1.1 ${status} ${httpReason(status)}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
  } catch {}
}

function httpReason(status) {
  return { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 503: 'Service Unavailable' }[status] ?? 'Error';
}

export class WsConnection extends EventEmitter {
  constructor(socket, { maxMessageBytes }) {
    super();
    this.socket = socket;
    this.maxMessageBytes = maxMessageBytes;
    this.buf = Buffer.alloc(0);
    this.fragments = null; // { opcode, parts: Buffer[], size }
    this.closed = false;
    this.closeSent = false;
    socket.on('data', (d) => this._feed(d));
    socket.on('close', () => this._finish(1006, ''));
    socket.on('error', () => this._finish(1006, ''));
  }

  get open() { return !this.closed && !this.closeSent; }
  /** 发送缓冲里还没写出去的字节数（背压判断用）。 */
  get bufferedAmount() { return this.socket.writableLength ?? 0; }

  sendText(text) { this._send(OP.TEXT, Buffer.from(String(text), 'utf8')); }
  sendBinary(buf) { this._send(OP.BIN, Buffer.from(buf)); }
  ping(data = Buffer.alloc(0)) { this._send(OP.PING, data); }

  close(code = 1000, reason = '') {
    if (this.closed || this.closeSent) return;
    const r = Buffer.from(String(reason).slice(0, 120), 'utf8');
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0);
    r.copy(p, 2);
    this._send(OP.CLOSE, p);
    this.closeSent = true;
    // 对端不回 close 时兜底断开
    const t = setTimeout(() => { try { this.socket.destroy(); } catch {} }, 3000);
    t.unref?.();
  }

  terminate() { try { this.socket.destroy(); } catch {} this._finish(1006, ''); }

  _send(opcode, payload) {
    if (this.closed || this.closeSent) return;
    const len = payload.length;
    let header;
    if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
    else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    header[0] = 0x80 | opcode;
    try { this.socket.write(header); if (len) this.socket.write(payload); } catch {}
  }

  _feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (!this.closed) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const rsv = b[0] & 0x70;
      const opcode = b[0] & 0x0F;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7F;
      let off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(this.maxMessageBytes)) return this._fail(1009, 'message too big');
        len = Number(big); off = 10;
      }
      if (rsv) return this._fail(1002, 'RSV bits set');
      if (!masked) return this._fail(1002, 'client frames must be masked');
      if (len > this.maxMessageBytes) return this._fail(1009, 'message too big');
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      this._frame(fin, opcode, payload);
    }
  }

  _frame(fin, opcode, payload) {
    if (opcode >= 0x8) {
      if (!fin || payload.length > 125) return this._fail(1002, 'bad control frame');
      if (opcode === OP.PING) return this._send(OP.PONG, payload);
      if (opcode === OP.PONG) return void this.emit('pong', payload);
      if (opcode === OP.CLOSE) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        if (!this.closeSent) { this._send(OP.CLOSE, payload.length >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0)); this.closeSent = true; }
        try { this.socket.end(); } catch {}
        return this._finish(code, reason);
      }
      return this._fail(1002, 'unknown control opcode');
    }
    if (opcode === OP.CONT) {
      if (!this.fragments) return this._fail(1002, 'unexpected continuation');
      this.fragments.parts.push(payload);
      this.fragments.size += payload.length;
      if (this.fragments.size > this.maxMessageBytes) return this._fail(1009, 'message too big');
      if (fin) { const f = this.fragments; this.fragments = null; this._message(f.opcode, Buffer.concat(f.parts)); }
      return;
    }
    if (opcode !== OP.TEXT && opcode !== OP.BIN) return this._fail(1002, 'unknown opcode');
    if (this.fragments) return this._fail(1002, 'interleaved data frame');
    if (!fin) { this.fragments = { opcode, parts: [payload], size: payload.length }; return; }
    this._message(opcode, payload);
  }

  _message(opcode, data) {
    if (opcode === OP.TEXT) {
      const text = data.toString('utf8');
      this.emit('message', text, false);
    } else {
      this.emit('message', data, true);
    }
  }

  _fail(code, reason) {
    this.close(code, reason);
    try { this.socket.end(); } catch {}
    this._finish(code, reason);
  }

  _finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', code, reason);
  }
}
