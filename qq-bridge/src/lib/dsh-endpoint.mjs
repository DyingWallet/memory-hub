// DSH Web API 地址的自动识别（v0.4.1）。
//
// 事实（对照 DSH 桌面版 0.2.0-rc.2 安装包 resources/app.asar）：桌面版启动内置服务时写死 `--port 19387`，
// 运行 `desktop` profile；命令行版 `dsh web` 默认 3080。部署实测踩过「文档默认 3080，桌面版实际 19387」。
//
// 规则：config.json 的 dsh.baseUrl **显式填写**时一律照用；留空（或缺省）时自动识别：
//   1. 检测到桌面版 → 候选顺序 19387、3080，否则 3080、19387。检测方式：
//      · Windows：~/.dsh/dsh-runtimes/*/runtime.json 有 desktopVersion；
//      · macOS：桌面版没有 dsh-runtimes，改看 App 包 Info.plist 的版本号（默认 /Applications/DeepSeek Harness.app，
//        可用 DSH_DESKTOP_APP 覆盖）。之前只认 Windows 的目录，Mac 上 DSH 还没起来时桥接会选成 3080、之后一直连不上。
//   2. 异步版本（resolveDshBaseUrl）按顺序试 TCP 连接，第一个能连上的胜出；
//   3. 都连不上时**动态发现**：DSH 桌面版 0.2.1 起每次启动监听一个随机回环端口（实测 macOS 0.2.1-rc.2，
//      不再写死 19387）。先把 DSH 桌面版进程正在监听的回环端口挑出来（macOS 用 lsof，Windows 用 netstat + tasklist）；
//      这一层拿不到时（Electron 把 web 服务放在 helper 子进程里，主进程一个端口都不占——2026-10-24 实测）
//      再退到「扫本机全部回环监听端口」，跳过 8787/8790 这类自己的服务；
//      两种都用未登录请求的 401 特征文字（"dsh web authentication required"）确认确实是 DSH，才采用；
//   4. 仍然没有就用第一个候选（DSH 还没起来时先按它重试，桥接在 DSH 不可用期间会定期重新识别）。

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';

export const DSH_CLI_PORT = 3080;
export const DSH_DESKTOP_PORT = 19387;

export function dshHomeDir(env = process.env) {
  return env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** 是否装了 DSH 桌面版；返回桌面版版本号或 null。只读 runtime.json / Info.plist，不碰凭据。 */
export function detectDshDesktop(env = process.env, { platform = process.platform } = {}) {
  const base = path.join(dshHomeDir(env), 'dsh-runtimes');
  try {
    for (const d of fs.readdirSync(base)) {
      try {
        const v = JSON.parse(fs.readFileSync(path.join(base, d, 'runtime.json'), 'utf8')).desktopVersion;
        if (v) return String(v);
      } catch {}
    }
  } catch {}
  if (platform === 'darwin') {
    try {
      const app = env.DSH_DESKTOP_APP || '/Applications/DeepSeek Harness.app';
      const plist = fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8');
      const v = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
      if (v) return String(v);
    } catch {}
  }
  return null;
}

/** 候选地址（按优先级）。configured 非空时只有它一个。 */
export function dshBaseUrlCandidates(configured, env = process.env) {
  const c = String(configured ?? '').trim();
  if (c) return [c.replace(/\/+$/, '')];
  const cli = `http://127.0.0.1:${DSH_CLI_PORT}`;
  const desktop = `http://127.0.0.1:${DSH_DESKTOP_PORT}`;
  return detectDshDesktop(env) ? [desktop, cli] : [cli, desktop];
}

function portOpen(url, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { resolve(false); return; }
    const s = net.connect({ host: u.hostname === 'localhost' ? '127.0.0.1' : u.hostname, port: Number(u.port) || 80 });
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

function run(file, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => resolve(error && !stdout ? '' : String(stdout ?? '')));
  });
}

/** 从 `lsof -Fn` 输出里取回环监听端口。 */
export function parseLsofPorts(text) {
  const out = new Set();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^n(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/.exec(line.trim());
    if (m) out.add(Number(m[1]));
  }
  return [...out];
}

/** 从 Windows `netstat -ano -p TCP` 输出里取指定 PID 的回环监听端口。 */
export function parseNetstatPorts(text, pids) {
  const want = new Set([...pids].map(String));
  const out = new Set();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*TCP\s+(?:127\.0\.0\.1|\[::1\]):(\d{1,5})\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
    if (m && want.has(m[2])) out.add(Number(m[1]));
  }
  return [...out];
}

/** 从 `tasklist /FO CSV /NH` 输出里取 DSH 桌面版进程的 PID。 */
export function parseTasklistPids(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^"(DeepSeek Harness[^"]*\.exe)","(\d+)"/i.exec(line.trim());
    if (m) out.push(m[2]);
  }
  return out;
}

// 控制中心每 2.5 秒刷新一次状态：默认实现缓存 10 秒，避免频繁起 lsof / netstat 进程。
let portCache = { at: 0, ports: [] };
const PORT_CACHE_MS = 10_000;

/** DSH 桌面版进程正在监听的回环端口（取不到返回 []）。只读系统信息，不碰 DSH 的任何文件。 */
export async function listDesktopListenPorts({ platform = process.platform, exec = null, timeoutMs = 3000 } = {}) {
  if (!exec && Date.now() - portCache.at < PORT_CACHE_MS) return portCache.ports;
  const ports = await listDesktopListenPortsUncached({ platform, exec: exec ?? run, timeoutMs });
  if (!exec) portCache = { at: Date.now(), ports };
  return ports;
}

async function listDesktopListenPortsUncached({ platform, exec, timeoutMs }) {
  try {
    if (platform === 'darwin') {
      return parseLsofPorts(await exec('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-c', 'DeepSeek', '-Fn'], timeoutMs));
    }
    if (platform === 'win32') {
      const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
      const pids = parseTasklistPids(await exec(path.join(sys32, 'tasklist.exe'), ['/FO', 'CSV', '/NH'], timeoutMs));
      if (!pids.length) return [];
      return parseNetstatPorts(await exec(path.join(sys32, 'netstat.exe'), ['-ano', '-p', 'TCP'], timeoutMs), pids);
    }
  } catch {}
  return [];
}

/** 桥接自己的回环端口，动态发现时跳过（避免对自己的服务发 HTTP 探测）。 */
export const DEFAULT_SKIP_PORTS = [8787, 8790];

/** 从 `netstat -ano -p TCP` 输出里取**全部**回环监听端口（不按进程归属筛）。 */
export function parseAnyLoopbackPorts(text) {
  const out = new Set();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*TCP\s+(?:127\.0\.0\.1|\[::1\]):(\d{1,5})\s+\S+\s+LISTENING\s+\d+\s*$/i.exec(line);
    if (m) out.add(Number(m[1]));
  }
  return [...out];
}

/**
 * 本机全部回环监听端口。桌面版把 web 服务放在 helper 子进程里时，按主进程
 * PID 取端口会得到空集；这一层不看 PID，交给 `looksLikeDsh` 逐个确认。
 */
export async function listLoopbackListenPorts({ platform = process.platform, exec = null, timeoutMs = 3000 } = {}) {
  const call = exec ?? ((file, args) => run(file, args, timeoutMs));
  try {
    if (platform === 'win32') {
      const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
      return parseAnyLoopbackPorts(await call(path.join(sys32, 'netstat.exe'), ['-ano', '-p', 'TCP']));
    }
    if (platform === 'darwin') {
      return parseLsofPorts(await call('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fn']));
    }
  } catch {}
  return [];
}

/** 未登录请求的特征：DSH 对没有凭据的请求回 401 + 固定提示文字。用它确认端口确实是 DSH。 */
export function looksLikeDsh(url, { timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL('/', url); } catch { resolve(false); return; }
    const req = http.get({ host: u.hostname, port: u.port, path: '/', timeout: timeoutMs, headers: { accept: 'text/plain' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 4096) body += c; });
      res.on('end', () => resolve(res.statusCode === 401 && /dsh web authentication required/i.test(body)));
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

/**
 * @returns {Promise<{url:string, auto:boolean, reachable:boolean, discovered?:boolean, candidates:string[]}>}
 */
export async function resolveDshBaseUrl(configured, {
  env = process.env,
  timeoutMs = 800,
  discover = true,
  listPorts = listDesktopListenPorts,
  anyPorts = listLoopbackListenPorts,
  skipPorts = DEFAULT_SKIP_PORTS,
  probe = looksLikeDsh,
} = {}) {
  const candidates = dshBaseUrlCandidates(configured, env);
  const auto = !String(configured ?? '').trim();
  for (const url of candidates) {
    if (await portOpen(url, timeoutMs)) return { url, auto, reachable: true, candidates };
  }
  if (auto && discover) {
    // Pass 1: only ports owned by the desktop process (cheap, precise).
    for (const port of await listPorts()) {
      const url = `http://127.0.0.1:${port}`;
      if (await probe(url)) return { url, auto, reachable: true, discovered: true, candidates };
    }
    // Pass 2: every loopback listener. Electron may run its web server in a
    // helper child process, so the main PID owns no port at all (observed
    // 2026-10-24: pet-revive logged "DSH unreachable" while 7642 was serving).
    // The 401 fingerprint keeps this from adopting an unrelated service.
    if (anyPorts) {
      const skip = new Set([...(skipPorts ?? [])].map(Number));
      const ports = (await anyPorts()).map(Number).filter((port) => Number.isFinite(port) && !skip.has(port));
      const BATCH = 8;
      for (let index = 0; index < ports.length; index += BATCH) {
        const batch = ports.slice(index, index + BATCH);
        const hits = await Promise.all(batch.map(async (port) => ({ port, ok: await probe(`http://127.0.0.1:${port}`) })));
        const hit = hits.find((item) => item.ok);
        if (hit) return { url: `http://127.0.0.1:${hit.port}`, auto, reachable: true, discovered: true, candidates };
      }
    }
  }
  return { url: candidates[0], auto, reachable: false, candidates };
}
