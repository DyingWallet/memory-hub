// NapCat 的识别与启动参数（只供控制中心在**用户点击**时使用；桥接、MCP、AI、接口平台都没有途径调用）。
//
// 控制中心不安装、不下载、不修改 NapCat 或 QQ —— 入口切换由用户自己用 NapCat 官方安装器完成。
//   · macOS：NapCat 安装器把 QQ.app 的 package.json main 改成 NapCat 的 loadNapCat.js；之后以
//            `QQ.app/Contents/MacOS/QQ --no-sandbox` 启动即运行 NapCat（日志与登录二维码打印在标准输出）。
//   · Windows：由用户在设置里指定 NapCat 的启动文件（NapCat.Shell 包里的 .bat / .exe），按原样运行。
//   · Linux：同样由用户指定启动文件（NapCat 安装脚本装好后的启动脚本 .sh，或可执行文件），按原样运行；
//            无图形界面的服务器上通常是 NapCat 文档里那条 xvfb-run … qq --no-sandbox 的命令，写进一个 .sh 再选它。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const NAPCAT_DEFAULT_WEBUI_PORT = 6099;

function macQQApp(settings) { return settings.napcatQQApp || '/Applications/QQ.app'; }

/** NapCat 的数据/配置目录默认位置（接口平台的 NapCat 实例按它发现账号）。 */
// 顺序：设置里的 napcatHome > 环境变量 QQ_BRIDGE_NAPCAT_HOME > 系统默认位置。
// 离线测试用环境变量替换掉默认位置，绝不碰真实的 QQ 沙盒容器
// （macOS 上读那里要过「访问其他 App 的数据」授权，测试进程读它会弹窗并卡住）。
export function napcatDefaultHome(settings = {}) {
  if (settings.napcatHome) return settings.napcatHome;
  if (process.env.QQ_BRIDGE_NAPCAT_HOME) return process.env.QQ_BRIDGE_NAPCAT_HOME;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Containers', 'com.tencent.qq', 'Data', 'Library', 'Application Support', 'QQ', 'NapCat');
  return '';
}

/** 快速登录：settings.napcatQuickLogin 填机器人 QQ 号时，加 NapCat 的 `-q <QQ号>`（用已保存的登录态，不用每次扫码）。 */
function quickLoginArgs(settings) {
  const q = String(settings.napcatQuickLogin ?? '').trim();
  return /^\d{5,12}$/.test(q) ? ['-q', q] : [];
}

/**
 * NapCat 自己的自动登录设置（<NapCat 目录>/config/webui.json 的 autoLoginAccount）。只读这一个字段。
 * 结果缓存 10 分钟：macOS 上这个目录在 QQ 的沙盒容器里，每次读都要过系统的「访问其他 App 的数据」检查，
 * 页面每次刷新状态都读会反复弹授权窗。
 */
const AUTO_LOGIN_TTL_MS = 10 * 60_000;
const autoLoginCache = new Map(); // home -> { at, value }
export function napcatAutoLoginAccount(settings = {}, { now = Date.now(), read = fs.readFileSync } = {}) {
  const home = napcatDefaultHome(settings);
  if (!home) return '';
  const hit = autoLoginCache.get(home);
  if (hit && now - hit.at < AUTO_LOGIN_TTL_MS) return hit.value;
  let value = '';
  try {
    const v = String(JSON.parse(read(path.join(home, 'config', 'webui.json'), 'utf8'))?.autoLoginAccount ?? '').trim();
    value = /^\d{5,12}$/.test(v) ? v : '';
  } catch {}
  autoLoginCache.set(home, { at: now, value });
  return value;
}

/** 检查本机 NapCat 是否可由控制中心启动。返回 { ok, error?, command, args, entry? }。 */
export function inspectNapCat(settings = {}, { platform = process.platform } = {}) {
  if (platform === 'darwin') {
    const app = macQQApp(settings);
    const bin = path.join(app, 'Contents', 'MacOS', 'QQ');
    if (!fs.existsSync(bin)) return { ok: false, error: `找不到 QQ：${app}` };
    let main = '';
    try { main = String(JSON.parse(fs.readFileSync(path.join(app, 'Contents', 'Resources', 'app', 'package.json'), 'utf8')).main ?? ''); } catch {}
    if (!/napcat/i.test(main)) return { ok: false, error: 'QQ 的程序入口还是原版 QQ：请先用 NapCat 安装器点「切换程序入口「NapCat」」（控制中心不会替你修改 QQ）', command: bin, args: ['--no-sandbox'], entry: 'qq' };
    const args = ['--no-sandbox', ...quickLoginArgs(settings)];
    return { ok: true, command: bin, args, entry: 'napcat', quickLogin: args.includes('-q') || !!napcatAutoLoginAccount(settings), display: `${bin} ${args.join(' ')}` };
  }
  if (platform === 'win32') {
    const cmd = String(settings.napcatCommand ?? '').trim();
    if (!cmd) return { ok: false, error: '还没有设置 NapCat 启动文件（state/control-center.json 的 napcatCommand，指向 NapCat.Shell 包里的启动 .bat / .exe）' };
    if (!fs.existsSync(cmd)) return { ok: false, error: `找不到 NapCat 启动文件：${cmd}` };
    const q = quickLoginArgs(settings);
    if (/\.(bat|cmd)$/i.test(cmd)) return { ok: true, command: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'), args: ['/d', '/c', cmd, ...q], cwd: path.dirname(cmd), quickLogin: q.length > 0, display: [cmd, ...q].join(' ') };
    return { ok: true, command: cmd, args: q, cwd: path.dirname(cmd), quickLogin: q.length > 0, display: [cmd, ...q].join(' ') };
  }
  if (platform === 'linux') {
    const cmd = String(settings.napcatCommand ?? '').trim();
    if (!cmd) return { ok: false, error: '还没有设置 NapCat 启动文件：在「NapCat 设置」里选择启动 NapCat 的 .sh 脚本或可执行文件（也可以自己启动 NapCat，接口平台照样可以连接）' };
    if (!fs.existsSync(cmd)) return { ok: false, error: `找不到 NapCat 启动文件：${cmd}` };
    const q = quickLoginArgs(settings);
    if (/\.sh$/i.test(cmd)) return { ok: true, command: 'bash', args: [cmd, ...q], cwd: path.dirname(cmd), quickLogin: q.length > 0 || !!napcatAutoLoginAccount(settings), display: [cmd, ...q].join(' ') };
    return { ok: true, command: cmd, args: q, cwd: path.dirname(cmd), quickLogin: q.length > 0 || !!napcatAutoLoginAccount(settings), display: [cmd, ...q].join(' ') };
  }
  return { ok: false, error: '当前系统没有内置 NapCat 启动方式：请自己启动 NapCat，接口平台照样可以连接' };
}

/** createManagedProcess 的 resolveLaunch 形状。 */
export function napcatLaunchSpec(info) {
  if (!info.ok) return { error: info.error };
  return { command: info.command, args: info.args, cwd: info.cwd ?? path.dirname(info.command), env: {}, display: info.display };
}

// ── 版本与更新检测（只提示，不下载、不安装）──────────────────────────────────

export const NAPCAT_RELEASES_API = 'https://api.github.com/repos/NapNeko/NapCatQQ/releases/latest';
export const NAPCAT_RELEASES_PAGE = 'https://github.com/NapNeko/NapCatQQ/releases';
// macOS 用 NapCat 的 Mac 安装器更新（它负责替换 NapCat 文件、切换 QQ 入口）
export const NAPCAT_MAC_INSTALLER_PAGE = 'https://github.com/NapNeko/NapCat-Mac-Installer/releases';

/** 版本号比较（同 SnowLuma：忽略前缀 v，按 . 和 - 分段比较数字）。 */
export function compareNapCatVersions(a, b) {
  const pa = String(a ?? '').replace(/^v/i, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b ?? '').replace(/^v/i, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * 从文件读 NapCat 版本（不需要 NapCat 在运行）。只在 Windows 上读：启动文件所在目录（及其 napcat/ 子目录）的 package.json。
 * macOS 上 NapCat 的文件在 QQ 的沙盒容器里，读它要过「访问其他 App 的数据」授权 —— 不为显示版本去读，改用运行中的版本。
 */
export function napcatFileVersion(settings = {}, { platform = process.platform, read = fs.readFileSync } = {}) {
  // Windows 与 Linux 都按启动文件旁的 package.json 读；macOS 的 NapCat 在 QQ 沙盒容器里，不读
  if (platform !== 'win32' && platform !== 'linux') return null;
  const cmd = String(settings.napcatCommand ?? '').trim();
  if (!cmd) return null;
  const dir = path.dirname(cmd);
  for (const f of [path.join(dir, 'package.json'), path.join(dir, 'napcat', 'package.json')]) {
    try {
      const j = JSON.parse(read(f, 'utf8'));
      if (/napcat/i.test(String(j?.name ?? '')) && j?.version) return String(j.version).slice(0, 40);
    } catch {}
  }
  return null;
}

/** 运行中的版本：接口平台链路上后端自报的 get_version_info（appName 含 NapCat 的那条）。 */
export function napcatRuntimeVersion(overview) {
  for (const inst of overview?.instances ?? []) {
    for (const l of inst.links ?? []) {
      if (/napcat/i.test(String(l.backend?.appName ?? '')) && l.backend?.appVersion) return String(l.backend.appVersion);
    }
  }
  return null;
}

/** 检查 NapCat 新版本（GitHub 最新 Release）。只返回信息，不下载。 */
export async function checkNapCatUpdate(currentVersion, { fetchImpl = globalThis.fetch, timeoutMs = 10000, platform = process.platform } = {}) {
  const res = await fetchImpl(NAPCAT_RELEASES_API, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'qq-bridge-enhanced-control-center' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`GitHub API 返回 HTTP ${res.status}`);
  const rel = await res.json();
  const latest = String(rel.tag_name ?? '').replace(/^v/i, '');
  const assets = Array.isArray(rel.assets) ? rel.assets.map((a) => String(a.name ?? '')) : [];
  const mac = platform === 'darwin';
  const linux = platform === 'linux';
  return {
    current: currentVersion ?? null,
    latest: latest || null,
    updateAvailable: !!latest && !!currentVersion && compareNapCatVersions(latest, currentVersion) > 0,
    publishedAt: rel.published_at ?? null,
    // macOS 走 Mac 安装器；Windows 下 NapCat.Shell（一键包优先）
    pageUrl: mac ? NAPCAT_MAC_INSTALLER_PAGE : (rel.html_url || NAPCAT_RELEASES_PAGE),
    releaseUrl: rel.html_url || NAPCAT_RELEASES_PAGE,
    notes: String(rel.body ?? '').slice(0, 4000),
    suggestedAsset: mac ? null : linux ? (assets.find((n) => /^NapCat\.Shell\.zip$/i.test(n)) ?? null) : (assets.find((n) => /^NapCat\.Shell\.Windows\.OneKey\.zip$/i.test(n)) ?? assets.find((n) => /^NapCat\.Shell\.zip$/i.test(n)) ?? null),
    howTo: mac
      ? '用 NapCat Mac 安装器安装新版本（它会替换 NapCat 文件；登录态和 onebot11 配置在 QQ 容器里，不受影响）。安装前先在这里停止 NapCat，装好后再启动。'
      : linux
      ? '用 NapCat 官方的 Linux 安装脚本（或 Docker 镜像）更新到新版本；先在这里停止 NapCat，更新后检查 NapCat 目录里的 config/ 还在，再启动。'
      : '下载新版 NapCat.Shell，解压到一个新文件夹；先在这里停止 NapCat，把旧目录的 config/ 复制到新目录，再在「NapCat 设置」里把启动文件改成新目录里的那个。',
  };
}

// ── 用户在页面上改 NapCat 的位置设置 ─────────────────────────────────────────

/**
 * 校验并整理用户填写的 NapCat 设置（只校验，不保存）。空字符串 = 恢复默认。
 * @returns {{ok:true, patch:object, notes:string[]} | {ok:false, error:string}}
 */
export function validateNapCatSettings(input = {}, { platform = process.platform, exists = fs.existsSync, readdir = fs.readdirSync } = {}) {
  const patch = {};
  const notes = [];
  const str = (v) => String(v ?? '').trim();
  if ('qqApp' in input) {
    const v = str(input.qqApp);
    if (v && platform !== 'darwin') return { ok: false, error: 'QQ.app 只在 macOS 上使用' };
    if (v && !exists(path.join(v, 'Contents', 'MacOS', 'QQ'))) return { ok: false, error: `不是 QQ 程序：${v}（应选择 QQ.app）` };
    patch.napcatQQApp = v;
  }
  if ('command' in input) {
    const v = str(input.command);
    if (v && platform === 'darwin') return { ok: false, error: 'macOS 上不需要启动文件：选择 QQ.app 即可（QQ 的入口已由 NapCat 安装器切换）' };
    if (v && platform !== 'linux' && !/\.(bat|cmd|exe)$/i.test(v)) return { ok: false, error: '启动文件应是 NapCat.Shell 包里的 .bat / .cmd / .exe' };
    // Linux：.sh 脚本，或没有扩展名的可执行文件
    if (v && platform === 'linux' && /\.(bat|cmd|exe)$/i.test(v)) return { ok: false, error: '这是 Windows 的启动文件：Linux 上请选择 NapCat 的 .sh 启动脚本或可执行文件' };
    if (v && !exists(v)) return { ok: false, error: `找不到启动文件：${v}` };
    patch.napcatCommand = v;
  }
  if ('home' in input) {
    const v = str(input.home);
    if (v) {
      if (!exists(v)) return { ok: false, error: `找不到目录：${v}` };
      let found = false;
      for (const d of [path.join(v, 'config'), v]) {
        try { if (readdir(d).some((n) => /^onebot11_\d+\.json$/i.test(n))) { found = true; break; } } catch {}
      }
      if (!found) notes.push('这个目录里还没有 onebot11_<QQ号>.json：NapCat 登录并开启 WebSocket 服务端后才会生成，接口平台到时会自动发现账号');
    }
    patch.napcatHome = v;
  }
  if ('quickLogin' in input) {
    const v = str(input.quickLogin);
    if (v && !/^\d{5,12}$/.test(v)) return { ok: false, error: '快速登录填机器人 QQ 号（5～12 位数字），留空则不加 -q' };
    patch.napcatQuickLogin = v;
  }
  return { ok: true, patch, notes };
}

// ── 登录二维码（NapCat 写在 <NapCat 目录>/cache/qrcode.png）────────────────────

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const NAPCAT_QR_MAX_BYTES = 2 * 1024 * 1024;

/** 二维码可能的位置（只有这几个固定文件名，页面不能指定路径）。 */
export function napcatQrCandidates(settings = {}) {
  const out = [];
  const home = napcatDefaultHome(settings);
  if (home) out.push(path.join(home, 'cache', 'qrcode.png'));
  const cmd = String(settings.napcatCommand ?? '').trim();
  if (cmd) {
    const dir = path.dirname(cmd);
    out.push(path.join(dir, 'cache', 'qrcode.png'), path.join(dir, 'napcat', 'cache', 'qrcode.png'));
  }
  return [...new Set(out)];
}

/**
 * 是否在等扫码：NapCat 由控制中心启动并在运行、还没登录（接口平台没有它的在线链路），
 * 且本次启动后（允许 5 秒误差）写过新的 qrcode.png。只在这种情况下才去 stat 文件 —— macOS 上那是 QQ 的沙盒容器。
 * @returns {{waiting:boolean, file:string|null, updatedAt:number|null}}
 */
export function napcatQrStatus(settings = {}, { running = false, startedAt = null, loggedIn = false, stat = fs.statSync } = {}) {
  const none = { waiting: false, file: null, updatedAt: null };
  if (!running || loggedIn || !startedAt) return none;
  let best = null;
  for (const f of napcatQrCandidates(settings)) {
    try {
      const st = stat(f);
      if (st.isFile() && st.size > 0 && st.size <= NAPCAT_QR_MAX_BYTES && (!best || st.mtimeMs > best.mtimeMs)) best = { file: f, mtimeMs: st.mtimeMs };
    } catch {}
  }
  if (!best || best.mtimeMs < startedAt - 5000) return none;
  return { waiting: true, file: best.file, updatedAt: Math.round(best.mtimeMs) };
}

/** 读二维码图片：必须是 PNG、不超过 2MB；否则返回 null。 */
export function readNapCatQr(file, { read = fs.readFileSync } = {}) {
  try {
    const buf = read(file);
    if (!Buffer.isBuffer(buf) || buf.length > NAPCAT_QR_MAX_BYTES || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
    return buf;
  } catch { return null; }
}

/** 接口平台概览里 NapCat 是否已登录（有在线链路 = NapCat 已登录并开了 OneBot 服务）。 */
export function napcatLoggedIn(overview) {
  for (const inst of overview?.instances ?? []) {
    if (inst.provider !== 'napcat') continue;
    if ((inst.links ?? []).some((l) => l.state === 'open' && l.account)) return true;
  }
  return false;
}
