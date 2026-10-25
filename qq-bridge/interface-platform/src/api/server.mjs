// 接口平台的 HTTP / WebSocket 入口：
//   /v1/*            数据接口（Bearer 数据令牌）
//   /v1/admin/*      管理接口（x-platform-admin-token 管理令牌）
//   /onebot/v11/*    OneBot v11 兼容入口（过渡层，数据令牌；WS 与 HTTP 共用一个令牌）
//   /v1/health       无需令牌，只回版本与存活（给控制中心探测外部运行的平台）
//
// 只接受配置的监听主机（默认 127.0.0.1）对应的 Host 头，防 DNS 重绑定；不发任何 CORS 头。

import http from 'node:http';
import { acceptWebSocket, rejectUpgrade } from '../net/ws-server.mjs';
import { tokenEq } from '../core/config.mjs';
import { PlatformError, ERR, safeJsonParse } from '../core/model.mjs';
import { PLATFORM_VERSION } from '../core/platform.mjs';

const SEC = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
const SSE_MAX_BUFFER = 8 * 1024 * 1024;
const WS_MAX_BUFFER = 16 * 1024 * 1024;

const RETCODE = { bad_request: 1400, unauthorized: 1401, bridge_disabled: 1403, not_found: 1404, capability_unsupported: 1404, instance_unavailable: 1503, account_not_ready: 1503, queue_full: 1429 };

function oneBotError(err) {
  const pe = err instanceof PlatformError ? err : null;
  const msg = pe ? pe.message : String(err?.message ?? err);
  const retcode = pe ? (RETCODE[pe.code] ?? 1500) : (err?.outcome === 'unknown' ? 1504 : 1500);
  return { status: 'failed', retcode, data: null, message: `接口平台：${msg}`, wording: `接口平台：${msg}` };
}

function bearer(req) {
  const h = String(req.headers.authorization ?? '');
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : '';
}

export function createServer(platform, { onShutdown = null } = {}) {
  const { cfg, tokens } = platform;
  const log = platform.log;
  const clog = log.child('compat', {});
  let boundPort = cfg.port;

  const allowedHosts = () => {
    const hosts = new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`]);
    if (cfg.host && !['127.0.0.1', '0.0.0.0', '::'].includes(cfg.host)) hosts.add(`${cfg.host}:${boundPort}`);
    return hosts;
  };
  const hostOk = (req) => allowedHosts().has(String(req.headers.host ?? '').toLowerCase());

  async function readBody(req, limit) {
    const chunks = [];
    let n = 0;
    for await (const c of req) {
      n += c.length;
      if (n > limit) throw Object.assign(ERR.badRequest('请求体过大'), { status: 413 });
      chunks.push(c);
    }
    const t = Buffer.concat(chunks).toString('utf8');
    if (!t.trim()) return {};
    let v;
    try { v = safeJsonParse(t); } catch { throw ERR.badRequest('请求体不是合法 JSON'); }
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw ERR.badRequest('请求体必须是 JSON 对象');
    return v;
  }

  function send(res, status, obj) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SEC });
    res.end(JSON.stringify(obj));
  }
  function sendError(res, err) {
    const pe = err instanceof PlatformError ? err : new PlatformError('internal', String(err?.message ?? err), { status: err?.status ?? 500 });
    send(res, pe.status ?? 500, { ok: false, error: pe.toJSON() });
  }

  const dataAuthed = (req, url) => tokenEq(bearer(req) || url.searchParams.get('access_token') || '', tokens.data);
  const adminAuthed = (req) => tokenEq(req.headers['x-platform-admin-token'], tokens.admin) || (!!tokens.adminExtra && tokenEq(req.headers['x-platform-admin-token'], tokens.adminExtra));

  // ── OneBot 兼容入口 ─────────────────────────────────────────────────────────
  // 路径：/onebot/v11[/@<账号>][/<动作>|/ws]
  function parseCompatPath(pathname) {
    const m = /^\/onebot\/v11(?:\/@([a-z][a-z0-9-]*:[^/]+))?(?:\/([A-Za-z0-9_.]+))?\/?$/.exec(pathname);
    if (!m) return null;
    return { account: m[1] ? decodeURIComponent(m[1]) : null, action: m[2] ?? null };
  }

  async function handleCompatHttp(req, res, url, p) {
    if (!cfg.compat.onebot.enabled) return send(res, 404, { status: 'failed', retcode: 1404, data: null, message: 'OneBot 兼容入口已关闭' });
    if (!dataAuthed(req, url)) return send(res, 401, { status: 'failed', retcode: 1401, data: null, message: '接口平台：令牌无效' });
    if (!p.action || p.action === 'ws') return send(res, 404, { status: 'failed', retcode: 1404, data: null, message: '缺少动作名' });
    let params = {};
    if (req.method === 'POST') {
      try { params = await readBody(req, cfg.limits.maxMessageBytes); } catch (e) { return send(res, e.status === 413 ? 413 : 400, oneBotError(e)); }
    } else if (req.method === 'GET') {
      for (const [k, v] of url.searchParams) if (k !== 'access_token') params[k] = v;
    } else {
      return send(res, 405, { status: 'failed', retcode: 1405, data: null, message: '只支持 GET / POST' });
    }
    const target = platform.resolveCompatAccount(p.account);
    if (!target.account) return send(res, 200, oneBotError(ERR.instanceUnavailable('?', target.reason)));
    try {
      const r = await platform.callOneBot(target.account, p.action, params);
      send(res, 200, r);
    } catch (e) {
      send(res, 200, oneBotError(e));
    }
  }

  function handleCompatWs(req, socket, head, url, p) {
    if (!cfg.compat.onebot.enabled) return rejectUpgrade(socket, 404, 'OneBot 兼容入口已关闭');
    if (!dataAuthed(req, url)) return rejectUpgrade(socket, 401, '接口平台：令牌无效');
    const conn = acceptWebSocket(req, socket, head, { maxMessageBytes: cfg.limits.maxMessageBytes });
    if (!conn) return;
    const client = {
      account: p.account,
      send(text) {
        if (!conn.open) return;
        if (conn.bufferedAmount > WS_MAX_BUFFER) {
          clog.warn('兼容客户端积压过多，断开让它重连（期间的事件会丢失）', { account: p.account ?? undefined });
          conn.close(1013, 'backpressure');
          return;
        }
        conn.sendText(text);
      },
      close() { conn.close(1001, 'platform-stopping'); },
    };
    platform.compatClients.add(client);
    const resolved = platform.resolveCompatAccount(p.account);
    clog.info(`OneBot 兼容客户端已连接（目标 ${resolved.account ?? `未确定：${resolved.reason}`}）`, { account: resolved.account ?? undefined });
    const ping = setInterval(() => conn.ping(), 30_000);
    ping.unref?.();
    conn.on('message', async (data, isBinary) => {
      if (isBinary) return;
      let frame;
      try { frame = safeJsonParse(data); } catch { return conn.sendText(JSON.stringify({ ...oneBotError(ERR.badRequest('不是合法 JSON')), echo: null })); }
      const echo = frame?.echo ?? null;
      const target = platform.resolveCompatAccount(p.account);
      let reply;
      try {
        if (!target.account) throw ERR.instanceUnavailable('?', target.reason);
        reply = await platform.callOneBot(target.account, String(frame?.action ?? ''), frame?.params ?? {});
      } catch (e) {
        reply = oneBotError(e);
      }
      if (conn.open) conn.sendText(JSON.stringify(echo === null ? reply : { ...reply, echo }));
    });
    conn.on('close', () => {
      clearInterval(ping);
      platform.compatClients.delete(client);
      clog.info('OneBot 兼容客户端已断开');
    });
  }

  // ── /v1 数据接口 ────────────────────────────────────────────────────────────

  function handleEvents(req, res, url) {
    const account = url.searchParams.get('account') || null;
    const after = url.searchParams.get('after') || req.headers['last-event-id'] || null;
    const filter = (e) => (!account || e.account === account) && (!e.account || platform.bridgeEnabled(e.account));
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', ...SEC });
    res.flushHeaders?.();
    const client = { account };
    platform.sseClients.add(client);
    let ended = false;
    const write = (e) => {
      if (ended) return;
      if (res.writableLength > SSE_MAX_BUFFER) {
        res.write(`event: overflow\ndata: {"reason":"消费过慢，请带 Last-Event-ID 重连"}\n\n`);
        return end();
      }
      const { seq, ...pub } = e;
      res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(pub)}\n\n`);
    };
    if (after) {
      const r = platform.bus.since(after, filter);
      if (r.expired) res.write(`event: cursor_expired\ndata: ${JSON.stringify({ after, oldestAvailable: r.events[0]?.id ?? null })}\n\n`);
      for (const e of r.events) write(e);
    }
    const sub = platform.bus.subscribe(write, { filter });
    const hb = setInterval(() => { if (!ended) res.write(': hb\n\n'); }, 15_000);
    hb.unref?.();
    function end() {
      if (ended) return;
      ended = true;
      clearInterval(hb);
      sub.unsubscribe();
      platform.sseClients.delete(client);
      try { res.end(); } catch {}
    }
    req.on('close', end);
    res.on('close', end);
  }

  async function routeV1(req, res, url) {
    const p = url.pathname;
    if (p === '/v1/health' && req.method === 'GET') return send(res, 200, { ok: true, service: 'interface-platform', version: PLATFORM_VERSION });

    if (p.startsWith('/v1/admin/')) {
      if (!adminAuthed(req)) throw ERR.unauthorized('需要管理令牌');
      if (req.method === 'POST' && !String(req.headers['content-type'] ?? '').includes('application/json')) throw Object.assign(ERR.badRequest('请求必须是 application/json'), { status: 415 });
      const body = req.method === 'POST' ? await readBody(req, 1024 * 1024) : {};
      if (req.method === 'GET' && p === '/v1/admin/overview') return send(res, 200, { ok: true, ...platform.overview() });
      // 桥接接入凭据：由平台把数据令牌和兼容入口地址交给管理方（控制中心据此改桥接配置），管理方不读平台的文件
      if (req.method === 'GET' && p === '/v1/admin/bridge-link') {
        const host = ['0.0.0.0', '::'].includes(cfg.host) ? '127.0.0.1' : cfg.host;
        return send(res, 200, { ok: true, dataToken: tokens.data, wsUrl: `ws://${host}:${boundPort}/onebot/v11/ws`, httpUrl: `http://${host}:${boundPort}/onebot/v11` });
      }
      if (req.method === 'GET' && p === '/v1/admin/providers') return send(res, 200, { ok: true, providers: platform.providers() });
      if (req.method === 'GET' && p === '/v1/admin/logs') {
        const q = Object.fromEntries(['level', 'scope', 'instance', 'account'].map((k) => [k, url.searchParams.get(k) || null]));
        return send(res, 200, { ok: true, lines: log.query({ after: Number(url.searchParams.get('after')) || 0, ...q }), lastSeq: log.lastSeq });
      }
      if (req.method === 'POST' && p === '/v1/admin/instances') return send(res, 200, { ok: true, instance: redactInstance(platform.addInstance(body)) });
      let m = /^\/v1\/admin\/instances\/([a-z0-9-]+)(?:\/(connect|disconnect))?$/.exec(p);
      if (m && req.method === 'POST') {
        if (m[2] === 'connect') return send(res, 200, platform.connectInstance(m[1]));
        if (m[2] === 'disconnect') return send(res, 200, platform.disconnectInstance(m[1]));
        return send(res, 200, { ok: true, instance: redactInstance(platform.updateInstance(m[1], body)) });
      }
      m = /^\/v1\/admin\/accounts\/([^/]+)\/bridge$/.exec(p);
      if (m && req.method === 'POST') return send(res, 200, { ok: true, ...platform.setBridgeEnabled(decodeURIComponent(m[1]), body.enabled === true) });
      if (req.method === 'POST' && p === '/v1/admin/shutdown') {
        send(res, 200, { ok: true });
        setTimeout(() => onShutdown?.('管理接口请求退出'), 50);
        return;
      }
      throw ERR.notFound('不存在的管理接口');
    }

    if (!dataAuthed(req, url)) throw ERR.unauthorized('需要数据令牌');
    if (req.method === 'GET' && p === '/v1/accounts') return send(res, 200, { ok: true, accounts: platform.accounts() });
    if (req.method === 'GET' && p === '/v1/capabilities') return send(res, 200, { ok: true, account: url.searchParams.get('account'), capabilities: platform.capabilities(String(url.searchParams.get('account') ?? '')) });
    if (req.method === 'GET' && p === '/v1/events') return handleEvents(req, res, url);
    if (req.method === 'POST' && p === '/v1/messages') {
      const body = await readBody(req, cfg.limits.maxMessageBytes);
      const { request, duplicate } = platform.sendMessage(body);
      const waitMs = Math.max(0, Math.min(60_000, Number(url.searchParams.get('wait') ?? 10_000) || 0));
      const final = waitMs ? await platform.tracker.wait(request.id, waitMs) : request;
      return send(res, ['confirmed', 'failed', 'unknown'].includes(final.state) ? 200 : 202, { ok: true, duplicate, request: final });
    }
    let m = /^\/v1\/requests\/(req_[A-Za-z0-9_-]+)$/.exec(p);
    if (m && req.method === 'GET') {
      const r = platform.tracker.get(m[1]);
      if (!r) throw ERR.notFound('没有这个请求（可能已过保留期）');
      return send(res, 200, { ok: true, request: r });
    }
    m = /^\/v1\/ext\/qq\/([A-Za-z0-9_.]+)$/.exec(p);
    if (m && req.method === 'POST') {
      const body = await readBody(req, cfg.limits.maxMessageBytes);
      const account = url.searchParams.get('account') || platform.resolveCompatAccount(null).account;
      if (!account?.startsWith('qq:')) throw ERR.badRequest('ext.qq 只能用于 QQ 账号');
      const r = await platform.callOneBot(account, m[1], body);
      return send(res, 200, { ok: true, account, response: r });
    }
    throw ERR.notFound('不存在的接口');
  }

  function redactInstance(i) {
    return { ...i, upstream: { wsUrl: i.upstream.wsUrl, homeDir: i.upstream.homeDir, hasToken: !!i.upstream.accessToken } };
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (!hostOk(req)) return send(res, 403, { ok: false, error: { code: 'forbidden_host', message: '不接受的 Host' } });
      const compat = parseCompatPath(url.pathname);
      if (compat) return await handleCompatHttp(req, res, url, compat);
      if (url.pathname.startsWith('/v1/')) return await routeV1(req, res, url);
      return send(res, 404, { ok: false, error: { code: 'not_found', message: '不存在' } });
    } catch (e) {
      try { sendError(res, e); } catch {}
    }
  });

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (!hostOk(req)) return rejectUpgrade(socket, 403, '不接受的 Host');
      const compat = parseCompatPath(url.pathname);
      if (compat && (compat.action === null || compat.action === 'ws')) return handleCompatWs(req, socket, head, url, compat);
      rejectUpgrade(socket, 404, '不存在');
    } catch {
      rejectUpgrade(socket, 400, 'bad request');
    }
  });

  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(cfg.port, cfg.host, () => {
          boundPort = server.address().port;
          resolve(boundPort);
        });
      });
    },
    get port() { return boundPort; },
    close() {
      return new Promise((r) => {
        server.close(() => r());
        server.closeAllConnections?.();
      });
    },
  };
}
