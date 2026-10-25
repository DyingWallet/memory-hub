// 平台配置与令牌。
//
// 数据目录（默认 <包目录>/state，可用 INTERFACE_PLATFORM_DATA_DIR 覆盖）：
//   platform.json   实例、账号开关、兼容入口、恢复策略
//   data-token      数据令牌（桥接用：/v1 数据接口与 OneBot 兼容入口）
//   admin-token     管理令牌（/v1/admin/*）
// 两个令牌互不通用。
// 另外，启动方（例如 qq-bridge 控制中心）可以经环境变量 INTERFACE_PLATFORM_ADMIN_TOKEN 交来一个**它自己保管**的管理令牌，
// 平台把它当作额外的管理令牌接受 —— 这样控制中心不必读平台数据目录里的任何文件。令牌文件权限 0600；不会出现在日志里（logger 会按值脱敏）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_PORT = 3120;

export function defaultDataDir() {
  return process.env.INTERFACE_PLATFORM_DATA_DIR ? path.resolve(process.env.INTERFACE_PLATFORM_DATA_DIR) : path.join(PACKAGE_ROOT, 'state');
}

/** 默认实例按操作系统选：Windows 用 SnowLuma；macOS（没有 SnowLuma）与 Linux 用 NapCat。Linux 上的 SnowLuma 在控制中心「开启 SnowLuma」时按需建实例。 */
export function defaultConfig(os = process.platform) {
  const provider = os === 'win32' ? 'snowluma' : 'napcat';
  return {
    host: '127.0.0.1',
    port: DEFAULT_PORT,
    instances: [
      {
        id: `${provider}-main`,
        platform: 'qq',
        provider,
        management: 'external',
        enabled: true,
        upstream: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '', homeDir: '' },
      },
    ],
    accounts: {},
    compat: { onebot: { enabled: true, account: 'auto' } },
    recovery: { reconnect: true, reconnectMinMs: 1000, reconnectMaxMs: 30000 },
    limits: { queueLimit: 200, eventWindow: 2000, requestTimeoutMs: 30000, slowReadTimeoutMs: 120000, maxMessageBytes: 64 * 1024 * 1024 },
  };
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** 校验并补齐默认值；不合法时抛出带中文说明的错误。 */
export function normalizeConfig(raw, os = process.platform) {
  const d = defaultConfig(os);
  const c = { ...d, ...(raw ?? {}) };
  c.host = String(c.host || d.host);
  c.port = Number.isInteger(Number(c.port)) && Number(c.port) >= 0 && Number(c.port) < 65536 ? Number(c.port) : d.port;
  c.compat = { onebot: { ...d.compat.onebot, ...(raw?.compat?.onebot ?? {}) } };
  c.recovery = { ...d.recovery, ...(raw?.recovery ?? {}) };
  c.limits = { ...d.limits, ...(raw?.limits ?? {}) };
  c.accounts = raw?.accounts && typeof raw.accounts === 'object' ? { ...raw.accounts } : {};
  const ids = new Set();
  c.instances = (Array.isArray(raw?.instances) ? raw.instances : d.instances).map((i) => normalizeInstance(i));
  for (const i of c.instances) {
    if (ids.has(i.id)) throw new Error(`实例 ID 重复：${i.id}`);
    ids.add(i.id);
  }
  return c;
}

export function normalizeInstance(i) {
  const id = String(i?.id ?? '');
  if (!ID_RE.test(id)) throw new Error(`实例 ID 不合法：「${id}」（只能用小写字母、数字、-，最长 48）`);
  const management = ['external', 'hosted', 'remote'].includes(i?.management) ? i.management : 'external';
  return {
    id,
    platform: String(i?.platform || 'qq'),
    provider: String(i?.provider || 'snowluma'),
    management,
    enabled: i?.enabled !== false,
    upstream: {
      wsUrl: String(i?.upstream?.wsUrl || 'ws://127.0.0.1:3001'),
      accessToken: String(i?.upstream?.accessToken ?? ''),
      homeDir: String(i?.upstream?.homeDir ?? ''),
    },
  };
}

export function loadConfig(dataDir) {
  const file = path.join(dataDir, 'platform.json');
  let raw = null;
  try {
    let t = fs.readFileSync(file, 'utf8');
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    raw = JSON.parse(t);
  } catch (e) {
    if (e?.code !== 'ENOENT') throw new Error(`platform.json 无法解析：${e?.message ?? e}`);
  }
  return normalizeConfig(raw);
}

export function saveConfig(dataDir, cfg) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'platform.json');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function loadOrCreate(file) {
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (/^[a-f0-9]{48}$/.test(t)) return t;
  } catch {}
  const n = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, n, { mode: 0o600 });
  return n;
}

export function loadTokens(dataDir) {
  return {
    data: loadOrCreate(path.join(dataDir, 'data-token')),
    admin: loadOrCreate(path.join(dataDir, 'admin-token')),
  };
}

/** 启动方交来的额外管理令牌：至少 32 个字符，否则忽略（防止误把空串或短串当令牌）。 */
export function extraAdminToken(value = process.env.INTERFACE_PLATFORM_ADMIN_TOKEN) {
  const t = String(value ?? '').trim();
  return t.length >= 32 ? t : null;
}

export function tokenEq(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
