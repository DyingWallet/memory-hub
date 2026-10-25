#!/usr/bin/env node
// qq-bridge 控制中心：一个只监听本机回环的小网页。页面顶部两个大标签：「桥接」与「接口平台」（仓库内的 interface-platform/），
// 切换只改变显示，不启停任何模块；SnowLuma 的目录/启停/更新在「接口平台 → 接入实例」里。
// 接口平台是仓库里的独立子目录（interface-platform/，自己的 package.json 与 state/），控制中心只经它的 HTTP 管理接口通信。
//
// 用法：双击仓库根目录的 control-center.bat（有窗口）或 control-center-hidden.vbs（无窗口），
//      或 `npm run control-center`。启动后自动打开浏览器（--no-open 关闭）。
//
// 设计要点：
//   · 控制中心是**外壳进程**：桥接、接口平台与 SnowLuma 都是它的子进程。任一个崩溃或被停止时，页面仍然可用。
//   · 接口平台和桥接相互独立：停止桥接不影响平台和账号在线；停止平台不会停止外部运行的 SnowLuma。
//   · 启动控制中心**不会**启动桥接，更**不会**启动 SnowLuma —— 两者都只在用户点击按钮时启动。
//     SnowLuma 崩溃后也不自动重启（自动拉起 = 自动启动，违背「只由用户点击」）。
//   · 不下载、不安装、不修改 SnowLuma 的任何程序文件；更新只做「检查版本 + 打开下载页 + 迁移用户数据」
//     （SnowLuma EULA v1.1 §5.4，见 snowluma-install.mjs 头注释）。
//   · 页面令牌：state/control-center-token（首次启动生成）。浏览器通过地址的 #t=… 片段拿到令牌
//     （片段不会发给服务器、不进日志），之后每个请求带 x-control-token 头。只接受本机 Host、JSON、同源请求。
//   · 左侧的「命令」是**固定命令集**（status / mode / panic …），不是 shell —— 不能执行任意程序。
//   · 退出控制中心会先优雅停止它启动的子进程（子进程的输出管道依附于控制中心）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createManagedProcess } from './managed-process.mjs';
import { inspectSnowLumaDir, snowlumaLaunchSpec, checkSnowLumaUpdate, migrateSnowLumaData, pickFolderDialog, migrationWarning, SNOWLUMA_RELEASES_PAGE } from './snowluma-install.mjs';
import { redactCredentials, redactKnown } from '../lib/redact.mjs';
import { inspectNapCat, napcatLaunchSpec, napcatDefaultHome, NAPCAT_DEFAULT_WEBUI_PORT, napcatFileVersion, napcatRuntimeVersion, checkNapCatUpdate, validateNapCatSettings, NAPCAT_RELEASES_PAGE, NAPCAT_MAC_INSTALLER_PAGE, napcatQrStatus, readNapCatQr, napcatLoggedIn } from './napcat-launch.mjs';
import { pickDialog } from './pick-dialog.mjs';
// NapCat 是否已在别处运行：看它的 WebUI 端口（默认 6099，可在设置 napcatWebuiPort 改）
import { atomicWriteJsonFile, readJsonFile } from '../lib/json-store.js';
import { resolveDshBaseUrl } from '../lib/dsh-endpoint.mjs';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// 路径都按「项目根目录」计算；离线测试可以传入临时根目录（见 scripts/test-control-center.mjs）。
let ROOT = DEFAULT_ROOT;
let STATE_DIR, SETTINGS_FILE, TOKEN_FILE, LOCK_FILE, LOG_DIR, PAGE_FILE, VERSION, PLATFORM_ADMIN_TOKEN_FILE, LINK_BACKUP;
function setRoot(root) {
  ROOT = path.resolve(root);
  STATE_DIR = path.join(ROOT, 'state');
  SETTINGS_FILE = path.join(STATE_DIR, 'control-center.json');
  TOKEN_FILE = path.join(STATE_DIR, 'control-center-token');
  LOCK_FILE = path.join(STATE_DIR, 'control-center.lock');
  LOG_DIR = path.join(STATE_DIR, 'logs');
  PAGE_FILE = path.join(DEFAULT_ROOT, 'public', 'control-center.html');
  PLATFORM_ADMIN_TOKEN_FILE = path.join(STATE_DIR, 'platform-admin-token');
  LINK_BACKUP = path.join(STATE_DIR, 'platform-link-backup.json');
  VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return 'unknown'; } })();
}
setRoot(DEFAULT_ROOT);

// ── 小工具 ────────────────────────────────────────────────────────────────────

function readJson(file, fallback = null) {
  const r = readJsonFile(file);
  return r.ok ? r.value : fallback;
}
function readText(file) { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } }
function tokenEq(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
function portOpen(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}
function openBrowser(url) {
  if (process.platform === 'win32') {
    // 用 url.dll 的协议处理器打开默认浏览器：不经过 cmd 的引号/元字符解析。
    execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe'), ['url.dll,FileProtocolHandler', url], { windowsHide: true }, () => {});
  } else if (process.platform === 'darwin') {
    execFile('open', [url], () => {});
  } else {
    execFile('xdg-open', [url], () => {});
  }
}

// ── 设置与令牌 ────────────────────────────────────────────────────────────────

function loadSettings() {
  return { port: 3099, snowlumaDir: '', autoRestartBridge: true, autoRestartPlatform: true, platformDir: '', platformPort: 3120, napcatCommand: '', napcatQQApp: '', napcatHome: '', napcatWebuiPort: 0, napcatQuickLogin: '', ...(readJson(SETTINGS_FILE, {}) ?? {}) };
}
function saveSettings(s) { atomicWriteJsonFile(SETTINGS_FILE, s); }
function loadOrCreateToken() {
  const t = readText(TOKEN_FILE);
  if (/^[a-f0-9]{48}$/.test(t)) return t;
  const n = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, n, { mode: 0o600 });
  return n;
}

// ── 桥接配置（可能还不存在：未部署时也要能打开控制中心）────────────────────────

function bridgeConfig() {
  const r = readJsonFile(path.join(ROOT, 'config.json'));
  if (r.missing) return { exists: false, valid: false, error: '还没有 config.json（尚未部署）。部署时会从 config.example.json 复制并填写；见 docs/DSH_DEPLOYMENT.md 第 7 节。' };
  if (!r.ok || !r.value || typeof r.value !== 'object') return { exists: true, valid: false, error: `config.json 无法解析：${r.error?.message ?? r.error}` };
  return { exists: true, valid: true, value: r.value };
}
function consoleToken(cfg) {
  const fromCfg = String(cfg?.consoleToken ?? '').trim();
  return fromCfg || readText(path.join(STATE_DIR, 'console-token'));
}
function consolePort(cfg) { return Number(cfg?.consolePort) > 0 ? Number(cfg.consolePort) : 3100; }

async function bridgeApi(route, { method = 'GET', body } = {}) {
  const cfg = bridgeConfig();
  if (!cfg.valid) throw new Error(cfg.error);
  const token = consoleToken(cfg.value);
  if (!token) throw new Error('还没有控制台令牌（桥接首次启动后生成 state/console-token）');
  const res = await fetch(`http://127.0.0.1:${consolePort(cfg.value)}${route}`, {
    method,
    headers: { 'x-console-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && data?.ok !== false) throw new Error(`HTTP ${res.status}`);
  return data;
}

function dshVersion() {
  // 桌面版 DSH：%USERPROFILE%\.dsh\dsh-runtimes\*\runtime.json 的 desktopVersion（只读这个文件，不碰凭据）。
  const base = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-runtimes');
  try {
    for (const d of fs.readdirSync(base)) {
      const v = readJson(path.join(base, d, 'runtime.json'))?.desktopVersion;
      if (v) return `${v}（桌面版）`;
    }
  } catch {}
  // macOS 桌面版没有 dsh-runtimes：读 App 包的 Info.plist 版本号（只读这一个字段）
  if (process.platform === 'darwin') {
    try {
      const plist = fs.readFileSync(path.join(process.env.DSH_DESKTOP_APP || '/Applications/DeepSeek Harness.app', 'Contents', 'Info.plist'), 'utf8');
      const v = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
      if (v) return `${v}（桌面版）`;
    } catch {}
  }
  return null;
}

// ── 接口平台（仓库内的独立子目录 interface-platform/）──────────────────────────────
// 默认位置：仓库内的 interface-platform/；旧布局（与桥接目录平行的 ../interface-platform）在仓库内没有时仍然认。
function defaultPlatformDir() {
  const inRepo = path.join(ROOT, 'interface-platform');
  const legacy = path.join(ROOT, '..', 'interface-platform');
  return !fs.existsSync(path.join(inRepo, 'src', 'index.mjs')) && fs.existsSync(path.join(legacy, 'src', 'index.mjs')) ? legacy : inRepo;
}
// 边界：控制中心**只经平台的 HTTP 管理接口**与它通信 —— 不导入平台的模块，不读写平台数据目录里的任何文件。
//   · 管理令牌由控制中心自己生成并保管（state/platform-admin-token），启动平台时经环境变量交给它；
//   · 桥接要用的数据令牌与兼容入口地址，经 GET /v1/admin/bridge-link 向平台要；
//   · 平台目录与端口是控制中心自己的设置（state/control-center.json 的 platformDir / platformPort）。

const PLATFORM_DEFAULT_PORT = 3120;
let platformSettings = { dir: '', port: PLATFORM_DEFAULT_PORT };

function platformPort() { return platformSettings.port; }
function platformAdminToken() {
  const t = readText(PLATFORM_ADMIN_TOKEN_FILE);
  if (/^[a-f0-9]{48}$/.test(t)) return t;
  const n = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(PLATFORM_ADMIN_TOKEN_FILE, n, { mode: 0o600 });
  return n;
}

async function platformApi(route, { method = 'GET', body, timeoutMs = 4000 } = {}) {
  const res = await fetch(`http://127.0.0.1:${platformPort()}${route}`, {
    method,
    headers: { 'x-platform-admin-token': platformAdminToken(), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) throw Object.assign(new Error(res.status === 401 ? '接口平台不认控制中心的管理令牌（它不是由控制中心启动的）' : (data?.error?.message ?? `HTTP ${res.status}`)), { status: res.status });
  return data;
}

/** 桥接 config.json 当前是否经平台连接。 */
function bridgeLinkState() {
  const cfg = bridgeConfig();
  const sl = cfg.value?.snowluma ?? {};
  return { viaPlatform: sl.viaPlatform === true, wsUrl: sl.wsUrl ?? null, httpUrl: sl.httpUrl ?? null, backup: fs.existsSync(LINK_BACKUP) };
}

// ── 主程序 ────────────────────────────────────────────────────────────────────

export async function startControlCenter({ open = true, port: portOverride = null, root = null, bridgeEntry = null, platformEntry = null, installSignalHandlers = true, exitOnShutdown = true, log = (m) => console.log(`[控制中心] ${m}`) } = {}) {
  if (root) setRoot(root);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const settings = loadSettings();
  // portOverride=0：由系统分配空闲端口（离线测试用）。
  const port = portOverride === 0 ? 0 : (Number(portOverride ?? process.env.QQ_BRIDGE_CONTROL_PORT ?? settings.port) || 3099);
  const token = loadOrCreateToken();
  platformSettings = {
    dir: path.resolve(process.env.QQ_BRIDGE_PLATFORM_DIR || settings.platformDir || defaultPlatformDir()),
    port: Number(settings.platformPort) > 0 ? Number(settings.platformPort) : PLATFORM_DEFAULT_PORT,
  };
  const platformKey = platformAdminToken();
  const pageUrl = `http://127.0.0.1:${port}/#t=${token}`;

  // 单实例：已有控制中心在跑就直接打开它的页面。
  const lock = readJson(LOCK_FILE);
  if (lock?.pid && lock.pid !== process.pid && pidAlive(lock.pid) && await portOpen(lock.port || port)) {
    log(`控制中心已在运行（PID ${lock.pid}），直接打开页面`);
    if (open) openBrowser(`http://127.0.0.1:${lock.port || port}/#t=${token}`);
    return { alreadyRunning: true };
  }

  const secrets = () => {
    const cfg = bridgeConfig();
    return [token, consoleToken(cfg.value), String(cfg.value?.snowluma?.accessToken ?? ''), String(cfg.value?.dsh?.authToken ?? ''), platformKey].filter(Boolean);
  };
  const redact = (line) => redactCredentials(redactKnown(line, secrets()));

  let snowInfo = settings.snowlumaDir ? inspectSnowLumaDir(settings.snowlumaDir) : { ok: false, error: '未选择 SnowLuma 目录' };
  let updateInfo = null;
  let lastMigration = null;
  let napcatUpdate = null;

  const bridge = createManagedProcess({
    name: 'bridge',
    logDir: LOG_DIR,
    redact,
    resolveLaunch: () => {
      const cfg = bridgeConfig();
      if (!cfg.valid) return { error: cfg.error };
      if (!fs.existsSync(path.join(ROOT, 'node_modules'))) return { error: '还没有安装依赖：请在项目目录运行 npm ci' };
      return { command: process.execPath, args: [bridgeEntry ?? path.join(ROOT, 'src', 'bridge.js')], cwd: ROOT, env: { QQ_BRIDGE_SUPERVISED: '1' }, display: 'node src/bridge.js' };
    },
    // 退出码 2 = 已有另一个桥接实例（锁文件），1 且无配置 = 配置问题：重启也没用。
    shouldRestart: ({ code }) => code !== 0 && code !== 2 && bridgeConfig().valid,
    gracefulStop: async () => { try { await bridgeApi('/api/admin/shutdown', { method: 'POST', body: {} }); return true; } catch { return false; } },
  });
  bridge.setAutoRestart(settings.autoRestartBridge !== false);

  const snowluma = createManagedProcess({
    name: 'snowluma',
    logDir: LOG_DIR,
    redact,
    resolveLaunch: () => {
      snowInfo = settings.snowlumaDir ? inspectSnowLumaDir(settings.snowlumaDir) : { ok: false, error: '未选择 SnowLuma 目录' };
      return snowlumaLaunchSpec(snowInfo);
    },
    shouldRestart: () => false, // 不自动拉起 SnowLuma
  });

  const napcatWebuiPort = () => Number(settings.napcatWebuiPort) > 0 ? Number(settings.napcatWebuiPort) : NAPCAT_DEFAULT_WEBUI_PORT;
  // NapCat：和 SnowLuma 一样只在用户点击时启停，崩溃后不自动拉起
  const napcat = createManagedProcess({
    name: 'napcat',
    logDir: LOG_DIR,
    redact,
    resolveLaunch: () => napcatLaunchSpec(inspectNapCat(settings)),
    shouldRestart: () => false, // 不自动拉起 NapCat
  });

  const platform = createManagedProcess({
    name: 'platform',
    logDir: LOG_DIR,
    redact,
    resolveLaunch: () => {
      const entry = platformEntry ?? path.join(platformSettings.dir, 'src', 'index.mjs');
      if (!fs.existsSync(entry)) return { error: `找不到接口平台：${entry}。接口平台默认在仓库里的 interface-platform/（旧版放在桥接目录的同级也认）；也可以在 state/control-center.json 里设 "platformDir"，或设环境变量 QQ_BRIDGE_PLATFORM_DIR` };
      return { command: process.execPath, args: [entry, '--port', String(platformPort())], cwd: path.dirname(path.dirname(entry)), env: { INTERFACE_PLATFORM_ADMIN_TOKEN: platformKey }, display: `node ${path.join('interface-platform', 'src', 'index.mjs')} --port ${platformPort()}` };
    },
    // 退出码 3 = 启动失败（配置错误 / 端口被占用），重启也没用
    shouldRestart: ({ code }) => code !== 0 && code !== 3,
    gracefulStop: async () => { try { await platformApi('/v1/admin/shutdown', { method: 'POST', body: {} }); return true; } catch { return false; } },
  });
  platform.setAutoRestart(settings.autoRestartPlatform !== false);

  async function platformState() {
    const out = { ...platform.snapshot(), lastSeq: platform.lastSeq, port: platformPort(), dir: platformSettings.dir, installed: fs.existsSync(path.join(platformSettings.dir, 'src', 'index.mjs')) || !!platformEntry, link: bridgeLinkState() };
    out.reachable = await portOpen(out.port);
    out.external = out.reachable && !platform.running;
    out.overview = null;
    if (out.reachable) {
      try { out.overview = await platformApi('/v1/admin/overview', { timeoutMs: 1500 }); delete out.overview.ok; } catch (e) { out.overviewError = String(e?.message ?? e); }
    }
    await autoFillSnowLumaHome(out.overview);
    return out;
  }

  // 平台里默认生成的 SnowLuma 实例（例如从 v0.4.x 升级、平台第一次启动时建的 snowluma-main）既没有目录也没有令牌，
  // 连不上、在页面上标红。控制中心已经知道 SnowLuma 目录时，替它补上目录，让连接器按账号自己读令牌。
  // 只补「完全没配置」的实例（目录为空且没有令牌）：用户自己填了 WS 地址 + 令牌的实例不动。每个实例只自动补一次。
  const autoFilledHome = new Set();
  async function autoFillSnowLumaHome(ov) {
    if (!ov || !snowInfo.ok) return;
    const inst = (ov.instances ?? []).find((i) => i.provider === 'snowluma' && !i.upstream?.homeDir && !i.upstream?.hasToken);
    if (!inst || autoFilledHome.has(inst.id)) return;
    autoFilledHome.add(inst.id);
    try {
      await platformApi(`/v1/admin/instances/${inst.id}`, { method: 'POST', body: { upstream: { homeDir: snowInfo.dir } } });
      platform.note(`接口平台的 ${inst.id} 实例没有配置 SnowLuma 目录和令牌：已自动补上目录 ${snowInfo.dir}（连接器会按账号读取令牌）`);
    } catch (e) {
      platform.note(`给接口平台的 ${inst.id} 实例补 SnowLuma 目录失败：${e?.message ?? e}`);
    }
  }

  /** 把后端目录同步给平台里该提供方的实例 —— 只经管理接口；平台没运行就不同步（返回 false，页面会提示）。 */
  async function syncPlatformHomeDir(dir, provider = 'snowluma') {
    if (!await portOpen(platformPort())) return false;
    try {
      const ov = await platformApi('/v1/admin/overview', { timeoutMs: 1500 });
      const inst = ov.instances.find((i) => i.provider === provider);
      if (!inst || inst.upstream.homeDir === dir) return false;
      await platformApi(`/v1/admin/instances/${inst.id}`, { method: 'POST', body: { upstream: { homeDir: dir } } });
      return true;
    } catch { return false; }
  }

  /** 接入桥接：把桥接的 SnowLuma 端点改成平台的兼容入口（先备份原值）；enabled=false 时按备份还原。 */
  async function linkBridge(enabled) {
    const cfg = bridgeConfig();
    if (!cfg.valid) throw new Error(cfg.error);
    const file = path.join(ROOT, 'config.json');
    const sl = cfg.value.snowluma ?? {};
    if (enabled) {
      if (sl.viaPlatform === true) return { ok: true, already: true };
      const oldToken = sl.accessToken ?? '';
      // 凭据由平台经管理接口交来：平台必须在运行
      let creds;
      try { creds = await platformApi('/v1/admin/bridge-link'); } catch (e) { throw Object.assign(new Error(`接入桥接需要接口平台正在运行且由控制中心管理：${e.message}`), { status: 409 }); }
      atomicWriteJsonFile(LINK_BACKUP, { savedAt: Date.now(), snowluma: { wsUrl: sl.wsUrl ?? null, httpUrl: sl.httpUrl ?? null, accessToken: oldToken, followDiscoveredEndpoint: sl.followDiscoveredEndpoint ?? null, viaPlatform: sl.viaPlatform ?? null } });
      const { dataToken, wsUrl, httpUrl } = creds;
      const next = { ...sl, wsUrl, httpUrl, accessToken: dataToken, followDiscoveredEndpoint: false, viaPlatform: true };
      atomicWriteJsonFile(file, { ...cfg.value, snowluma: next });
      return { ok: true };
    }
    const b = readJson(LINK_BACKUP);
    const prev = b?.snowluma ?? {};
    const next = { ...sl };
    for (const k of ['wsUrl', 'httpUrl', 'accessToken', 'followDiscoveredEndpoint', 'viaPlatform']) {
      if (prev[k] === null || prev[k] === undefined) delete next[k]; else next[k] = prev[k];
    }
    if (!b) { next.viaPlatform = false; delete next.followDiscoveredEndpoint; next.wsUrl = 'ws://127.0.0.1:3001'; next.httpUrl = 'http://127.0.0.1:3000'; next.accessToken = ''; }
    atomicWriteJsonFile(file, { ...cfg.value, snowluma: next });
    try { fs.unlinkSync(LINK_BACKUP); } catch {}
    return { ok: true, restoredFromBackup: !!b };
  }

  // ── 接入后端开启卡：点「开启」= 确保接口平台在运行 → 启动该后端程序（能启动时）→ 确保平台里有它的实例并已连接 ──
  //    各后端互相独立，可以同时开启；「关闭」只断开该后端的实例，并停止由控制中心启动的那个程序。
  async function ensurePlatformUp(steps) {
    if (await portOpen(platformPort())) return;
    if (!platform.running) {
      platform.resetRestarts();
      const r = platform.start();
      if (!r.ok) throw Object.assign(new Error(`无法启动接口平台：${r.error}`), { status: 409 });
      steps.push('已启动接口平台');
    }
    for (let i = 0; i < 50; i++) { if (await portOpen(platformPort())) return; await new Promise((r) => setTimeout(r, 200)); }
    throw Object.assign(new Error('接口平台没有在 10 秒内就绪，请看「接口平台 → 日志」'), { status: 503 });
  }

  async function backendOn(provider) {
    const steps = [];
    await ensurePlatformUp(steps);
    if (provider === 'snowluma') {
      if (snowluma.running) steps.push('SnowLuma 已在运行');
      else if (!snowInfo.ok) steps.push('还没有选择 SnowLuma 目录：只连接已在运行的 SnowLuma（目录在「接入实例」里选）');
      else if (await portOpen(snowInfo.webui.port)) steps.push('SnowLuma 已在别处运行，直接连接');
      else { const r = snowluma.start(); steps.push(r.ok ? '已启动 SnowLuma' : `SnowLuma 启动失败：${r.error}`); }
    } else if (provider === 'napcat') {
      if (napcat.running) steps.push('NapCat 已在运行');
      else if (await portOpen(napcatWebuiPort())) steps.push('NapCat 已在别处运行（不是由控制中心启动的），直接连接');
      else {
        const info = inspectNapCat(settings);
        if (!info.ok) steps.push(`没有启动 NapCat：${info.error}`);
        else { const r = napcat.start(); steps.push(r.ok ? '已启动 NapCat（首次需扫码登录：二维码在 NapCat 日志里）' : `NapCat 启动失败：${r.error}`); }
      }
    } else {
      throw Object.assign(new Error(`未知后端：${provider}`), { status: 400 });
    }
    const ov = await platformApi('/v1/admin/overview');
    const inst = ov.instances.find((i) => i.provider === provider);
    if (!inst) {
      const homeDir = provider === 'napcat' ? napcatDefaultHome(settings) : (snowInfo.ok ? snowInfo.dir : '');
      await platformApi('/v1/admin/instances', { method: 'POST', body: { id: `${provider}-main`, provider, management: 'external', upstream: { homeDir } } });
      steps.push(`已在接口平台新建实例 ${provider}-main${homeDir ? '（按目录发现账号）' : ''}`);
    } else if (!inst.connected) {
      await platformApi(`/v1/admin/instances/${inst.id}/connect`, { method: 'POST', body: {} });
      steps.push(`已连接实例 ${inst.id}`);
    } else {
      steps.push(`实例 ${inst.id} 已连接`);
    }
    return steps;
  }

  async function backendOff(provider) {
    const steps = [];
    if (await portOpen(platformPort())) {
      try {
        const ov = await platformApi('/v1/admin/overview');
        for (const i of ov.instances.filter((x) => x.provider === provider && x.connected)) {
          await platformApi(`/v1/admin/instances/${i.id}/disconnect`, { method: 'POST', body: {} });
          steps.push(`已断开实例 ${i.id}`);
        }
      } catch (e) { steps.push(`断开实例失败：${e.message}`); }
    }
    const proc = provider === 'snowluma' ? snowluma : provider === 'napcat' ? napcat : null;
    if (!proc) throw Object.assign(new Error(`未知后端：${provider}`), { status: 400 });
    if (proc.running) { await proc.stop(); steps.push(`已停止由控制中心启动的 ${provider === 'snowluma' ? 'SnowLuma' : 'NapCat'}`); }
    else steps.push('程序不是由控制中心启动的，保持原样');
    return steps;
  }

  async function health() {
    const cfg = bridgeConfig();
    const out = { config: { exists: cfg.exists, valid: cfg.valid, error: cfg.error ?? null } };
    out.bridgeApi = null;
    if (cfg.valid) {
      try { out.bridgeApi = await bridgeApi('/api/status'); } catch (e) { out.bridgeApiError = String(e?.message ?? e); }
    }
    // dsh.baseUrl 留空 = 自动识别（固定端口 19387 / 3080，再找桌面版 0.2.1 起的随机端口）；页面以桥接的 dshReady 为准
    const dshUrl = (await resolveDshBaseUrl(cfg.value?.dsh?.baseUrl ?? '', { timeoutMs: 400 })).url;
    try {
      const u = new URL(dshUrl);
      out.dsh = { url: dshUrl, reachable: await portOpen(Number(u.port) || 80, u.hostname === 'localhost' ? '127.0.0.1' : u.hostname) };
    } catch { out.dsh = { url: dshUrl, reachable: false }; }
    out.dsh.version = dshVersion();
    out.consolePort = consolePort(cfg.value);
    // SnowLuma：自己启动的看进程；用户在外面自己开的看 WebUI 端口。
    out.snowlumaPort = snowInfo.ok ? await portOpen(snowInfo.webui.port) : false;
    out.bridgeExternal = !bridge.running && consoleToken(cfg.value) ? await portOpen(consolePort(cfg.value)) : false;
    return out;
  }

  // 登录二维码：只在 NapCat 由控制中心启动、还没登录时才去看文件
  function qrInfo(pl) {
    const snap = napcat.snapshot();
    const q = napcatQrStatus(settings, { running: snap.running, startedAt: snap.startedAt, loggedIn: napcatLoggedIn(pl?.overview) });
    return { waiting: q.waiting, updatedAt: q.updatedAt };
  }

  async function stateSnapshot() {
    const h = await health();
    const pl = await platformState();
    return {
      version: VERSION,
      node: process.versions.node,
      os: process.platform, // 注意：platform 键是接口平台的状态，操作系统放在 os
      root: ROOT,
      bridge: { ...bridge.snapshot(), lastSeq: bridge.lastSeq },
      snowluma: { ...snowluma.snapshot(), lastSeq: snowluma.lastSeq, dir: settings.snowlumaDir || null, info: snowInfo, update: updateInfo, lastMigration, releasesPage: SNOWLUMA_RELEASES_PAGE },
      platform: pl,
      napcat: {
        ...napcat.snapshot(), lastSeq: napcat.lastSeq, info: inspectNapCat(settings), external: !napcat.running && await portOpen(napcatWebuiPort()), home: napcatDefaultHome(settings),
        // 版本：运行中的以后端自报为准（经接口平台）；Windows 上不运行时也能从启动文件旁的 package.json 读到
        version: { runtime: napcatRuntimeVersion(pl.overview), file: napcatFileVersion(settings) },
        update: napcatUpdate,
        qr: qrInfo(pl),
        settings: { qqApp: settings.napcatQQApp || '', home: settings.napcatHome || '', command: settings.napcatCommand || '', quickLogin: settings.napcatQuickLogin || '' },
        releasesPage: process.platform === 'darwin' ? NAPCAT_MAC_INSTALLER_PAGE : NAPCAT_RELEASES_PAGE,
      },
      health: h,
    };
  }

  // ── 固定命令集 ──────────────────────────────────────────────────────────────
  const HELP = [
    '可用命令（不是系统终端，只能执行下面这些）：',
    '  status                     桥接当前模式、级别、DSH/SnowLuma 连通情况',
    '  mode <chat|reserved|reserved2|closed-agent> [L1|L2|L3] [TOTP]   切换模式（同控制台规则：L3 要 TOTP）',
    '  panic                      紧急关闭：立即回到安全模式',
    '  approvals                  查看待审批',
    '  audit [条数]               最近的管理审计记录',
    '  reconcile                  立刻重新对账群成员名单',
    '  bridge start|stop|restart  启停桥接',
    '  platform start|stop|restart  启停接口平台',
    '  snowluma start|stop        启停 SnowLuma',
    '  napcat start|stop          启停 NapCat',
    '  clear                      清空本页面的显示（不删除日志文件）',
  ].join('\n');

  async function runCommand(text) {
    const parts = String(text ?? '').trim().split(/\s+/).filter(Boolean);
    const [cmd, a1, a2, a3] = parts;
    const say = (m) => bridge.note(`> ${parts.join(' ')}\n${m}`);
    switch ((cmd ?? '').toLowerCase()) {
      case '': return { ok: true };
      case 'help': case '?': say(HELP); return { ok: true };
      case 'clear': return { ok: true, clear: true };
      case 'status': {
        const s = await bridgeApi('/api/admin/status').catch((e) => ({ text: `桥接接口不可用：${e.message}` }));
        say(s.text ?? JSON.stringify(s));
        return { ok: true };
      }
      case 'mode': {
        if (!a1) { say('用法：mode <chat|reserved|reserved2|closed-agent> [L1|L2|L3] [TOTP]'); return { ok: false }; }
        const r = await bridgeApi('/api/mode', { method: 'POST', body: { mode: a1, ...(a2 ? { level: a2.toUpperCase() } : {}), ...(a3 ? { totp: a3 } : {}) } }).catch((e) => ({ ok: false, error: e.message }));
        say(r.ok ? `已切换：${r.mode} / ${r.level}` : `切换失败：${r.error}`);
        return { ok: !!r.ok };
      }
      case 'panic': {
        const r = await bridgeApi('/api/admin/panic', { method: 'POST', body: {} }).catch((e) => ({ ok: false, error: e.message }));
        say(r.ok ? `已紧急关闭：${r.mode} / ${r.level}` : `失败：${r.error}`);
        return { ok: !!r.ok };
      }
      case 'approvals': {
        const r = await bridgeApi('/api/admin/status').catch((e) => ({ approvals: [], error: e.message }));
        say(r.error ? r.error : (r.approvals?.length ? r.approvals.map((x) => `#${x.id} ${x.key} ${x.toolName}`).join('\n') : '没有待审批（审批只能由 owner 在 QQ 里回复「通过 #编号」）'));
        return { ok: true };
      }
      case 'audit': {
        const n = Math.max(1, Math.min(100, Number(a1) || 20));
        const r = await bridgeApi(`/api/admin/audit?limit=${n}`).catch((e) => ({ entries: [], error: e.message }));
        say(r.error ? r.error : [`哈希链：${r.chain?.ok ? '完整' : '不一致'}`, ...r.entries.map((x) => `${x.time} ${x.event} ${x.source ?? ''}`)].join('\n'));
        return { ok: true };
      }
      case 'reconcile': {
        const r = await bridgeApi('/api/people/reconcile', { method: 'POST', body: {} }).catch((e) => ({ ok: false, error: e.message }));
        say(r.ok ? `对账完成：${JSON.stringify(r.results)}` : `失败：${r.error}`);
        return { ok: !!r.ok };
      }
      case 'bridge': {
        if (a1 === 'start') { const r = bridge.start(); return r; }
        if (a1 === 'stop') return bridge.stop();
        if (a1 === 'restart') { await bridge.stop(); return bridge.start(); }
        say('用法：bridge start|stop|restart'); return { ok: false };
      }
      case 'platform': {
        if (a1 === 'start') return platform.start();
        if (a1 === 'stop') return platform.stop();
        if (a1 === 'restart') { await platform.stop(); return platform.start(); }
        say('用法：platform start|stop|restart'); return { ok: false };
      }
      case 'napcat': {
        if (a1 === 'start') return napcat.start();
        if (a1 === 'stop') return napcat.stop();
        say('用法：napcat start|stop'); return { ok: false };
      }
      case 'snowluma': {
        if (a1 === 'start') return snowluma.start();
        if (a1 === 'stop') return snowluma.stop();
        say('用法：snowluma start|stop'); return { ok: false };
      }
      default:
        say(`未知命令「${cmd}」。输入 help 查看可用命令。`);
        return { ok: false };
    }
  }

  // ── HTTP ────────────────────────────────────────────────────────────────────
  const SEC = {
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  };
  const allowedHosts = () => [`127.0.0.1:${server.address()?.port ?? port}`, `localhost:${server.address()?.port ?? port}`];

  async function readBody(req) {
    const chunks = [];
    let n = 0;
    for await (const c of req) { n += c.length; if (n > 256 * 1024) throw Object.assign(new Error('请求体过大'), { status: 413 }); chunks.push(c); }
    const t = Buffer.concat(chunks).toString('utf8');
    if (!t.trim()) return {};
    const v = JSON.parse(t);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw Object.assign(new Error('请求体必须是 JSON 对象'), { status: 400 });
    return v;
  }

  const server = http.createServer(async (req, res) => {
    const send = (status, obj, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'content-type': type, ...SEC });
      res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
    };
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (!allowedHosts().includes(String(req.headers.host ?? '').toLowerCase())) return send(403, { ok: false, error: '只接受本机访问' });
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        let html;
        try { html = fs.readFileSync(PAGE_FILE, 'utf8'); } catch { return send(500, '控制中心页面缺失：public/control-center.html', 'text/plain; charset=utf-8'); }
        return send(200, html, 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204, SEC); return res.end(); }
      if (!url.pathname.startsWith('/api/')) return send(404, { ok: false, error: '不存在' });
      if (!tokenEq(req.headers['x-control-token'], token)) return send(401, { ok: false, error: '需要控制中心令牌（见 state/control-center-token）' });
      if (req.method !== 'GET') {
        if (!String(req.headers['content-type'] ?? '').includes('application/json')) return send(415, { ok: false, error: '请求必须是 application/json' });
        const origin = req.headers.origin;
        if (origin) { let h = ''; try { h = new URL(String(origin)).host; } catch {} if (!allowedHosts().includes(h)) return send(403, { ok: false, error: '跨站请求被拒绝' }); }
      }
      const body = req.method === 'POST' ? await readBody(req) : {};
      const p = url.pathname;

      if (req.method === 'GET' && p === '/api/state') return send(200, { ok: true, ...(await stateSnapshot()) });
      // NapCat 登录二维码：只在等扫码时给；文件位置固定（不接受路径参数），必须是 PNG
      if (req.method === 'GET' && p === '/api/napcat/qrcode') {
        const snap = napcat.snapshot();
        const q = napcatQrStatus(settings, { running: snap.running, startedAt: snap.startedAt, loggedIn: napcatLoggedIn((await platformState()).overview) });
        const buf = q.waiting ? readNapCatQr(q.file) : null;
        if (!buf) return send(404, { ok: false, error: '现在没有需要扫的二维码（NapCat 没在等扫码登录）' });
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': buf.length, ...SEC });
        return res.end(buf);
      }
      if (req.method === 'GET' && p === '/api/logs') {
        const src = { snowluma, platform, napcat }[url.searchParams.get('source')] ?? bridge;
        return send(200, { ok: true, lines: src.linesSince(Number(url.searchParams.get('after')) || 0, 2000), lastSeq: src.lastSeq });
      }
      // 打开桥接控制台：把桥接控制台令牌交给（已通过控制中心令牌鉴权的）本页，由页面带 ?token= 打开一次；
      // 桥接页面收到后存进它自己源（127.0.0.1:<consolePort>）的 localStorage 并立即从地址栏抹掉。用 POST，令牌不进任何 GET 地址。
      if (req.method === 'POST' && p === '/api/bridge/console-link') {
        const cfg = bridgeConfig();
        const port = consolePort(cfg.valid ? cfg.value : {});
        const tok = cfg.valid ? consoleToken(cfg.value) : '';
        if (!tok) return send(200, { ok: true, url: `http://127.0.0.1:${port}/`, auto: false, note: '还没有桥接控制台令牌（桥接首次启动后生成），打开后需要手动输入' });
        return send(200, { ok: true, url: `http://127.0.0.1:${port}/?token=${encodeURIComponent(tok)}`, auto: true });
      }
      if (req.method === 'POST' && p === '/api/bridge/start') { bridge.resetRestarts(); return send(200, bridge.start()); }
      if (req.method === 'POST' && p === '/api/bridge/stop') return send(200, await bridge.stop());
      if (req.method === 'POST' && p === '/api/bridge/restart') { await bridge.stop(); bridge.resetRestarts(); return send(200, bridge.start()); }
      if (req.method === 'POST' && p === '/api/bridge/auto-restart') {
        settings.autoRestartBridge = body.enabled === true;
        bridge.setAutoRestart(settings.autoRestartBridge);
        saveSettings(settings);
        return send(200, { ok: true, autoRestart: settings.autoRestartBridge });
      }
      // ── 接口平台 ──
      if (req.method === 'POST' && p === '/api/platform/start') {
        if (!platform.running && await portOpen(platformPort())) return send(409, { ok: false, error: `端口 ${platformPort()} 已被占用：接口平台可能已经在别处运行（不是由控制中心启动的，这里不会接管它）。` });
        platform.resetRestarts();
        return send(200, platform.start());
      }
      if (req.method === 'POST' && p === '/api/platform/stop') return send(200, await platform.stop());
      if (req.method === 'POST' && p === '/api/platform/restart') { await platform.stop(); platform.resetRestarts(); return send(200, platform.start()); }
      if (req.method === 'POST' && p === '/api/platform/auto-restart') {
        settings.autoRestartPlatform = body.enabled === true;
        platform.setAutoRestart(settings.autoRestartPlatform);
        saveSettings(settings);
        return send(200, { ok: true, autoRestart: settings.autoRestartPlatform });
      }
      if (req.method === 'POST' && p === '/api/platform/link-bridge') {
        const r = await linkBridge(body.enabled === true);
        bridge.note(body.enabled === true ? '已把桥接的 SnowLuma 端点改为接口平台的 OneBot 兼容入口（原值已备份）。重启桥接后生效。' : '已恢复桥接直连 SnowLuma 的原配置。重启桥接后生效。');
        return send(200, { ...r, link: bridgeLinkState(), restartNeeded: bridge.running });
      }
      if (req.method === 'GET' && p === '/api/platform/providers') {
        try { return send(200, await platformApi('/v1/admin/providers')); } catch (e) { return send(503, { ok: false, error: `接口平台未运行或不可达：${e.message}` }); }
      }
      // 管理操作只转发这几类，不提供任意转发
      {
        const m = /^\/api\/platform\/(instances(?:\/[a-z0-9-]+(?:\/(?:connect|disconnect))?)?|accounts\/[^/]+\/bridge)$/.exec(p);
        if (m && req.method === 'POST') {
          try { return send(200, await platformApi(`/v1/admin/${m[1]}`, { method: 'POST', body })); } catch (e) { return send(e.status && e.status < 500 ? e.status : 503, { ok: false, error: e.message }); }
        }
      }
      if (req.method === 'POST' && p === '/api/command') {
        const r = await runCommand(body.text);
        return send(200, { ok: true, result: r });
      }
      if (req.method === 'POST' && p === '/api/snowluma/pick') {
        const picked = await pickFolderDialog({ initialDir: settings.snowlumaDir || ROOT });
        return send(200, { ok: true, dir: picked });
      }
      // 通用「浏览…」：只接受固定的用途（标题、种类、初始目录由这里决定，页面不能传任意参数）
      if (req.method === 'POST' && p === '/api/pick') {
        const mac = process.platform === 'darwin';
        const PURPOSES = {
          'napcat-home': { kind: 'folder', title: '选择 NapCat 的目录（含 config/onebot11_<QQ号>.json）', initialDir: napcatDefaultHome(settings) },
          'napcat-qqapp': { kind: 'app', title: '选择已切换为 NapCat 入口的 QQ.app', initialDir: '/Applications' },
          'napcat-command': process.platform === 'linux'
            ? { kind: 'file', title: '选择 NapCat 启动文件（.sh 脚本或可执行文件）', initialDir: settings.napcatCommand ? path.dirname(settings.napcatCommand) : '', extensions: [] }
            : { kind: 'file', title: '选择 NapCat 启动文件（NapCat.Shell 里的 .bat / .exe）', initialDir: settings.napcatCommand ? path.dirname(settings.napcatCommand) : '', extensions: ['bat', 'cmd', 'exe'] },
          'snowluma-dir': { kind: 'folder', title: '选择 SnowLuma 的解压目录（含 launcher.bat 的那一层）', initialDir: settings.snowlumaDir || ROOT },
        };
        const spec = PURPOSES[String(body.purpose ?? '')];
        if (!spec) return send(400, { ok: false, error: '不支持的选择用途' });
        if (spec.kind === 'app' && !mac) return send(400, { ok: false, error: '只有 macOS 需要选择 QQ.app' });
        return send(200, { ok: true, path: await pickDialog(spec) });
      }
      if (req.method === 'POST' && p === '/api/napcat/settings') {
        const v = validateNapCatSettings(body);
        if (!v.ok) return send(400, { ok: false, error: v.error });
        const before = napcatDefaultHome(settings);
        Object.assign(settings, v.patch);
        saveSettings(settings);
        const steps = [...v.notes];
        const after = napcatDefaultHome(settings);
        if (after !== before) steps.push(await syncPlatformHomeDir(after, 'napcat') ? '已同步给接口平台的 NapCat 实例' : '接口平台没运行或还没有 NapCat 实例：之后开启 NapCat 时会按新目录建实例');
        if (napcat.running && ('qqApp' in body || 'command' in body || 'quickLogin' in body)) steps.push('NapCat 正在运行：启动方式的改动在下次启动时生效');
        napcatUpdate = null;
        napcat.note(`NapCat 设置已保存${steps.length ? `：${steps.join('；')}` : ''}`);
        return send(200, { ok: true, steps, settings: { qqApp: settings.napcatQQApp || '', home: settings.napcatHome || '', command: settings.napcatCommand || '', quickLogin: settings.napcatQuickLogin || '' } });
      }
      if (req.method === 'POST' && p === '/api/napcat/check-update') {
        const pl = await platformState();
        const current = napcatRuntimeVersion(pl.overview) || napcatFileVersion(settings);
        try {
          napcatUpdate = { ...(await checkNapCatUpdate(current)), checkedAt: Date.now() };
          return send(200, { ok: true, update: napcatUpdate });
        } catch (e) {
          return send(502, { ok: false, error: `检查更新失败：${e?.message ?? e}` });
        }
      }
      if (req.method === 'POST' && p === '/api/napcat/open-download') {
        openBrowser(napcatUpdate?.pageUrl || (process.platform === 'darwin' ? NAPCAT_MAC_INSTALLER_PAGE : NAPCAT_RELEASES_PAGE));
        return send(200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/snowluma/inspect') {
        return send(200, { ok: true, info: inspectSnowLumaDir(body.dir) });
      }
      if (req.method === 'POST' && p === '/api/snowluma/select') {
        if (snowluma.running) return send(409, { ok: false, error: '请先停止 SnowLuma 再更换目录' });
        const info = inspectSnowLumaDir(body.dir);
        if (!info.ok) return send(400, { ok: false, error: info.error });
        // 新目录缺账号配置和 WebUI 密码、旧目录却有：先不切换，提醒用「更新助手」迁移（用户确认「仍然切换」时带 force: true）
        const warn = body.force === true ? null : migrationWarning({ oldDir: settings.snowlumaDir, newDir: info.dir });
        if (warn) return send(200, { ok: true, switched: false, needMigrate: true, warning: warn.text, oldDir: warn.oldDir, newDir: warn.newDir, old: warn.old, info });
        settings.snowlumaDir = info.dir;
        saveSettings(settings);
        snowInfo = info;
        updateInfo = null;
        // 顺手把桥接配置里的 snowluma.homeDir 对齐（token 自愈要从它的 config/onebot_<QQ>.json 读）。
        let homeDirSynced = false;
        const cfg = bridgeConfig();
        // 桥接经平台连接时不写桥接的 homeDir（它会被忽略）；平台的 SnowLuma 实例总是同步。
        const platformSynced = await syncPlatformHomeDir(info.dir);
        if (cfg.valid && body.syncBridgeHomeDir !== false && cfg.value?.snowluma?.viaPlatform !== true && cfg.value?.snowluma?.homeDir !== info.dir) {
          try {
            const next = { ...cfg.value, snowluma: { ...(cfg.value.snowluma ?? {}), homeDir: info.dir } };
            atomicWriteJsonFile(path.join(ROOT, 'config.json'), next);
            homeDirSynced = true;
          } catch {}
        }
        snowluma.note(`已选择 SnowLuma 目录：${info.dir}（${info.version}，${info.edition === 'full' ? '完整版' : 'Lite 版'}）${homeDirSynced ? '；已同步 config.json 的 snowluma.homeDir（重启桥接后生效）' : ''}${platformSynced ? '；已同步给接口平台的 SnowLuma 实例' : ''}`);
        return send(200, { ok: true, switched: true, info, homeDirSynced, platformSynced });
      }
      if (req.method === 'POST' && p === '/api/snowluma/start') {
        if (!snowluma.running && snowInfo.ok && await portOpen(snowInfo.webui.port)) {
          return send(409, { ok: false, error: `端口 ${snowInfo.webui.port} 已被占用：SnowLuma 可能已经在别处运行（例如你手动双击了 launcher.bat）。请先关掉那个，再从这里启动。` });
        }
        return send(200, snowluma.start());
      }
      if (req.method === 'POST' && p === '/api/snowluma/stop') return send(200, await snowluma.stop());
      if (req.method === 'POST' && p === '/api/napcat/start') {
        if (!napcat.running && await portOpen(napcatWebuiPort())) return send(409, { ok: false, error: `端口 ${napcatWebuiPort()} 已被占用：NapCat（QQ）可能已经在别处运行。请先完全退出那个 QQ，再从这里启动。` });
        return send(200, napcat.start());
      }
      if (req.method === 'POST' && p === '/api/napcat/stop') return send(200, await napcat.stop());
      {
        const m = /^\/api\/backends\/(snowluma|napcat)\/(on|off)$/.exec(p);
        if (m && req.method === 'POST') {
          const steps = m[2] === 'on' ? await backendOn(m[1]) : await backendOff(m[1]);
          for (const t of steps) (m[1] === 'napcat' ? napcat : snowluma).note(`[开启卡] ${t}`);
          return send(200, { ok: true, steps });
        }
      }
      if (req.method === 'POST' && p === '/api/snowluma/check-update') {
        if (!snowInfo.ok) return send(400, { ok: false, error: '请先选择 SnowLuma 目录' });
        try {
          updateInfo = { ...(await checkSnowLumaUpdate(snowInfo.version)), checkedAt: Date.now() };
          return send(200, { ok: true, update: updateInfo });
        } catch (e) {
          return send(502, { ok: false, error: `检查更新失败：${e?.message ?? e}` });
        }
      }
      if (req.method === 'POST' && p === '/api/snowluma/open-download') {
        openBrowser(updateInfo?.pageUrl || SNOWLUMA_RELEASES_PAGE);
        return send(200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/snowluma/migrate') {
        if (snowluma.running || (snowInfo.ok && await portOpen(snowInfo.webui.port))) return send(409, { ok: false, error: '迁移前必须先停止 SnowLuma（数据文件在被写入时复制可能不完整）' });
        if (!settings.snowlumaDir) return send(400, { ok: false, error: '还没有选择当前（旧）SnowLuma 目录' });
        const r = migrateSnowLumaData({ fromDir: settings.snowlumaDir, toDir: body.toDir, backupRoot: path.join(STATE_DIR, 'snowluma-backups'), includeLogs: body.includeLogs === true });
        lastMigration = { ...r, at: Date.now() };
        if (r.ok && body.switchTo !== false) {
          const info = inspectSnowLumaDir(body.toDir);
          settings.snowlumaDir = info.dir;
          saveSettings(settings);
          snowInfo = info;
          updateInfo = null;
          const cfg = bridgeConfig();
          if (cfg.valid) {
            try { atomicWriteJsonFile(path.join(ROOT, 'config.json'), { ...cfg.value, snowluma: { ...(cfg.value.snowluma ?? {}), homeDir: info.dir } }); } catch {}
          }
        }
        snowluma.note(r.ok ? `数据迁移完成：${r.from} → ${r.to}，已备份到 ${r.backupDir}` : `数据迁移失败：${r.error}`);
        return send(r.ok ? 200 : 400, r);
      }
      if (req.method === 'POST' && p === '/api/snowluma/open-webui') {
        if (!snowInfo.ok) return send(400, { ok: false, error: '请先选择 SnowLuma 目录' });
        openBrowser(snowInfo.webui.url);
        return send(200, { ok: true, url: snowInfo.webui.url });
      }
      if (req.method === 'POST' && p === '/api/exit') {
        send(200, { ok: true });
        setTimeout(() => { void shutdown('页面上点击了「退出控制中心」'); }, 100);
        return;
      }
      return send(404, { ok: false, error: '不存在的接口' });
    } catch (error) {
      try { send(error?.status ?? 500, { ok: false, error: String(error?.message ?? error) }); } catch {}
    }
  });

  let shuttingDown = false;
  async function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`正在退出（${reason}）：先停止由控制中心启动的进程…`);
    await Promise.allSettled([bridge.stop(), snowluma.stop(), napcat.stop(), platform.stop()]);
    try { const l = readJson(LOCK_FILE); if (l?.pid === process.pid) fs.unlinkSync(LOCK_FILE); } catch {}
    await new Promise((r) => server.close(r));
    if (exitOnShutdown) process.exit(0);
  }
  if (installSignalHandlers) {
    process.on('SIGINT', () => { void shutdown('Ctrl+C'); });
    process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
    process.on('SIGHUP', () => { void shutdown('窗口关闭'); });
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  }).catch((error) => {
    if (error?.code === 'EADDRINUSE') throw new Error(`端口 ${port} 被占用。可在 state/control-center.json 里改 "port"，或设置环境变量 QQ_BRIDGE_CONTROL_PORT`);
    throw error;
  });
  atomicWriteJsonFile(LOCK_FILE, { pid: process.pid, port: server.address().port, startedAt: Date.now() });
  bridge.note(`控制中心 v${VERSION} 已启动。桥接尚未启动 —— 点击「启动桥接」（或在下方输入 bridge start）。`);
  if (!bridgeConfig().valid) bridge.note(bridgeConfig().error);
  platform.note('接口平台尚未启动 —— 需要时点击「启动接口平台」。启动后桥接不会自动改道，要经平台收发请在「设置」里点「接入桥接」。');
  snowluma.note(snowInfo.ok ? `SnowLuma 目录：${snowInfo.dir}（${snowInfo.version}）。未启动 —— 需要时点击「启动 SnowLuma」。` : '尚未选择 SnowLuma 目录。');
  log(`已启动：http://127.0.0.1:${server.address().port}/  （令牌在 state/control-center-token）`);
  if (open) openBrowser(`http://127.0.0.1:${server.address().port}/#t=${token}`);
  return { server, bridge, snowluma, napcat, platform, token, port: server.address().port, shutdown, runCommand, settings, pageUrl };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startControlCenter({ open: !process.argv.includes('--no-open') }).catch((error) => {
    console.error(`[控制中心] 启动失败：${error?.message ?? error}`);
    process.exit(1);
  });
}
