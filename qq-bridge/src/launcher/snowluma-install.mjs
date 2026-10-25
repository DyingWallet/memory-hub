// SnowLuma 安装目录的识别、版本检查与「更新数据迁移」。
//
// 合规边界（SnowLuma EULA v1.1 §5.4，中文为准）：
//   「将其并入第三方安装包或 Docker 镜像、通过自动化脚本部署……均须事先取得书面授权。」
// 所以这里：
//   ✅ 读取用户自己安装的 SnowLuma 目录里的 package.json / config/runtime.json（只读）；
//   ✅ 查询 GitHub 上 SnowLuma 的最新 Release 版本号，给出官方下载页链接；
//   ✅ 用户自己下载、解压新版本后，把**用户数据**（config/、data/）备份并复制到新目录；
//   ❌ 不下载、不解压、不复制、不修改 SnowLuma 的任何程序文件或专有组件（native/*.node/.dll）；
//   ❌ 不自动启动 —— 启动只在用户点击「启动 SnowLuma」时发生（见 control-center.mjs）。
//
// 发行包布局（对照 1.14.22 与 2.0.3 的发行包核对）：
//   · Windows：launcher.bat；完整版自带 node.exe。
//   · Linux（2.0 起正式支持 x64 / arm64）：launcher.sh；完整版自带 ./node。
//   · 2.0 起 package.json 写明 engines.node（>=24），release.json 写明目标平台（win-x64 / linux-x64 / linux-arm64）。
//   · 账号配置的位置和格式两版相同：config/onebot_<QQ号>.json 的 networks.wsServers。
//
// SnowLuma 的数据位置（对照 1.14.22 源码 packages/common/src/runtime.ts 等，都是相对它的安装目录）：
//   config/   账号、OneBot 实例配置（onebot_<QQ号>.json）、runtime.json、WebUI 密码与证书
//   data/     按 QQ 号分的运行数据
//   logs/     日志（迁移时可选）
// AI 的记忆、人物库、会话在桥接的 state/ 与 DSH 的 .dsh 里，聊天记录在 QQ 客户端里 —— 都与 SnowLuma 版本无关。

import fs from 'node:fs';
import path from 'node:path';
import { pickDialog } from './pick-dialog.mjs';

export const SNOWLUMA_RELEASES_API = 'https://api.github.com/repos/SnowLuma/SnowLuma/releases/latest';
export const SNOWLUMA_RELEASES_PAGE = 'https://github.com/SnowLuma/SnowLuma/releases';
export const USER_DATA_DIRS = ['config', 'data'];

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

/** 比较 1.14.22 这样的版本号；返回 -1 / 0 / 1。 */
export function compareVersions(a, b) {
  const pa = String(a ?? '').replace(/^v/i, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b ?? '').replace(/^v/i, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** 本机对应的 SnowLuma 发行包目标名（win-x64 / linux-x64 / linux-arm64）；没有对应发行包的系统返回 null。 */
export function snowlumaTargetFor(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return 'win-x64';
  if (platform === 'linux') return arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
  return null;
}

/** 从 engines.node（如 ">=24"、">=22.13.0"）读出最低主版本号；读不出返回 null。 */
export function minNodeMajor(range) {
  const m = /(\d+)/.exec(String(range ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * 检查一个目录是不是 SnowLuma 的发行包目录。
 * @returns {{ok:boolean, error?:string, dir, version, edition:'full'|'lite', hasNodeExe, hasNodeBin, launcher, launchers:{bat,sh},
 *   nodeRequirement, nodeOk, target, targetOk, webui:{host,port}, dataDirs:string[]}}
 */
export function inspectSnowLumaDir(dir, { platform = process.platform, arch = process.arch, nodeVersion = process.versions.node } = {}) {
  const d = path.resolve(String(dir ?? ''));
  if (!dir || !fs.existsSync(d) || !fs.statSync(d).isDirectory()) return { ok: false, error: '目录不存在' };
  const pkg = readJson(path.join(d, 'package.json'));
  if (!pkg || pkg.name !== '@snowluma/runtime') {
    return { ok: false, error: '这不是 SnowLuma 的发行包目录（找不到 name 为 @snowluma/runtime 的 package.json）。请选择解压后含 launcher.bat（Windows）或 launcher.sh（Linux）、index.mjs 的那一层目录。' };
  }
  const bat = path.join(d, 'launcher.bat');
  const sh = path.join(d, 'launcher.sh');
  const launchers = { bat: fs.existsSync(bat) ? bat : null, sh: fs.existsSync(sh) ? sh : null };
  // 本机用哪个启动脚本：Linux 用 launcher.sh；其他系统沿用原来的 launcher.bat（Windows / macOS 行为不变）
  const launcher = platform === 'linux' ? launchers.sh : launchers.bat;
  const entry = path.join(d, 'index.mjs');
  if (!fs.existsSync(entry)) return { ok: false, error: '目录里缺少 index.mjs' };
  const hasNodeExe = fs.existsSync(path.join(d, 'node.exe'));
  const hasNodeBin = (() => { try { return fs.statSync(path.join(d, 'node')).isFile(); } catch { return false; } })();
  const bundledNode = platform === 'win32' ? hasNodeExe : hasNodeBin;
  // Node 版本要求：2.0 起写在 engines.node；Lite 版用本机 node，版本不够时启动前就说明
  const nodeRequirement = typeof pkg.engines?.node === 'string' ? pkg.engines.node : null;
  const need = minNodeMajor(nodeRequirement);
  const have = Number(String(nodeVersion ?? '').split('.')[0]) || 0;
  const nodeOk = bundledNode || need === null ? true : have >= need;
  // 目标平台：2.0 起写在 release.json；与本机不符（例如在 Linux 上选了 Windows 包）时启动前就说明
  const release = readJson(path.join(d, 'release.json'));
  const target = typeof release?.target === 'string' ? release.target : null;
  const wantTarget = snowlumaTargetFor(platform, arch);
  // Windows 包的 release.json 写的是 win32-x64（下载文件名里是 win-x64），两种写法都认
  const norm = (t) => String(t ?? '').replace(/^win32-/, 'win-');
  const targetOk = target === null || wantTarget === null ? null : norm(target) === wantTarget;
  const runtime = readJson(path.join(d, 'config', 'runtime.json')) ?? {};
  const port = Number(runtime.webuiPort) > 0 && Number(runtime.webuiPort) < 65536 ? Number(runtime.webuiPort) : 5099;
  const host = typeof runtime.webuiHost === 'string' && runtime.webuiHost ? runtime.webuiHost : '127.0.0.1';
  const tls = !!runtime.webuiTls?.enabled;
  return {
    ok: true,
    dir: d,
    version: String(pkg.version ?? '未知'),
    edition: bundledNode || hasNodeExe || hasNodeBin ? 'full' : 'lite',
    hasNodeExe,
    hasNodeBin,
    launcher,
    launchers,
    nodeRequirement,
    nodeOk,
    target,
    targetOk,
    expectedTarget: wantTarget,
    webui: { host, port, url: `${tls ? 'https' : 'http'}://${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host}:${port}/` },
    dataDirs: USER_DATA_DIRS.filter((x) => fs.existsSync(path.join(d, x))),
    accounts: (() => {
      try { return fs.readdirSync(path.join(d, 'config')).map((n) => /^onebot_(\d+)\.json$/.exec(n)?.[1]).filter(Boolean); } catch { return []; }
    })(),
  };
}

/**
 * 启动命令：按 SnowLuma 自带的启动脚本原样运行（脚本自己先校验 Node 版本，再 node ./index.mjs），不改任何文件。
 *   · Windows：cmd.exe /c launcher.bat（完整版用包里的 node.exe，Lite 版用系统 PATH 里的 node）；
 *   · Linux：bash ./launcher.sh（优先用包里的 ./node，没有就用 PATH 里的 node）。
 * 发行包与本机平台不符、或 Lite 版而本机 Node 版本不够时，不启动并说明原因。
 */
export function snowlumaLaunchSpec(info, { platform = process.platform, nodeVersion = process.versions.node } = {}) {
  if (!info?.ok) return { error: info?.error ?? '未选择 SnowLuma 目录' };
  if (info.targetOk === false) {
    return { error: `这个 SnowLuma 发行包是 ${info.target} 版，本机需要 ${info.expectedTarget ?? '（本系统没有 SnowLuma 发行包）'} 版：请到 SnowLuma 发布页下载对应的包` };
  }
  if (info.nodeOk === false) {
    return { error: `这个 SnowLuma Lite 版需要 Node.js ${info.nodeRequirement}，本机是 ${nodeVersion}：请安装更新的 Node.js，或改用自带 Node 的完整版` };
  }
  if (platform === 'linux' && info.launcher) {
    return { command: 'bash', args: ['./launcher.sh'], cwd: info.dir, display: `${path.join(info.dir, 'launcher.sh')}` };
  }
  if (info.launcher && platform === 'win32') {
    return {
      command: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
      args: ['/d', '/s', '/c', 'launcher.bat'],
      cwd: info.dir,
      display: `${path.join(info.dir, 'launcher.bat')}`,
    };
  }
  const node = info.hasNodeExe ? path.join(info.dir, 'node.exe') : 'node';
  return { command: node, args: ['./index.mjs'], cwd: info.dir, display: `${node} ./index.mjs（${info.dir}）` };
}

/**
 * 一个 SnowLuma 目录里有哪些用户数据（只看文件是否存在，不读内容）：
 *   accounts：config/onebot_<QQ号>.json 里的 QQ 号；webui：config/webui.json（WebUI 登录密码）；data：data/ 里有没有东西。
 */
export function snowlumaDataSummary(dir) {
  const d = path.resolve(String(dir ?? ''));
  let accounts = [];
  try { accounts = fs.readdirSync(path.join(d, 'config')).map((n) => /^onebot_(\d+)\.json$/.exec(n)?.[1]).filter(Boolean); } catch {}
  let data = false;
  try { data = fs.readdirSync(path.join(d, 'data')).length > 0; } catch {}
  return { accounts, webui: fs.existsSync(path.join(d, 'config', 'webui.json')), data };
}

/**
 * 换到新的 SnowLuma 目录前要不要提醒「先迁移数据」：旧目录有账号配置或 WebUI 密码，而新目录两样都没有。
 * 直接换过去的后果：SnowLuma 当成全新安装 —— 生成新的随机 WebUI 密码（旧密码失效）、要重新扫码登录、
 * 重新开 OneBot WebSocket，接口平台也找不到原来的账号。返回 null（不用提醒）或 { oldDir, newDir, old, new, text }。
 */
export function migrationWarning({ oldDir, newDir }) {
  if (!oldDir || !newDir) return null;
  const a = path.resolve(String(oldDir));
  const b = path.resolve(String(newDir));
  if (a.toLowerCase() === b.toLowerCase() || !fs.existsSync(a)) return null;
  const old = snowlumaDataSummary(a);
  const neu = snowlumaDataSummary(b);
  const oldHas = old.accounts.length > 0 || old.webui;
  const newHas = neu.accounts.length > 0 || neu.webui;
  if (!oldHas || newHas) return null;
  const items = [
    old.accounts.length ? `${old.accounts.length} 个账号的 OneBot 配置` : null,
    old.webui ? 'WebUI 登录密码' : null,
    old.data ? '运行数据（data/）' : null,
  ].filter(Boolean).join('、');
  return {
    oldDir: a,
    newDir: b,
    old,
    new: neu,
    text: `新目录里还没有你的数据，旧目录里有：${items}。直接切换的话，SnowLuma 会当成全新安装：生成新的随机 WebUI 密码（浏览器里保存的旧密码会失效）、要重新扫码登录、重新开启 OneBot WebSocket，接口平台也找不到原来的账号。建议先用「更新助手」把旧目录的 config/、data/ 迁移过去（会先备份，旧目录原样保留）。`,
  };
}

/** 查询最新 Release（只读）。 */
export async function checkSnowLumaUpdate(currentVersion, { fetchImpl = globalThis.fetch, timeoutMs = 10000, platform = process.platform, arch = process.arch } = {}) {
  const res = await fetchImpl(SNOWLUMA_RELEASES_API, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'qq-bridge-enhanced-control-center' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`GitHub API 返回 HTTP ${res.status}`);
  const rel = await res.json();
  const latest = String(rel.tag_name ?? '').replace(/^v/i, '');
  const assets = Array.isArray(rel.assets) ? rel.assets.map((a) => String(a.name ?? '')) : [];
  return {
    current: currentVersion ?? null,
    latest: latest || null,
    updateAvailable: !!latest && !!currentVersion && compareVersions(latest, currentVersion) > 0,
    publishedAt: rel.published_at ?? null,
    pageUrl: rel.html_url || SNOWLUMA_RELEASES_PAGE,
    notes: String(rel.body ?? '').slice(0, 4000),
    // 只告诉用户该下载哪个文件（本机对应平台的完整版，不含 lite），不下载。Windows：win-x64.zip；Linux：linux-x64 / linux-arm64 .tar.gz
    suggestedAsset: (() => {
      const t = snowlumaTargetFor(platform, arch) ?? 'win-x64';
      const ext = t.startsWith('win') ? '\\.zip' : '\\.tar\\.gz';
      const re = new RegExp(`${t}${ext}$`, 'i');
      return assets.find((n) => re.test(n) && !/lite/i.test(n)) ?? null;
    })(),
    archive: (snowlumaTargetFor(platform, arch) ?? 'win-x64').startsWith('win') ? 'zip' : 'tar.gz',
  };
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const t = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDir(s, t);
    else if (ent.isFile()) fs.copyFileSync(s, t);
  }
}

function countFiles(dir) {
  let n = 0;
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) n += ent.isDirectory() ? countFiles(path.join(dir, ent.name)) : 1;
  } catch {}
  return n;
}

/**
 * 「更新数据迁移」：把旧 SnowLuma 目录的用户数据带到用户已经解压好的新版本目录。
 *   1. 校验两个目录都是 SnowLuma、新目录版本不低于旧目录、两者不是同一个目录；
 *   2. 把旧目录的 config/、data/（可选 logs/）完整备份到 backupRoot/<时间>/；
 *   3. 新目录里如已有同名目录，先改名为 .before-migrate-<时间> 保留（不删除）；
 *   4. 复制旧数据到新目录；校验文件数一致。
 * 只碰用户数据目录，不碰任何程序文件。调用方负责确保 SnowLuma 已停止。
 */
export function migrateSnowLumaData({ fromDir, toDir, backupRoot, includeLogs = false, now = Date.now }) {
  const from = inspectSnowLumaDir(fromDir);
  const to = inspectSnowLumaDir(toDir);
  if (!from.ok) return { ok: false, error: `旧目录无效：${from.error}` };
  if (!to.ok) return { ok: false, error: `新目录无效：${to.error}` };
  if (path.resolve(from.dir).toLowerCase() === path.resolve(to.dir).toLowerCase()) return { ok: false, error: '新旧目录是同一个' };
  if (compareVersions(to.version, from.version) < 0) return { ok: false, error: `新目录版本 ${to.version} 低于旧目录 ${from.version}，不迁移（防止降级覆盖）` };
  const dirs = [...USER_DATA_DIRS, ...(includeLogs ? ['logs'] : [])].filter((x) => fs.existsSync(path.join(from.dir, x)));
  if (!dirs.length) return { ok: false, error: '旧目录里没有可迁移的数据（config/、data/ 都不存在）' };
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(backupRoot, `snowluma-${from.version}-${stamp}`);
  for (const x of dirs) copyDir(path.join(from.dir, x), path.join(backupDir, x));
  const moved = [];
  for (const x of dirs) {
    const target = path.join(to.dir, x);
    if (fs.existsSync(target)) {
      const keep = `${target}.before-migrate-${stamp}`;
      fs.renameSync(target, keep);
      moved.push(path.basename(keep));
    }
    copyDir(path.join(from.dir, x), target);
  }
  const check = dirs.map((x) => ({ dir: x, source: countFiles(path.join(from.dir, x)), copied: countFiles(path.join(to.dir, x)) }));
  const okCount = check.every((c) => c.source === c.copied);
  return { ok: okCount, error: okCount ? undefined : '复制后文件数不一致，请检查（旧目录和备份都还在）', from: from.version, to: to.version, dirs, backupDir, keptInNewDir: moved, check };
}

/** 系统原生「选择文件夹」窗口（Windows / macOS，只在用户点击按钮时调用）。返回所选路径或 null。实现见 pick-dialog.mjs。 */
export function pickFolderDialog({ initialDir = '', title = '选择 SnowLuma 的解压目录（含 launcher.bat 的那一层）' } = {}) {
  return pickDialog({ kind: 'folder', title, initialDir });
}
