// OneBot v11 正向 WebSocket 连接器的公共实现。SnowLuma、NapCat 等 OneBot v11 后端共用它，
// 各提供方只提供：账号端点发现（discover）、提供方描述（provider）、能力说明的差异（capNotes）。
// 管理方式：外部运行 / 远程连接（只管通信连接，不启停后端进程）。
//
// 一个实例可以提供多个账号：配置了后端目录（upstream.homeDir）时，按提供方的配置文件为每个账号建一条上游链路；
// 没配目录时只建一条链路连 upstream.wsUrl。每条链路是该账号唯一的执行方：同一账号的所有动作都经它发出。
//
// 事件：上游原文（rawText）和统一事件一起交给平台；平台把原文原样转发给 OneBot 兼容客户端，统一事件进总线。
// 动作：内部 echo 改写，回执按 echo 配对；链路断开时在途动作一律以「结果未知」结束，不自动重发。
// 鉴权失败的两种形态都要识别：握手直接被拒（SnowLuma），或先接受连接、回一个 retcode 1403 再断开（NapCat）。

import { safeJsonParse, accountId, cap, ERR, PlatformError } from '../../core/model.mjs';
import { toUnifiedEvent, sendActionFor } from './mapping.mjs';

export function oneBotCapabilities(notes = {}) {
  return {
    'event.receive': cap(true, { note: '私聊/群聊/临时会话消息、通知、请求、心跳' }),
    'message.send.private': cap(true, { requires: ['account.ready'] }),
    'message.send.group': cap(true, { requires: ['account.ready'] }),
    'message.send.temp': cap(false, { reason: 'M1 未在统一接口中实现，可经 ext.qq.onebot 调用' }),
    'message.segment.text': cap(true),
    'message.segment.mention': cap(true),
    'message.segment.reply': cap(true),
    'message.segment.image': cap(true, { note: '来源限 base64:// 或 http(s)://' }),
    'message.segment.voice': cap(true, { note: '来源限 base64:// 或 http(s)://' }),
    'message.segment.video': cap(true, { note: '来源限 base64:// 或 http(s)://' }),
    'message.segment.file': cap(false, { reason: 'OneBot v11 发文件走 upload_*_file 动作，可经 ext.qq.onebot 调用' }),
    'message.history': cap(false, { reason: 'M1 未接入统一接口，可经 ext.qq.onebot 调用 get_msg / get_*_msg_history' }),
    'ext.qq.onebot': cap(true, { note: '过渡兼容层：OneBot v11 动作透传（数据令牌授权）' }),
    ...notes,
  };
}

const HEARTBEAT_STALE_MS = 95_000;
// 慢的只读动作：NapCat 读较早的合并转发时 get_msg / get_forward_msg 实测要七十多秒才回执，
// 用默认的 30 秒会在上游真正回来之前就报超时。只放宽这几个只读动作，发送类动作仍按默认超时。
export const SLOW_READ_ACTIONS = Object.freeze(['get_msg', 'get_forward_msg']);
export const SLOW_READ_TIMEOUT_MS = 120_000;
// 握手超时：后端刚启动时端口可能已开但迟迟不回握手，Node 内置 WebSocket 没有自带超时，会一直挂着
const HANDSHAKE_TIMEOUT_MS = 10_000;

export function createOneBotWsConnector({ provider, discover, capabilities = () => oneBotCapabilities(), instance, recovery = {}, limits = {}, log, onEvent, onChange = () => {}, WebSocketImpl = globalThis.WebSocket, now = Date.now }) {
  let inst = instance;
  let started = false;
  let rescanTimer = null;
  const links = new Map(); // key -> link
  let echoSeq = 0;
  const timeoutMs = Number(limits.requestTimeoutMs) || 30_000;
  const slowTimeoutMs = Math.max(timeoutMs, Number(limits.slowReadTimeoutMs) || SLOW_READ_TIMEOUT_MS);
  const timeoutFor = (action) => (SLOW_READ_ACTIONS.includes(action) ? slowTimeoutMs : timeoutMs);

  function endpointsNow() {
    if (inst.upstream.homeDir) {
      return discover(inst.upstream.homeDir).map((e) => ({ key: `uin:${e.uin}`, wsUrl: e.wsUrl, token: e.token, uinHint: e.uin }));
    }
    return [{ key: 'default', wsUrl: inst.upstream.wsUrl, token: inst.upstream.accessToken, uinHint: null }];
  }

  function makeLink(ep) {
    const L = {
      key: ep.key,
      ep,
      ws: null,
      state: 'idle',
      reason: 'connecting',
      account: ep.uinHint ? accountId('qq', ep.uinHint) : null,
      nickname: null,
      online: null,
      good: null,
      connectedAt: null,
      lastPacketAt: null,
      lastEventAt: null,
      lastSendAt: null,
      attempts: 0,
      everOpened: false,
      pending: new Map(),
      timer: null,
      closing: false,
    };
    links.set(L.key, L);
    return L;
  }

  function lg(L) { return { instance: inst.id, ...(L?.account ? { account: L.account } : {}) }; }

  function connect(L) {
    if (!started || L.closing) return;
    // 每次连接前重新读取端点：换账号后令牌/端口会变
    if (inst.upstream.homeDir) {
      // 读不到目录时沿用上次的端点（不因此断开）
      let fresh = null;
      try { fresh = endpointsNow().find((e) => e.key === L.key); } catch (err) { noteUnreadable(err); }
      if (fresh) L.ep = fresh;
    }
    const url = new URL(L.ep.wsUrl);
    if (L.ep.token) url.searchParams.set('access_token', L.ep.token);
    L.state = 'connecting';
    L.attempts += 1;
    onChange();
    let ws;
    try {
      ws = new WebSocketImpl(url.toString());
    } catch (error) {
      L.reason = 'connect_failed';
      log.warn(`上游地址无效：${L.ep.wsUrl}（${error?.message ?? error}）`, lg(L));
      return scheduleReconnect(L);
    }
    L.ws = ws;
    ws.binaryType = 'arraybuffer';
    // 连接失败的三种形态统一走 down()，每个 ws 只处理一次：
    //   ① close；② 只有 error 没有 close（Node 内置 WebSocket 在连接被拒 / 握手非 101 时实测如此）；③ 握手超时。
    let downHandled = false;
    const handshakeTimer = setTimeout(() => {
      if (L.ws !== ws || L.state === 'open') return;
      log.warn(`上游 ${Math.round(HANDSHAKE_TIMEOUT_MS / 1000)} 秒内没有完成握手，放弃这次连接`, lg(L));
      try { ws.close(); } catch {}
      down(1006);
    }, HANDSHAKE_TIMEOUT_MS);
    handshakeTimer.unref?.();
    function down(code) {
      if (downHandled || L.ws !== ws) return;
      downHandled = true;
      clearTimeout(handshakeTimer);
      L.ws = null;
      const wasOpen = L.state === 'open';
      L.state = 'closed';
      failPending(L, 'upstream_closed');
      if (L.closing) { L.reason = 'disconnected_by_user'; onChange(); return; }
      L.reason = L.authFailed ? 'auth_failed' : wasOpen ? 'reconnecting' : (inst.upstream.homeDir || L.ep.token ? 'connect_failed' : 'connect_failed_no_token');
      L.authFailed = false;
      log.warn(`上游连接${wasOpen ? '断开' : '失败'}（code=${code ?? '?'}）`, lg(L));
      onChange();
      scheduleReconnect(L);
    }
    ws.addEventListener('open', () => {
      if (L.ws !== ws) return;
      clearTimeout(handshakeTimer);
      L.state = 'open';
      // 上次是鉴权失败：在确认登录成功之前保持 auth_failed，退避也不清零（NapCat 每次都会先接受连接）
      if (L.reason !== 'auth_failed') { L.reason = null; L.attempts = 0; }
      L.everOpened = true;
      L.connectedAt = now();
      L.lastPacketAt = now();
      log.info(`已连接上游 ${L.ep.wsUrl}`, lg(L));
      onChange();
      call(L, 'get_login_info', {}, { timeoutMs: 10_000 }).then((r) => {
        if (r?.status === 'ok' && r.data) {
          L.reason = null;
          L.attempts = 0;
          const acc = accountId('qq', r.data.user_id);
          if (acc && L.account && acc !== L.account) log.warn(`上游报告的账号 ${acc} 与目录发现的 ${L.account} 不一致，以上游为准`, lg(L));
          if (acc) L.account = acc;
          L.nickname = r.data.nickname != null ? String(r.data.nickname) : null;
          log.info(`账号已识别：${L.account}${L.nickname ? `（${L.nickname}）` : ''}`, lg(L));
          onChange();
          // 后端程序与版本（OneBot 标准动作 get_version_info）：只用于显示，失败不影响收发
          call(L, 'get_version_info', {}, { timeoutMs: 10_000 }).then((v) => {
            if (v?.status !== 'ok' || !v.data) return;
            const s = (x) => (x == null ? null : String(x).slice(0, 80));
            L.backend = { appName: s(v.data.app_name), appVersion: s(v.data.app_version), protocolVersion: s(v.data.protocol_version) };
            onChange();
          }).catch(() => {});
        } else {
          log.warn(`get_login_info 失败：retcode=${r?.retcode ?? '?'} ${r?.wording ?? r?.message ?? ''}`, lg(L));
        }
      }).catch((e) => log.warn(`get_login_info 未返回：${e?.message ?? e}`, lg(L)));
    });
    ws.addEventListener('message', (m) => {
      if (L.ws !== ws) return;
      const text = typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString('utf8');
      L.lastPacketAt = now();
      let obj;
      try { obj = safeJsonParse(text); } catch { return log.warn('上游发来无法解析的数据，已忽略', lg(L)); }
      if (obj && obj.post_type === undefined && (obj.echo === undefined || obj.echo === null) && Number(obj.retcode) === 1403) {
        // NapCat：令牌不对时先接受连接、回 1403 再断开
        L.authFailed = true;
        log.warn(`上游拒绝了令牌（retcode 1403：${obj.wording ?? obj.message ?? ''}）`, lg(L));
        return;
      }
      if (obj && obj.post_type === undefined && obj.echo !== undefined) {
        const p = L.pending.get(String(obj.echo));
        if (p) { L.pending.delete(String(obj.echo)); clearTimeout(p.timer); p.resolve(obj); }
        return;
      }
      if (!obj || obj.post_type === undefined) return;
      if (!L.account && obj.self_id != null) { L.account = accountId('qq', obj.self_id); onChange(); }
      if (obj.post_type === 'meta_event' && obj.meta_event_type === 'heartbeat') {
        const prevGood = L.good;
        if (typeof obj.status?.good === 'boolean') L.good = obj.status.good;
        if (typeof obj.status?.online === 'boolean') L.online = obj.status.online;
        if (prevGood !== L.good) onChange();
      } else if (obj.post_type === 'notice' && obj.notice_type === 'bot_status') {
        L.online = obj.sub_type === 'online';
        log[L.online ? 'info' : 'warn'](`上游报告账号会话${L.online ? '已上线' : '已离线'}（bot_status）`, lg(L));
        onChange();
      } else {
        L.lastEventAt = now();
      }
      let unified = null;
      try { unified = toUnifiedEvent(obj, { instance: inst.id, now: now() }); } catch (e) { log.warn(`事件映射失败：${e?.message ?? e}`, lg(L)); }
      onEvent({ rawText: text, raw: obj, unified, link: L });
    });
    ws.addEventListener('close', (ev) => down(ev?.code));
    // 连上之后的 error 一般紧跟 close；还没连上时的 error 可能是唯一的信号，必须当失败处理
    ws.addEventListener('error', () => { if (L.state !== 'open') down(1006); });
  }

  function scheduleReconnect(L) {
    if (!started || L.closing || recovery.reconnect === false) return;
    const min = Number(recovery.reconnectMinMs) || 1000;
    const max = Number(recovery.reconnectMaxMs) || 30_000;
    const delay = Math.min(max, min * 2 ** Math.min(10, Math.max(0, L.attempts - 1)));
    const jitter = Math.floor(delay * 0.2 * Math.random());
    clearTimeout(L.timer);
    L.timer = setTimeout(() => connect(L), delay + jitter);
    L.timer.unref?.();
  }

  function failPending(L, code) {
    for (const [, p] of L.pending) {
      clearTimeout(p.timer);
      p.reject(Object.assign(new Error('上游连接已断开，动作结果未知'), { code, outcome: 'unknown' }));
    }
    L.pending.clear();
  }

  function call(L, action, params, { timeoutMs: tmo = timeoutMs, markSubmitted = null } = {}) {
    return new Promise((resolve, reject) => {
      if (!L.ws || L.state !== 'open') return reject(ERR.instanceUnavailable(inst.id, L.reason ?? '未连接'));
      echoSeq += 1;
      const echo = `pl:${inst.id}:${echoSeq}`;
      const timer = setTimeout(() => {
        L.pending.delete(echo);
        reject(Object.assign(new Error(`上游在 ${Math.round(tmo / 1000)} 秒内没有回执，结果未知`), { code: 'timeout', outcome: 'unknown' }));
      }, tmo);
      L.pending.set(echo, { resolve, reject, timer });
      try {
        L.ws.send(JSON.stringify({ action, params: params ?? {}, echo }));
        markSubmitted?.();
      } catch (error) {
        clearTimeout(timer);
        L.pending.delete(echo);
        reject(ERR.instanceUnavailable(inst.id, String(error?.message ?? error)));
      }
    });
  }

  function linkFor(account) {
    for (const L of links.values()) if (L.account === account) return L;
    return null;
  }

  // 目录读不了（权限 / macOS 隐私保护）≠ 账号消失：保留现有链路，只在状态变化时记一次日志
  let unreadable = null;
  function noteUnreadable(err) {
    if (err?.code !== 'DISCOVERY_UNREADABLE') throw err;
    if (unreadable !== err.message) log.warn(`${err.message}：暂时无法重新发现账号，保留现有链路（不当成账号消失）`, { instance: inst.id });
    unreadable = err.message;
  }

  function syncLinks() {
    if (!started) return;
    let eps;
    try { eps = endpointsNow(); } catch (err) { noteUnreadable(err); onChange(); return; }
    if (unreadable) { log.info('后端目录恢复可读', { instance: inst.id }); unreadable = null; }
    const keys = new Set(eps.map((e) => e.key));
    for (const ep of eps) {
      if (!links.has(ep.key)) { const L = makeLink(ep); log.info(`发现账号端点 ${ep.key}`, lg(L)); connect(L); }
    }
    for (const [k, L] of links) {
      if (!keys.has(k)) { log.info(`账号端点 ${k} 已从后端目录消失，关闭链路`, lg(L)); closeLink(L); links.delete(k); }
    }
    onChange();
  }

  function closeLink(L) {
    L.closing = true;
    clearTimeout(L.timer);
    const ws = L.ws;
    L.ws = null;
    L.state = 'closed';
    L.reason = 'disconnected_by_user';
    failPending(L, 'disconnected_by_user');
    try { ws?.close(1000, 'platform-disconnect'); } catch {}
  }

  return {
    get instance() { return inst; },
    get started() { return started; },
    start() {
      if (started) return;
      started = true;
      log.info(`实例启动（${inst.upstream.homeDir ? `按 ${provider.name} 目录发现账号：${inst.upstream.homeDir}` : `连接 ${inst.upstream.wsUrl}`}）`, { instance: inst.id });
      syncLinks();
      if (inst.upstream.homeDir) {
        rescanTimer = setInterval(syncLinks, 30_000);
        rescanTimer.unref?.();
      }
    },
    stop() {
      if (!started) return;
      started = false;
      clearInterval(rescanTimer);
      rescanTimer = null;
      for (const L of links.values()) closeLink(L);
      links.clear();
      log.info('实例已断开（按用户操作）', { instance: inst.id });
      onChange();
    },
    reload(next) {
      const was = started;
      this.stop();
      inst = next;
      if (was && next.enabled) this.start();
    },
    /** 链路快照（令牌不外露）。 */
    links() {
      const t = now();
      return [...links.values()].map((L) => ({
        key: L.key,
        url: L.ep.wsUrl,
        state: L.state,
        reason: L.reason,
        account: L.account,
        nickname: L.nickname,
        backend: L.backend ?? null, // { appName, appVersion, protocolVersion }：后端自报的程序与版本
        online: L.online,
        good: L.good,
        stale: L.state === 'open' && L.lastPacketAt != null && t - L.lastPacketAt > HEARTBEAT_STALE_MS,
        connectedAt: L.connectedAt,
        lastPacketAt: L.lastPacketAt,
        lastEventAt: L.lastEventAt,
        lastSendAt: L.lastSendAt,
        pending: L.pending.size,
      }));
    },
    /** 账号发现的读错误（null = 正常）。 */
    discoveryError: () => unreadable,
    capabilities,
    hasAccount: (account) => !!linkFor(account),
    /** OneBot 动作透传（兼容入口与 ext.qq.onebot）。返回上游回执对象（不含 echo）。 */
    async callAction(account, action, params, opts = {}) {
      const L = linkFor(account);
      if (!L) throw ERR.instanceUnavailable(inst.id, `没有账号 ${account} 的链路`);
      if (/^send_/.test(action)) L.lastSendAt = now();
      const r = await call(L, action, params, { timeoutMs: timeoutFor(action), ...opts });
      const { echo, ...rest } = r;
      return rest;
    },
    /** 统一发送。成功返回 { messageId }；后端拒绝抛 backendRejected 错误。 */
    async sendMessage(account, conversation, segments, { markSubmitted } = {}) {
      const L = linkFor(account);
      if (!L || L.state !== 'open') throw ERR.instanceUnavailable(inst.id, L?.reason ?? `没有账号 ${account} 的链路`);
      if (L.online === false) throw ERR.accountNotReady(account, '账号会话离线');
      const { action, params } = sendActionFor(conversation, segments);
      L.lastSendAt = now();
      const r = await call(L, action, params, { markSubmitted });
      if (r?.status === 'ok' && (r.retcode === 0 || r.retcode === undefined)) {
        return { messageId: r.data?.message_id != null ? String(r.data.message_id) : null };
      }
      throw Object.assign(new PlatformError('backend_rejected', `后端拒绝发送：${r?.wording ?? r?.message ?? `retcode=${r?.retcode}`}`, { status: 502, detail: { retcode: r?.retcode ?? null } }), { backendRejected: true });
    },
  };
}
