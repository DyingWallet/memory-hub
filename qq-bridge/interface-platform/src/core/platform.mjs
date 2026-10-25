// 接口平台核心：实例/账号注册表、健康阶梯、事件分发、发送调度。HTTP/WS 接口在 src/api/。
//
// 核心不依赖 DSH，也不决定 AI 说什么；它只负责「哪个账号由哪个实例执行」「事件发给谁」「请求到了哪一步」。

import { createEventBus } from './event-bus.mjs';
import { createLogger } from './logger.mjs';
import { createRequestTracker } from './requests.mjs';
import { loadConfig, saveConfig, loadTokens, normalizeInstance, defaultDataDir, extraAdminToken } from './config.mjs';
import { ERR, PlatformError, parseAccountId, SEGMENT_TYPES } from './model.mjs';
import { PROVIDERS, createConnector } from '../connectors/registry.mjs';
import fs from 'node:fs';

// 版本号只在一处维护：本目录的 package.json（与 qq-bridge-enhanced 项目版本保持一致，test-platform ⑦ 检查）
export const PLATFORM_VERSION = String(JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version);

export function createPlatform({ dataDir = defaultDataDir(), config = null, adminToken = extraAdminToken(), logger = null, stdoutLogs = true, WebSocketImpl = globalThis.WebSocket, now = Date.now, persist = true } = {}) {
  const cfg = config ?? loadConfig(dataDir);
  const tokens = { ...loadTokens(dataDir), adminExtra: extraAdminToken(adminToken) };
  const secrets = () => [tokens.data, tokens.admin, tokens.adminExtra, ...cfg.instances.map((i) => i.upstream.accessToken).filter(Boolean)];
  const log = logger ?? createLogger({ stdout: stdoutLogs, secrets, now });
  const core = log.child('core', {});
  const bus = createEventBus({ windowSize: cfg.limits.eventWindow });
  const tracker = createRequestTracker({ queueLimit: cfg.limits.queueLimit, now });
  const startedAt = now();
  const connectors = new Map(); // instanceId -> connector
  const compatClients = new Set(); // { account|null(auto), send(text), close() }
  const sseClients = new Set(); // { account|null }
  const stats = new Map(); // account -> { received, sent, lastReceiveAt, lastSendAt }

  function save() { if (persist) saveConfig(dataDir, cfg); }
  function stat(account) {
    if (!stats.has(account)) stats.set(account, { received: 0, sent: 0, lastReceiveAt: null, lastSendAt: null });
    return stats.get(account);
  }

  function bridgeEnabled(account) { return cfg.accounts[account]?.bridgeEnabled !== false; }

  function onConnectorEvent({ rawText, raw, unified, link }) {
    const account = link.account;
    if (account && raw.post_type !== 'meta_event') {
      const s = stat(account);
      s.received += 1;
      s.lastReceiveAt = now();
    }
    if (unified) bus.publish(unified);
    if (!account || !bridgeEnabled(account)) return;
    for (const c of compatClients) {
      if (resolveCompatAccount(c.account).account === account) c.send(rawText);
    }
  }

  function instantiate(inst) {
    const c = createConnector(inst, {
      recovery: cfg.recovery,
      limits: cfg.limits,
      log: log.child('instance', { instance: inst.id }),
      onEvent: onConnectorEvent,
      WebSocketImpl,
      now,
    });
    connectors.set(inst.id, c);
    return c;
  }

  for (const inst of cfg.instances) {
    if (PROVIDERS.find((p) => p.id === inst.provider)?.available) instantiate(inst);
    else core.warn(`实例 ${inst.id} 使用的提供方「${inst.provider}」尚未提供，已跳过`, { instance: inst.id });
  }

  // ── 账号与健康 ──────────────────────────────────────────────────────────────

  function ladderFor(link) {
    const open = link.state === 'open' && link.reason !== 'auth_failed';
    const loggedIn = open && !!link.account && link.online !== false;
    const ioReady = loggedIn && link.good === true && !link.stale;
    let reason = link.reason;
    if (!reason && open) {
      if (!link.account) reason = 'identifying';
      else if (link.online === false) reason = 'awaiting_login';
      else if (link.good === false) reason = 'receive_unhealthy';
      else if (link.stale) reason = 'receive_stale';
      else if (link.good === null) reason = 'awaiting_heartbeat';
    }
    return { coreRunning: true, backendReachable: open, loggedIn, ioReady, reason: reason ?? null };
  }

  function accounts() {
    const out = new Map();
    for (const [instId, c] of connectors) {
      for (const link of c.links()) {
        if (!link.account) continue;
        const h = ladderFor(link);
        const s = stats.get(link.account);
        out.set(link.account, {
          account: link.account,
          platform: parseAccountId(link.account)?.platform ?? null,
          raw: parseAccountId(link.account)?.raw ?? null,
          instance: instId,
          provider: c.instance.provider,
          nickname: link.nickname,
          health: { ...h, bridgeEnabled: bridgeEnabled(link.account) },
          bridge: { enabled: bridgeEnabled(link.account), attached: attachedCount(link.account) },
          queue: tracker.queueLength(link.account),
          received: s?.received ?? 0,
          sent: s?.sent ?? 0,
          lastReceiveAt: s?.lastReceiveAt ?? null,
          lastSendAt: s?.lastSendAt ?? link.lastSendAt ?? null,
        });
      }
    }
    // 配置里登记过、但当前没有链路的账号也列出来（离线）
    for (const acc of Object.keys(cfg.accounts)) {
      if (out.has(acc)) continue;
      out.set(acc, {
        account: acc, platform: parseAccountId(acc)?.platform ?? null, raw: parseAccountId(acc)?.raw ?? null, instance: null, provider: null, nickname: null,
        health: { coreRunning: true, backendReachable: false, loggedIn: false, ioReady: false, reason: 'no_route', bridgeEnabled: bridgeEnabled(acc) },
        bridge: { enabled: bridgeEnabled(acc), attached: attachedCount(acc) }, queue: 0, received: 0, sent: 0, lastReceiveAt: null, lastSendAt: null,
      });
    }
    return [...out.values()].sort((a, b) => a.account.localeCompare(b.account));
  }

  function attachedCount(account) {
    let n = 0;
    for (const c of compatClients) if (resolveCompatAccount(c.account).account === account) n += 1;
    for (const c of sseClients) if (!c.account || c.account === account) n += 1;
    return n;
  }

  function connectorFor(account) {
    for (const c of connectors.values()) if (c.started && c.hasAccount(account)) return c;
    return null;
  }

  /** 兼容入口的目标账号：显式指定 > 配置 > auto（恰好一个可路由账号时才成立）。 */
  function resolveCompatAccount(explicit) {
    const want = explicit || cfg.compat.onebot.account || 'auto';
    if (want !== 'auto') return { account: want };
    const routable = [];
    for (const c of connectors.values()) for (const l of c.links()) if (l.account && !routable.includes(l.account)) routable.push(l.account);
    if (routable.length === 1) return { account: routable[0] };
    return { account: null, reason: routable.length ? `有 ${routable.length} 个账号，auto 无法确定目标；请在 compat.onebot.account 或路径 /onebot/v11/@<账号>/ 指定` : '还没有可用账号' };
  }

  function instancesView() {
    return cfg.instances.map((inst) => {
      const c = connectors.get(inst.id);
      const provider = PROVIDERS.find((p) => p.id === inst.provider) ?? null;
      return {
        id: inst.id,
        platform: inst.platform,
        provider: inst.provider,
        providerName: provider?.name ?? inst.provider,
        providerAvailable: !!provider?.available,
        management: inst.management,
        enabled: inst.enabled,
        connected: !!c?.started,
        upstream: { wsUrl: inst.upstream.wsUrl, homeDir: inst.upstream.homeDir, hasToken: !!inst.upstream.accessToken },
        links: c ? c.links() : [],
        discoveryError: c?.discoveryError?.() ?? null, // 后端目录读不了（例如 macOS 隐私保护拦截）时的原因
      };
    });
  }

  function overview() {
    const accs = accounts();
    const insts = instancesView();
    const lastReceiveAt = Math.max(0, ...accs.map((a) => a.lastReceiveAt ?? 0)) || null;
    const lastSendAt = Math.max(0, ...accs.map((a) => a.lastSendAt ?? 0)) || null;
    return {
      version: PLATFORM_VERSION,
      startedAt,
      uptimeMs: now() - startedAt,
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      dataDir,
      core: { running: true, events: bus.lastId, eventSubscribers: bus.subscriberCount, compatClients: compatClients.size, sseClients: sseClients.size },
      counts: {
        instances: insts.length,
        instancesConnected: insts.filter((i) => i.connected).length,
        instancesFaulty: insts.filter((i) => i.connected && i.links.some((l) => l.state !== 'open')).length,
        accounts: accs.length,
        accountsReady: accs.filter((a) => a.health.ioReady).length,
      },
      lastReceiveAt,
      lastSendAt,
      instances: insts,
      accounts: accs,
      compat: { onebot: { enabled: cfg.compat.onebot.enabled, account: cfg.compat.onebot.account, resolved: resolveCompatAccount(null) } },
      support: {
        platforms: ['qq'],
        note: 'M1：QQ 经 SnowLuma（Windows / Linux）或 NapCat（macOS / Windows / Linux）外部运行接入，可同时启用。自研 Mac 原生 QQ（M3）、其他平台尚未提供。',
      },
    };
  }

  // ── 发送 ────────────────────────────────────────────────────────────────────

  function validateMessage(body) {
    const account = String(body?.account ?? '');
    if (!parseAccountId(account)) throw ERR.badRequest('account 必须形如 qq:10001');
    const conv = body?.conversation;
    if (!conv || !['private', 'group', 'temp'].includes(conv.type) || !conv.id) throw ERR.badRequest('conversation 必须是 { type: private|group|temp, id }');
    if (!Array.isArray(body.segments) || !body.segments.length) throw ERR.badRequest('segments 不能为空');
    for (const s of body.segments) if (!SEGMENT_TYPES.has(s?.type)) throw ERR.unsupportedSegment(String(s?.type));
    const clientRequestId = body.clientRequestId != null ? String(body.clientRequestId).slice(0, 128) : null;
    return { account, conversation: { type: conv.type, id: String(conv.id) }, segments: body.segments, clientRequestId };
  }

  function sendMessage(body) {
    const m = validateMessage(body);
    if (!bridgeEnabled(m.account)) throw ERR.bridgeDisabled(m.account);
    const c = connectorFor(m.account);
    if (!c) throw ERR.instanceUnavailable('?', `没有承接账号 ${m.account} 的实例`);
    const caps = c.capabilities();
    const capKey = `message.send.${m.conversation.type}`;
    if (!caps[capKey]?.declared) throw ERR.unsupported(capKey);
    for (const s of m.segments) {
      const k = `message.segment.${s.type}`;
      if (s.type !== 'ext' && !caps[k]?.declared) throw ERR.unsupportedSegment(s.type);
    }
    return tracker.submit({
      account: m.account,
      kind: 'message',
      clientRequestId: m.clientRequestId,
      summary: { conversation: m.conversation, segments: m.segments.length },
      execute: async ({ markSubmitted }) => {
        const conn = connectorFor(m.account);
        if (!conn) throw ERR.instanceUnavailable('?', `账号 ${m.account} 的实例已断开`);
        const r = await conn.sendMessage(m.account, m.conversation, m.segments, { markSubmitted });
        const s = stat(m.account);
        s.sent += 1;
        s.lastSendAt = now();
        return r;
      },
    });
  }

  /** OneBot 动作透传：兼容入口和 /v1/ext/qq 共用。 */
  async function callOneBot(account, action, params) {
    if (!/^[a-z_][a-z0-9_.]{0,63}$/i.test(String(action))) throw ERR.badRequest('动作名不合法');
    if (!account) throw ERR.instanceUnavailable('?', '没有目标账号');
    if (!bridgeEnabled(account)) throw ERR.bridgeDisabled(account);
    const c = connectorFor(account);
    if (!c) throw ERR.instanceUnavailable('?', `没有承接账号 ${account} 的实例`);
    const r = await c.callAction(account, action, params ?? {});
    if (/^send_/.test(action) && r?.status === 'ok') {
      const s = stat(account);
      s.sent += 1;
      s.lastSendAt = now();
    }
    return r;
  }

  // ── 管理 ────────────────────────────────────────────────────────────────────

  function addInstance(body) {
    const inst = normalizeInstance(body);
    if (cfg.instances.some((i) => i.id === inst.id)) throw ERR.badRequest(`实例 ID 已存在：${inst.id}`);
    const provider = PROVIDERS.find((p) => p.id === inst.provider);
    if (!provider) throw ERR.badRequest(`未知提供方：${inst.provider}`);
    if (!provider.available) throw ERR.badRequest(`提供方「${provider.name}」尚未提供`);
    if (!provider.management.includes(inst.management)) throw ERR.badRequest(`提供方「${provider.name}」不支持管理方式 ${inst.management}`);
    cfg.instances.push(inst);
    save();
    const c = instantiate(inst);
    if (inst.enabled) c.start();
    core.info(`新增实例 ${inst.id}（${provider.name}）`, { instance: inst.id });
    return inst;
  }

  function updateInstance(id, body) {
    const idx = cfg.instances.findIndex((i) => i.id === id);
    if (idx < 0) throw ERR.notFound(`没有实例 ${id}`);
    const cur = cfg.instances[idx];
    const newToken = body.upstream?.accessToken;
    const next = normalizeInstance({
      ...cur,
      ...(body.management ? { management: body.management } : {}),
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      upstream: {
        ...cur.upstream,
        ...(body.upstream?.wsUrl !== undefined ? { wsUrl: body.upstream.wsUrl } : {}),
        ...(body.upstream?.homeDir !== undefined ? { homeDir: body.upstream.homeDir } : {}),
        ...(newToken !== undefined ? { accessToken: newToken } : {}),
      },
      id,
    });
    const provider = PROVIDERS.find((p) => p.id === next.provider);
    if (provider && !provider.management.includes(next.management)) throw ERR.badRequest(`提供方「${provider.name}」不支持管理方式 ${next.management}`);
    cfg.instances[idx] = next;
    save();
    connectors.get(id)?.reload(next);
    core.info(`实例 ${id} 配置已更新`, { instance: id });
    return next;
  }

  function connectInstance(id) {
    const c = connectors.get(id);
    if (!c) throw ERR.notFound(`没有实例 ${id}（或其提供方尚未提供）`);
    c.start();
    return { ok: true };
  }

  function disconnectInstance(id) {
    const c = connectors.get(id);
    if (!c) throw ERR.notFound(`没有实例 ${id}`);
    const accs = c.links().map((l) => l.account).filter(Boolean);
    c.stop();
    for (const a of accs) tracker.failQueued(a, ERR.instanceUnavailable(id, '实例已断开'));
    return { ok: true, accounts: accs };
  }

  function setBridgeEnabled(account, enabled) {
    if (!parseAccountId(account)) throw ERR.badRequest('账号 ID 必须形如 qq:10001');
    cfg.accounts[account] = { ...(cfg.accounts[account] ?? {}), bridgeEnabled: !!enabled };
    save();
    core.info(`账号 ${account} 的桥接已${enabled ? '启用' : '停用'}`, { account });
    return { account, bridgeEnabled: !!enabled };
  }

  function start() {
    for (const [id, c] of connectors) {
      if (cfg.instances.find((i) => i.id === id)?.enabled) c.start();
    }
  }

  function stop() {
    for (const c of connectors.values()) c.stop();
    for (const c of compatClients) c.close();
    compatClients.clear();
  }

  return {
    cfg,
    tokens,
    log,
    bus,
    tracker,
    dataDir,
    connectors,
    compatClients,
    sseClients,
    accounts,
    instancesView,
    overview,
    providers: () => PROVIDERS,
    capabilities(account) {
      const c = connectorFor(account);
      if (!c) throw ERR.notFound(`没有承接账号 ${account} 的实例`);
      return c.capabilities();
    },
    bridgeEnabled,
    resolveCompatAccount,
    sendMessage,
    callOneBot,
    addInstance,
    updateInstance,
    connectInstance,
    disconnectInstance,
    setBridgeEnabled,
    start,
    stop,
    PlatformError,
  };
}
