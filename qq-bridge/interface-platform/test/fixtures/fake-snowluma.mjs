// 假 OneBot v11 后端：正向 WebSocket，按 echo 回执动作，可主动推事件。
// authStyle='snowluma'：令牌错误时握手直接 401；authStyle='napcat'：先接受连接、回 retcode 1403 再断开（同 NapCat v4.18.38）。
// 只用于离线测试，所有 QQ 号/群号都是假数据。

import http from 'node:http';
import { acceptWebSocket, rejectUpgrade } from '../../src/net/ws-server.mjs';

export async function createFakeSnowLuma({ token = 'fake-ws-token', selfId = 10001, nickname = '测试机器人', authStyle = 'snowluma' } = {}) {
  const conns = new Set();
  const actions = [];
  let responder = defaultResponder;
  let silent = false;

  function defaultResponder(frame) {
    switch (frame.action) {
      case 'get_login_info': return { status: 'ok', retcode: 0, data: { user_id: selfId, nickname } };
      case 'get_status': return { status: 'ok', retcode: 0, data: { online: true, good: true } };
      case 'get_version_info': return { status: 'ok', retcode: 0, data: authStyle === 'napcat' ? { app_name: 'NapCat.Onebot', app_version: '4.0.0-test', protocol_version: 'v11' } : { app_name: 'SnowLuma', app_version: '1.0.0-test', protocol_version: 'v11' } };
      case 'send_group_msg':
      case 'send_private_msg':
      case 'send_msg': return { status: 'ok', retcode: 0, data: { message_id: 900000 + actions.length } };
      default: return { status: 'failed', retcode: 1404, data: null, wording: `不支持的动作 ${frame.action}` };
    }
  }

  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    const got = url.searchParams.get('access_token') || String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (token && got !== token && authStyle !== 'napcat') return rejectUpgrade(socket, 401, 'bad token');
    const c = acceptWebSocket(req, socket, head);
    if (!c) return;
    if (token && got !== token) {
      c.sendText(JSON.stringify({ status: 'failed', retcode: 1403, data: null, message: 'token验证失败', wording: 'token验证失败', echo: null }));
      c.close(1000, '');
      return;
    }
    conns.add(c);
    c.on('close', () => conns.delete(c));
    c.on('message', (text) => {
      const frame = JSON.parse(text);
      actions.push(frame);
      if (silent) return;
      const r = responder(frame);
      if (r === null) return; // 不回执：模拟后端吞掉请求
      c.sendText(JSON.stringify({ ...r, echo: frame.echo }));
    });
    // SnowLuma 连接后会发 lifecycle
    c.sendText(JSON.stringify({ time: Math.floor(Date.now() / 1000), self_id: selfId, post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  return {
    port,
    url: `ws://127.0.0.1:${port}`,
    token,
    selfId,
    actions,
    get connections() { return conns.size; },
    /** 推一条原始事件文本（可以是含大整数的手写 JSON）。 */
    pushRaw(text) { for (const c of conns) c.sendText(text); },
    push(ev) { this.pushRaw(JSON.stringify({ time: Math.floor(Date.now() / 1000), self_id: selfId, ...ev })); },
    heartbeat(status = { online: true, good: true }) { this.push({ post_type: 'meta_event', meta_event_type: 'heartbeat', status, interval: 30000 }); },
    setResponder(fn) { responder = fn ?? defaultResponder; },
    setSilent(v) { silent = !!v; },
    dropAll() { for (const c of conns) c.terminate(); },
    async close() {
      for (const c of conns) c.terminate();
      await new Promise((r) => server.close(r));
    },
  };
}
