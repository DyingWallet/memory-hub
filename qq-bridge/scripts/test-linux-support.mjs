// Linux 支持（增量）离线测试：SnowLuma 2.x 的 Windows / Linux 发行包识别与启动、Node 要求、按平台的更新建议、
// Linux 的「浏览…」窗口、NapCat 在 Linux 上的启动与设置、systemd 用户服务；同时确认 Windows / macOS 原有行为不变。
// 全部假数据：假的发行包目录（只有 package.json / release.json / 空的启动脚本），不运行任何程序、不联网。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectSnowLumaDir, snowlumaLaunchSpec, checkSnowLumaUpdate, snowlumaTargetFor, minNodeMajor } from '../src/launcher/snowluma-install.mjs';
import { pickDialogSpec } from '../src/launcher/pick-dialog.mjs';
import { inspectNapCat, validateNapCatSettings, napcatFileVersion, checkNapCatUpdate } from '../src/launcher/napcat-launch.mjs';
import { serviceUnit, desktopEntry, buildLinuxService, SERVICE_NAME } from './build-linux-service.mjs';
import { PROVIDER as SNOW_PROVIDER } from '../interface-platform/src/connectors/qq-snowluma/index.mjs';
import { PROVIDER as NAP_PROVIDER } from '../interface-platform/src/connectors/qq-napcat/index.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-linux-'));

/** 假 SnowLuma 发行包：按 1.14.x（无 engines / release.json）或 2.x（engines >=24 + release.json）的布局。 */
function fakeSnow(dir, { version = '2.0.3', target = 'linux-x64', bundledNode = false, legacy = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@snowluma/runtime', version, ...(legacy ? {} : { engines: { node: '>=24' } }) }));
  fs.writeFileSync(path.join(dir, 'index.mjs'), '');
  const win = target.startsWith('win');
  fs.writeFileSync(path.join(dir, win ? 'launcher.bat' : 'launcher.sh'), '');
  if (!legacy) fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify({ version, target }));
  if (bundledNode) fs.writeFileSync(path.join(dir, win ? 'node.exe' : 'node'), '');
  return dir;
}

test('SnowLuma 2.x Linux 包：识别 launcher.sh、完整版自带 ./node、Node 要求 >=24、目标平台；用 bash ./launcher.sh 启动', () => {
  const d = tmp();
  const full = inspectSnowLumaDir(fakeSnow(path.join(d, 'full'), { bundledNode: true }), { platform: 'linux', arch: 'x64', nodeVersion: '22.23.3' });
  assert.equal(full.ok, true);
  assert.equal(full.edition, 'full');
  assert.equal(full.hasNodeBin, true);
  assert.equal(full.nodeRequirement, '>=24');
  assert.equal(full.nodeOk, true, '完整版自带 Node，不看本机版本');
  assert.equal(full.target, 'linux-x64');
  assert.equal(full.targetOk, true);
  assert.equal(path.basename(full.launcher), 'launcher.sh');
  const spec = snowlumaLaunchSpec(full, { platform: 'linux' });
  assert.deepEqual([spec.command, ...spec.args], ['bash', './launcher.sh']);
  assert.equal(spec.cwd, full.dir);
});

test('SnowLuma 启动前检查：Lite 版本机 Node 不够、发行包平台与本机不符时不启动并说明原因', () => {
  const d = tmp();
  const lite = inspectSnowLumaDir(fakeSnow(path.join(d, 'lite')), { platform: 'linux', arch: 'x64', nodeVersion: '22.23.3' });
  assert.equal(lite.edition, 'lite');
  assert.equal(lite.nodeOk, false);
  assert.match(snowlumaLaunchSpec(lite, { platform: 'linux', nodeVersion: '22.23.3' }).error, /需要 Node\.js >=24，本机是 22\.23\.3/);
  const lite24 = inspectSnowLumaDir(path.join(d, 'lite'), { platform: 'linux', arch: 'x64', nodeVersion: '24.1.0' });
  assert.equal(snowlumaLaunchSpec(lite24, { platform: 'linux' }).command, 'bash');
  const arm = inspectSnowLumaDir(path.join(d, 'lite'), { platform: 'linux', arch: 'arm64', nodeVersion: '24.1.0' });
  assert.equal(arm.targetOk, false);
  assert.match(snowlumaLaunchSpec(arm, { platform: 'linux' }).error, /linux-x64 版，本机需要 linux-arm64 版/);
  const winOnLinux = inspectSnowLumaDir(fakeSnow(path.join(d, 'win'), { target: 'win32-x64', bundledNode: true }), { platform: 'linux', arch: 'x64', nodeVersion: '24.1.0' });
  assert.match(snowlumaLaunchSpec(winOnLinux, { platform: 'linux' }).error, /win32-x64 版，本机需要 linux-x64 版/);
});

test('SnowLuma 在 Windows 上行为不变：2.x 包的 win32-x64 也算匹配，照旧 cmd.exe /c launcher.bat；1.14.x 旧包（无 engines / release.json）不受新检查影响', () => {
  const d = tmp();
  const v2 = inspectSnowLumaDir(fakeSnow(path.join(d, 'v2'), { target: 'win32-x64', bundledNode: true }), { platform: 'win32', arch: 'x64', nodeVersion: '22.23.3' });
  assert.equal(v2.targetOk, true, 'release.json 写的 win32-x64 与下载文件名里的 win-x64 等价');
  const s2 = snowlumaLaunchSpec(v2, { platform: 'win32' });
  assert.match(s2.command, /cmd\.exe$/i);
  assert.deepEqual(s2.args.slice(-1), ['launcher.bat']);
  const old = inspectSnowLumaDir(fakeSnow(path.join(d, 'old'), { version: '1.14.22', target: 'win-x64', bundledNode: true, legacy: true }), { platform: 'win32', arch: 'x64', nodeVersion: '22.23.3' });
  assert.deepEqual([old.nodeRequirement, old.nodeOk, old.target, old.targetOk], [null, true, null, null]);
  assert.deepEqual(snowlumaLaunchSpec(old, { platform: 'win32' }).args.slice(-1), ['launcher.bat']);
  // macOS：没有 SnowLuma 发行包，launcher 仍指向 launcher.bat（与原来一致），不做平台检查
  const mac = inspectSnowLumaDir(path.join(d, 'old'), { platform: 'darwin', arch: 'arm64' });
  assert.equal(path.basename(mac.launcher), 'launcher.bat');
  assert.equal(mac.targetOk, null);
  assert.equal(snowlumaTargetFor('darwin'), null);
  assert.deepEqual([minNodeMajor('>=24'), minNodeMajor('>=22.13.0'), minNodeMajor('')], [24, 22, null]);
});

test('SnowLuma 检查更新：按本机系统与架构建议完整版（Windows zip / Linux x64 或 arm64 tar.gz），不选 Lite', async () => {
  const names = ['linux-arm64-lite.tar.gz', 'linux-arm64.tar.gz', 'linux-x64-lite.tar.gz', 'linux-x64.tar.gz', 'win-x64-lite.zip', 'win-x64.zip'].map((n) => ({ name: `SnowLuma-v2.0.3-${n}` }));
  const fetchImpl = async () => ({ ok: true, json: async () => ({ tag_name: 'v2.0.3', assets: names }) });
  const get = async (platform, arch) => checkSnowLumaUpdate('1.14.22', { fetchImpl, platform, arch });
  assert.equal((await get('win32', 'x64')).suggestedAsset, 'SnowLuma-v2.0.3-win-x64.zip');
  assert.equal((await get('win32', 'x64')).archive, 'zip');
  assert.equal((await get('linux', 'x64')).suggestedAsset, 'SnowLuma-v2.0.3-linux-x64.tar.gz');
  assert.equal((await get('linux', 'arm64')).suggestedAsset, 'SnowLuma-v2.0.3-linux-arm64.tar.gz');
  assert.equal((await get('linux', 'arm64')).archive, 'tar.gz');
  assert.equal((await get('darwin', 'arm64')).suggestedAsset, 'SnowLuma-v2.0.3-win-x64.zip', 'macOS 沿用原来的建议');
});

test('Linux「浏览…」：有 zenity 用 zenity、否则 kdialog、都没有返回 null；标题与路径作为独立参数传入，不经过 shell', () => {
  const which = (have) => (n) => (have.includes(n) ? `/usr/bin/${n}` : null);
  const evil = '"; rm -rf ~; "';
  const z = pickDialogSpec({ platform: 'linux', kind: 'folder', title: evil, initialDir: '/opt/snow', which: which(['zenity', 'kdialog']), env: {} });
  assert.equal(z.command, '/usr/bin/zenity');
  assert.ok(z.args.includes('--directory'));
  assert.ok(z.args.includes(`--title=${evil}`), '标题是 execFile 的一个参数，不拼进命令行');
  assert.ok(z.args.includes('--filename=/opt/snow/'));
  const zf = pickDialogSpec({ platform: 'linux', kind: 'file', title: '选文件', extensions: ['sh'], which: which(['zenity']), env: {} });
  assert.ok(zf.args.includes('--file-filter=选文件 | *.sh'));
  const k = pickDialogSpec({ platform: 'linux', kind: 'folder', title: 't', which: which(['kdialog']), env: { HOME: '/home/u' } });
  assert.deepEqual([k.command, ...k.args], ['/usr/bin/kdialog', '--getexistingdirectory', '/home/u', '--title', 't']);
  assert.equal(pickDialogSpec({ platform: 'linux', which: which([]), env: {} }), null, '无图形界面：手动填路径');
  assert.equal(pickDialogSpec({ platform: 'darwin', kind: 'folder' }).command, '/usr/bin/osascript', 'macOS 不变');
});

test('NapCat 在 Linux：启动文件可以是 .sh（用 bash 运行）或可执行文件；拒绝 Windows 的 .bat/.exe；版本从启动文件旁读；更新建议 NapCat.Shell', async () => {
  const d = tmp();
  const sh = path.join(d, 'napcat.sh');
  fs.writeFileSync(sh, '#!/bin/bash\n');
  const bin = path.join(d, 'napcat');
  fs.writeFileSync(bin, '');
  const a = inspectNapCat({ napcatCommand: sh, napcatQuickLogin: '10001' }, { platform: 'linux' });
  assert.deepEqual([a.ok, a.command, ...a.args], [true, 'bash', sh, '-q', '10001']);
  assert.equal(a.cwd, d);
  assert.equal(inspectNapCat({ napcatCommand: bin }, { platform: 'linux' }).command, bin);
  assert.match(inspectNapCat({}, { platform: 'linux' }).error, /还没有设置 NapCat 启动文件/);
  assert.match(inspectNapCat({ napcatCommand: path.join(d, 'none.sh') }, { platform: 'linux' }).error, /找不到/);
  const o = { exists: (p) => p === sh || p === bin, readdir: () => [] };
  assert.deepEqual(validateNapCatSettings({ command: sh }, { platform: 'linux', ...o }).patch, { napcatCommand: sh });
  assert.deepEqual(validateNapCatSettings({ command: bin }, { platform: 'linux', ...o }).patch, { napcatCommand: bin });
  assert.match(validateNapCatSettings({ command: 'C:/n/napcat.bat' }, { platform: 'linux', exists: () => true, readdir: () => [] }).error, /Windows 的启动文件/);
  assert.match(validateNapCatSettings({ command: sh }, { platform: 'win32', ...o }).error, /\.bat/, 'Windows 规则不变');
  const read = (f) => { if (f === path.join(d, 'package.json')) return '{"name":"napcat","version":"4.18.38"}'; throw Object.assign(new Error('x'), { code: 'ENOENT' }); };
  assert.equal(napcatFileVersion({ napcatCommand: sh }, { platform: 'linux', read }), '4.18.38');
  const fetchImpl = async () => ({ ok: true, json: async () => ({ tag_name: 'v4.19.0', html_url: 'https://github.com/NapNeko/NapCatQQ/releases/tag/v4.19.0', assets: [{ name: 'NapCat.Shell.zip' }, { name: 'NapCat.Shell.Windows.OneKey.zip' }] }) });
  const u = await checkNapCatUpdate('4.18.38', { fetchImpl, platform: 'linux' });
  assert.equal(u.suggestedAsset, 'NapCat.Shell.zip');
  assert.match(u.howTo, /Linux 安装脚本/);
  assert.equal((await checkNapCatUpdate('4.18.38', { fetchImpl, platform: 'win32' })).suggestedAsset, 'NapCat.Shell.Windows.OneKey.zip', 'Windows 不变');
});

test('Linux 无窗口启动：systemd 用户服务（--no-open、崩溃重启、只先通知控制中心）+ 桌面启动项；路径带空格也正确引用；文件写在用户目录', () => {
  const unit = serviceUnit({ root: '/home/u/qq bridge', node: '/usr/bin/node', pathEnv: '/usr/bin' });
  assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/home\/u\/qq bridge\/src\/launcher\/control-center\.mjs" --no-open/);
  assert.match(unit, /WorkingDirectory="\/home\/u\/qq bridge"/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /KillMode=mixed/);
  assert.match(unit, /WantedBy=default\.target/);
  assert.ok(!/SnowLuma|napcat|bridge\.js/i.test(unit.replace(/qq-bridge|qq bridge|QQ 后端/g, '')), '服务只启动控制中心本身');
  assert.match(serviceUnit({ root: '/a%b', node: '/n' }), /WorkingDirectory="\/a%%b"/, 'systemd 的 % 要转义');
  const desk = desktopEntry({ root: '/home/u/qq bridge', node: '/usr/bin/node' });
  assert.match(desk, /^Terminal=false$/m);
  assert.match(desk, /^Exec="\/usr\/bin\/node" "\/home\/u\/qq bridge\/src\/launcher\/control-center\.mjs"$/m);
  const home = tmp();
  const r = buildLinuxService({ root: '/home/u/qq', home, node: '/usr/bin/node' });
  assert.equal(r.unitPath, path.join(home, '.config', 'systemd', 'user', `${SERVICE_NAME}.service`));
  assert.ok(fs.existsSync(r.unitPath) && fs.existsSync(r.desktopPath));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts['linux-service'], 'node scripts/build-linux-service.mjs');
});

test('控制中心页面：SnowLuma 在 Windows / Linux 上都可用（macOS 仍不列本机 SnowLuma）；Node 要求按发行包显示', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'control-center.html'), 'utf8');
  assert.match(html, /const SNOW_OS = \['win32', 'linux'\];/);
  assert.ok(!html.includes("S?.os === 'win32' ? [LOCAL_SNOW]"), '本机 SnowLuma 占位项不再只看 Windows');
  assert.match(html, /\{ id: 'snowluma', name: 'SnowLuma', os: 'Windows \/ Linux' \}/);
  assert.match(html, /需要 \$\{i\.nodeRequirement \?\? '22\.13\+'\}/);
  assert.match(html, /本机需要 \$\{i\.expectedTarget\} 版/);
  assert.match(html, /launcher\.sh/);
});

test('接口平台的提供方：SnowLuma 声明 Windows / Linux，NapCat 声明 macOS / Windows / Linux；说明文字与声明一致', () => {
  assert.deepEqual(SNOW_PROVIDER.os, ['win32', 'linux']);
  assert.deepEqual(NAP_PROVIDER.os, ['darwin', 'win32', 'linux']);
  assert.match(SNOW_PROVIDER.note, /Windows \/ Linux/);
  assert.match(NAP_PROVIDER.note, /macOS \/ Windows \/ Linux/);
});
