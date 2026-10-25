// NapCat 管理（版本显示、检查更新、目录与启动文件设置）与系统「浏览…」窗口的离线测试。
// 全部假数据：不联网、不弹真实窗口、不读真实 NapCat 目录、不启动 QQ。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { pickDialogSpec, pickDialog, normalizePickedPath } from '../src/launcher/pick-dialog.mjs';
import { compareNapCatVersions, napcatFileVersion, napcatRuntimeVersion, checkNapCatUpdate, validateNapCatSettings, NAPCAT_MAC_INSTALLER_PAGE, napcatQrCandidates, napcatQrStatus, readNapCatQr, napcatLoggedIn } from '../src/launcher/napcat-launch.mjs';
import { startControlCenter } from '../src/launcher/control-center.mjs';
// 不碰真实 NapCat 目录（macOS 上读 QQ 沙盒容器会弹授权窗并卡住测试）
process.env.QQ_BRIDGE_NAPCAT_HOME ||= path.join(os.tmpdir(), 'qq-bridge-test-no-napcat');

const root = fileURLToPath(new URL('..', import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qq-napcat-manage-'));

test('浏览窗口：macOS 用 osascript，标题/目录走 argv 不拼进脚本；Windows 走环境变量；其他系统不支持', () => {
  const evil = '"; do shell script "rm -rf ~"; "';
  const mac = pickDialogSpec({ platform: 'darwin', kind: 'folder', title: evil, initialDir: '/x/y' });
  assert.equal(mac.command, '/usr/bin/osascript');
  assert.equal(mac.args[0], '-e');
  assert.ok(!mac.args[1].includes(evil), '标题不进脚本');
  assert.deepEqual(mac.args.slice(2), [evil, 'folder', '/x/y', '']);
  assert.match(mac.args[1], /choose folder/);
  assert.match(mac.args[1], /com\.apple\.application-bundle/, '可以选 .app');
  assert.match(mac.args[1], /error number -128/, '取消返回空');
  const win = pickDialogSpec({ platform: 'win32', kind: 'file', title: '选择启动文件', extensions: ['bat', '.exe', 'bad ext!'], env: { SystemRoot: 'C:\\Windows' } });
  assert.match(win.command, /powershell\.exe$/i);
  assert.equal(win.env.QQB_PICK_TITLE, '选择启动文件');
  assert.equal(win.env.QQB_PICK_FILTER, '选择启动文件 (*.bat;*.exe)|*.bat;*.exe', '只保留合法扩展名');
  assert.ok(!win.args.join(' ').includes('选择启动文件'));
  assert.match(pickDialogSpec({ platform: 'win32', kind: 'folder', env: {} }).args.at(-1), /FolderBrowserDialog/);
  assert.equal(pickDialogSpec({ platform: 'linux' }), null);
  assert.throws(() => pickDialogSpec({ kind: 'anything' }), /不支持/);
});

test('浏览窗口：返回值整理（去换行、去末尾斜杠）；取消 / 出错 / 不支持都返回 null', async () => {
  assert.equal(normalizePickedPath('/Applications/QQ.app/\n'), '/Applications/QQ.app');
  assert.equal(normalizePickedPath('C:\\NapCat\\\r\n'), 'C:\\NapCat');
  assert.equal(normalizePickedPath('/'), '/');
  assert.equal(normalizePickedPath('\n'), null);
  const fake = (out, err = null) => (cmd, args, opts, cb) => cb(err, out);
  assert.equal(await pickDialog({ platform: 'darwin', kind: 'folder' }, { run: fake('/Users/test/NapCat/\n') }), '/Users/test/NapCat');
  assert.equal(await pickDialog({ platform: 'darwin' }, { run: fake('') }), null, '用户取消');
  assert.equal(await pickDialog({ platform: 'darwin' }, { run: fake('', new Error('boom')) }), null);
  assert.equal(await pickDialog({ platform: 'linux' }, { run: () => assert.fail('不应调用') }), null);
});

test('NapCat 版本：比较、Windows 从启动文件旁的 package.json 读、macOS 不读文件；运行中的版本取后端自报', () => {
  assert.equal(compareNapCatVersions('v4.18.40', '4.18.38'), 1);
  assert.equal(compareNapCatVersions('4.18.38', '4.18.38'), 0);
  assert.equal(compareNapCatVersions('4.9.0', '4.18.0'), -1);
  const files = { [path.join('C:/n', 'package.json')]: '{"name":"other","version":"1"}', [path.join('C:/n', 'napcat', 'package.json')]: '{"name":"napcat","version":"4.18.38"}' };
  const read = (f) => { if (f in files) return files[f]; throw Object.assign(new Error('nope'), { code: 'ENOENT' }); };
  assert.equal(napcatFileVersion({ napcatCommand: 'C:/n/napcat.bat' }, { platform: 'win32', read }), '4.18.38');
  assert.equal(napcatFileVersion({ napcatCommand: 'C:/n/napcat.bat' }, { platform: 'darwin', read: () => assert.fail('macOS 不读文件') }), null);
  assert.equal(napcatFileVersion({}, { platform: 'win32', read }), null);
  const ov = { instances: [{ links: [{ backend: { appName: 'SnowLuma', appVersion: '1.14.22' } }] }, { links: [{ backend: { appName: 'NapCat.Onebot', appVersion: '4.18.38' } }] }] };
  assert.equal(napcatRuntimeVersion(ov), '4.18.38');
  assert.equal(napcatRuntimeVersion({ instances: [] }), null);
  assert.equal(napcatRuntimeVersion(null), null);
});

test('检查更新：只读 GitHub 最新 Release；macOS 指向 Mac 安装器，Windows 建议 NapCat.Shell 一键包；不知道当前版本时不判断有无更新', async () => {
  const rel = { tag_name: 'v4.19.0', html_url: 'https://github.com/NapNeko/NapCatQQ/releases/tag/v4.19.0', published_at: '2026-10-01T00:00:00Z', body: '更新说明', assets: [{ name: 'NapCat.Framework.zip' }, { name: 'NapCat.Shell.zip' }, { name: 'NapCat.Shell.Windows.OneKey.zip' }] };
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, method: opts?.method ?? 'GET' }); return { ok: true, json: async () => rel }; };
  const mac = await checkNapCatUpdate('4.18.38', { fetchImpl, platform: 'darwin' });
  assert.equal(mac.updateAvailable, true);
  assert.equal(mac.latest, '4.19.0');
  assert.equal(mac.pageUrl, NAPCAT_MAC_INSTALLER_PAGE);
  assert.equal(mac.suggestedAsset, null);
  const win = await checkNapCatUpdate('4.19.0', { fetchImpl, platform: 'win32' });
  assert.equal(win.updateAvailable, false);
  assert.equal(win.suggestedAsset, 'NapCat.Shell.Windows.OneKey.zip');
  assert.equal(win.pageUrl, rel.html_url);
  const unknown = await checkNapCatUpdate(null, { fetchImpl, platform: 'win32' });
  assert.equal(unknown.updateAvailable, false);
  assert.equal(unknown.current, null);
  assert.ok(calls.every((c) => c.method === 'GET' && /api\.github\.com\/repos\/NapNeko\/NapCatQQ\/releases\/latest$/.test(c.url)), '只发 GET 到 Release API，不下载任何资产');
  await assert.rejects(checkNapCatUpdate('1', { fetchImpl: async () => ({ ok: false, status: 403 }) }), /HTTP 403/);
});

test('设置校验：QQ.app 只在 macOS、启动文件只在 Windows 且必须是 .bat/.cmd/.exe；目录没有 onebot11 配置时给提示；空值 = 恢复默认', () => {
  const have = new Set(['/Apps/QQ.app/Contents/MacOS/QQ', 'C:/n/napcat.bat', '/nap', '/nap-empty']);
  const exists = (p) => have.has(p.replaceAll('\\', '/'));
  const readdir = (d) => { if (d.replaceAll('\\', '/') === '/nap/config') return ['onebot11_10001.json']; if (d.replaceAll('\\', '/').startsWith('/nap-empty')) return []; throw Object.assign(new Error('x'), { code: 'ENOENT' }); };
  const o = { exists, readdir };
  assert.deepEqual(validateNapCatSettings({ qqApp: '/Apps/QQ.app', home: '/nap' }, { platform: 'darwin', ...o }), { ok: true, patch: { napcatQQApp: '/Apps/QQ.app', napcatHome: '/nap' }, notes: [] });
  assert.match(validateNapCatSettings({ qqApp: '/Apps/Other.app' }, { platform: 'darwin', ...o }).error, /不是 QQ 程序/);
  assert.match(validateNapCatSettings({ qqApp: '/Apps/QQ.app' }, { platform: 'win32', ...o }).error, /只在 macOS/);
  assert.match(validateNapCatSettings({ command: 'C:/n/napcat.bat' }, { platform: 'darwin', ...o }).error, /不需要启动文件/);
  assert.deepEqual(validateNapCatSettings({ command: 'C:/n/napcat.bat' }, { platform: 'win32', ...o }).patch, { napcatCommand: 'C:/n/napcat.bat' });
  assert.match(validateNapCatSettings({ command: 'C:/n/napcat.ps1' }, { platform: 'win32', ...o }).error, /\.bat/);
  assert.match(validateNapCatSettings({ command: 'C:/n/none.exe' }, { platform: 'win32', ...o }).error, /找不到启动文件/);
  assert.match(validateNapCatSettings({ home: '/nowhere' }, { platform: 'darwin', ...o }).error, /找不到目录/);
  assert.match(validateNapCatSettings({ home: '/nap-empty' }, { platform: 'darwin', ...o }).notes[0], /onebot11_/);
  assert.match(validateNapCatSettings({ quickLogin: 'abc' }, { platform: 'darwin', ...o }).error, /QQ 号/);
  assert.deepEqual(validateNapCatSettings({ qqApp: '', home: '', quickLogin: '' }, { platform: 'darwin', ...o }).patch, { napcatQQApp: '', napcatHome: '', napcatQuickLogin: '' });
});

function req(port, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      let t = ''; res.setEncoding('utf8'); res.on('data', (c) => { t += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, body: j }); });
    });
    r.on('error', reject);
    r.end(data ?? undefined);
  });
}

test('控制中心：NapCat 设置经接口保存到 state/control-center.json；非法值拒绝且不写；浏览只接受固定用途；状态里带版本与设置', async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ version: '9.9.9-test' }));
  fs.mkdirSync(path.join(d, 'node_modules'));
  const home = path.join(d, 'napcat-home');
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config', 'onebot11_10001.json'), '{}');
  const cc = await startControlCenter({ open: false, port: 0, root: d, bridgeEntry: path.join(d, 'nope.mjs'), installSignalHandlers: false, exitOnShutdown: false, log: () => {} });
  const T = { 'x-control-token': cc.token };
  try {
    assert.equal((await req(cc.port, 'POST', '/api/napcat/settings', { body: { home } })).status, 401, '没有令牌不能改');
    const ok = await req(cc.port, 'POST', '/api/napcat/settings', { body: { home, quickLogin: '10001' }, headers: T });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const saved = JSON.parse(fs.readFileSync(path.join(d, 'state', 'control-center.json'), 'utf8'));
    assert.equal(saved.napcatHome, home);
    assert.equal(saved.napcatQuickLogin, '10001');
    const bad = await req(cc.port, 'POST', '/api/napcat/settings', { body: { home: path.join(d, 'nowhere') }, headers: T });
    assert.equal(bad.status, 400);
    assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'state', 'control-center.json'), 'utf8')).napcatHome, home, '拒绝时不改原设置');
    assert.equal((await req(cc.port, 'POST', '/api/pick', { body: { purpose: 'anything' }, headers: T })).status, 400, '不支持任意用途');
    if (process.platform !== 'darwin') assert.equal((await req(cc.port, 'POST', '/api/pick', { body: { purpose: 'napcat-qqapp' }, headers: T })).status, 400);
    const st = await req(cc.port, 'GET', '/api/state', { headers: T });
    assert.equal(st.body.napcat.home, home);
    assert.equal(st.body.napcat.settings.home, home);
    assert.ok('runtime' in st.body.napcat.version && 'file' in st.body.napcat.version);
    assert.ok(/github\.com\/NapNeko\//.test(st.body.napcat.releasesPage));
  } finally { await cc.shutdown('test'); }
});

test('页面：NapCat 区有版本、检查更新、下载页、设置（QQ.app / 启动文件 / 目录 + 浏览…）；浏览走 /api/pick 的固定用途', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'control-center.html'), 'utf8');
  for (const id of ['napVer', 'napCheck', 'napOpenDownload', 'napSetPanel', 'napQQAppInput', 'napQQAppBrowse', 'napCmdInput', 'napCmdBrowse', 'napHomeInput', 'napHomeBrowse', 'napSetSave']) assert.ok(html.includes(`id="${id}"`), `缺少 #${id}`);
  for (const purpose of ['napcat-qqapp', 'napcat-command', 'napcat-home']) assert.ok(html.includes(`'${purpose}'`), `浏览用途 ${purpose}`);
  assert.ok(!/api\('\/api\/pick', \{[^}]*title/.test(html), '页面不传标题等任意参数');
  const src = fs.readFileSync(path.join(root, 'src', 'launcher', 'napcat-launch.mjs'), 'utf8');
  assert.ok(!/child_process|https?\.get|createWriteStream/.test(src), 'NapCat 更新检测不下载、不执行任何东西');
});

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

test('登录二维码：只在 NapCat 由控制中心启动、未登录、且本次启动后写过新二维码时才算「等扫码」；文件位置固定', () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, 'cache'));
  const qr = path.join(home, 'cache', 'qrcode.png');
  const settings = { napcatHome: home };
  assert.deepEqual(napcatQrCandidates(settings), [qr]);
  assert.deepEqual(napcatQrCandidates({ napcatHome: home, napcatCommand: path.join('C:/n', 'napcat.bat') }), [qr, path.join('C:/n', 'cache', 'qrcode.png'), path.join('C:/n', 'napcat', 'cache', 'qrcode.png')]);
  const startedAt = Date.now();
  assert.equal(napcatQrStatus(settings, { running: true, startedAt }).waiting, false, '还没有二维码文件');
  fs.writeFileSync(qr, PNG);
  const w = napcatQrStatus(settings, { running: true, startedAt });
  assert.equal(w.waiting, true);
  assert.equal(w.file, qr);
  assert.equal(napcatQrStatus(settings, { running: true, startedAt, loggedIn: true }).waiting, false, '已登录不显示');
  assert.equal(napcatQrStatus(settings, { running: false, startedAt }).waiting, false, '没在运行不显示');
  assert.equal(napcatQrStatus(settings, { running: true, startedAt: startedAt + 60_000 }).waiting, false, '启动前留下的旧二维码不显示');
  assert.equal(napcatQrStatus(settings, { running: false, stat: () => assert.fail('不运行时不去看文件') }).waiting, false);
  assert.deepEqual(readNapCatQr(qr), PNG);
  fs.writeFileSync(qr, 'not a png');
  assert.equal(readNapCatQr(qr), null, '不是 PNG 不给');
  assert.equal(readNapCatQr(path.join(home, 'none.png')), null);
});

test('已登录判断：接口平台里 NapCat 实例有在线且识别出账号的链路', () => {
  assert.equal(napcatLoggedIn({ instances: [{ provider: 'napcat', links: [{ state: 'open', account: 'qq:10001' }] }] }), true);
  assert.equal(napcatLoggedIn({ instances: [{ provider: 'napcat', links: [{ state: 'connecting', account: 'qq:10001' }] }] }), false);
  assert.equal(napcatLoggedIn({ instances: [{ provider: 'snowluma', links: [{ state: 'open', account: 'qq:10001' }] }] }), false, '只看 NapCat');
  assert.equal(napcatLoggedIn(null), false);
});

test('控制中心：不在等扫码时二维码接口给 404，需要令牌；状态里有 qr 字段', async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ version: '9.9.9-test' }));
  fs.mkdirSync(path.join(d, 'node_modules'));
  const cc = await startControlCenter({ open: false, port: 0, root: d, bridgeEntry: path.join(d, 'nope.mjs'), installSignalHandlers: false, exitOnShutdown: false, log: () => {} });
  try {
    assert.equal((await req(cc.port, 'GET', '/api/napcat/qrcode')).status, 401);
    assert.equal((await req(cc.port, 'GET', '/api/napcat/qrcode', { headers: { 'x-control-token': cc.token } })).status, 404);
    const st = await req(cc.port, 'GET', '/api/state', { headers: { 'x-control-token': cc.token } });
    assert.deepEqual(st.body.napcat.qr, { waiting: false, updatedAt: null });
  } finally { await cc.shutdown('test'); }
});

test('页面：NapCat 程序区始终找得到（本机占位项 + 开启卡上的跳转按钮）；等扫码时卡片提示并显示二维码', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'control-center.html'), 'utf8');
  assert.match(html, /const LOCAL_NAP = \{ id: '本机 NapCat 程序', provider: 'napcat'/);
  assert.match(html, /function goToNapcat\(\)[\s\S]*mainTabs\.select\('tab-platform'\)[\s\S]*platformTabs\.select\('ptab-instances'\)/);
  assert.ok(html.includes('管理 NapCat 程序 →') && html.includes('查看登录二维码 →'));
  assert.ok(html.includes('id="napQrPanel"') && html.includes('id="napQrImg"'));
  assert.match(html, /fetch\('\/api\/napcat\/qrcode', \{ headers: \{ 'x-control-token': token \} \}\)/, '图片请求带令牌头，不把令牌放进图片地址');
  assert.ok(html.includes('readAsDataURL'), '转成 data: 地址（CSP 只允许 data: 图片）');
});

// ── NapCat 日志里的二维码小图：把页面里的 makeLog 取出来，用最小的假 DOM 跑 ─────────────
function extractFn(html, name) {
  // 页面里的顶层函数缩进 2 格：从「function 名字(」到第一个缩进 2 格的「}」（函数体里有含 { 的字符串，不能数括号）
  const m = new RegExp(`\\n  (async )?function ${name}\\(`).exec(html);
  const start = m ? m.index + 1 : -1;
  assert.ok(start >= 0, `找不到 ${name}`);
  const end = html.indexOf('\n  }\n', start);
  return html.slice(start, end + 4);
}

function fakeDom() {
  class Node { constructor(tag) { this.tagName = tag; this.children = []; this.className = ''; this.textContent = ''; } append(...k) { this.children.push(...k); } appendChild(k) { this.children.push(k); return k; } replaceChildren(...k) { this.children = k.flatMap((x) => (x?.frag ? x.children : [x])); } }
  const ids = {
    napTerm: Object.assign(new Node('div'), { offsetParent: {}, scrollTop: 0, scrollHeight: 0 }),
    napFilter: { value: '', addEventListener() {} },
    napErrors: { checked: false, addEventListener() {} },
    napPause: { checked: false },
  };
  const document = {
    createElement: (t) => new Node(t),
    createDocumentFragment: () => Object.assign(new Node('#frag'), { frag: true }),
    createTextNode: (t) => ({ text: t }),
  };
  let downloaded = null;
  class Blob { constructor(parts) { downloaded = parts.join(''); } }
  const URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
  document.createElement = ((orig) => (t) => { const n = orig(t); if (t === 'a') n.click = () => {}; return n; })(document.createElement);
  return { ids, document, Blob, URL, getDownloaded: () => downloaded };
}

test('NapCat 日志：二维码以小图条目插入；新图来了旧图标成已过期；清屏照常；下载日志只写文字不写图片数据', async () => {
  const html = fs.readFileSync(path.join(root, 'public', 'control-center.html'), 'utf8');
  const dom = fakeDom();
  const ctx = {
    document: dom.document, Blob: dom.Blob, URL: dom.URL, Date,
    $: (id) => dom.ids[id],
    el: (tag, props = {}, ...kids) => { const e = dom.document.createElement(tag); Object.assign(e, props); for (const k of kids) e.append(k); return e; },
    authFailed: false,
    api: async () => ({ lines: [{ seq: 1, time: 1, stream: 'stdout', text: '请扫描二维码' }], lastSeq: 1 }),
  };
  const { default: vm } = await import('node:vm');
  vm.runInNewContext(`${extractFn(html, 'makeLog')}\nthis.napLog = makeLog('napcat', 'napTerm', { filterId: 'napFilter', errorsId: 'napErrors', pauseId: 'napPause' });`, ctx);
  const log = ctx.napLog;
  await log.poll();
  const rows = () => dom.ids.napTerm.children;
  log.addImage({ key: 100, src: 'data:image/png;base64,AAAA', text: '已生成登录二维码' });
  assert.equal(rows().length, 2);
  const imgRow = rows()[1];
  assert.match(imgRow.className, /\bimg\b/);
  assert.equal(imgRow.children.find((c) => c.tagName === 'img').src, 'data:image/png;base64,AAAA');
  log.addImage({ key: 100, src: 'data:dup', text: '重复' });
  assert.equal(rows().length, 2, '同一张不重复插入');
  log.addImage({ key: 200, src: 'data:image/png;base64,BBBB', text: '已生成登录二维码' });
  log.expireImages('已过期，已换新二维码', 200);
  assert.match(rows()[1].className, /expired/, '旧图过期');
  assert.ok(!/expired/.test(rows()[2].className), '最新的不过期');
  log.download();
  assert.ok(!dom.getDownloaded().includes('base64'), '下载的日志里没有图片数据');
  assert.match(dom.getDownloaded(), /已生成登录二维码（已过期，已换新二维码）（图片不写入日志文件）/);
  for (let k = 0; k < 7; k++) log.addImage({ key: 300 + k, src: 'data:x', text: 't' });
  assert.equal(log.lines.filter((l) => l.kind === 'img').length, 5, '最多保留 5 张');
  log.clear();
  assert.equal(rows().length, 1, '清屏后图片条目也清掉');
  assert.equal(rows()[0].className, 'empty');
});

test('页面接线：拿到新二维码时同时更新顶部面板和日志小图，登录后 / 停止后把日志里的图标成过期', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'control-center.html'), 'utf8');
  const fn = extractFn(html, 'renderNapQr');
  assert.match(fn, /\$\('napQrImg'\)\.src = url;[\s\S]*napLog\.addImage\(/);
  assert.match(fn, /napLog\.expireImages\('已过期，已换新二维码', q\.updatedAt\)/);
  assert.match(fn, /napLog\.expireImages\(S\?\.napcat\?\.running \? '已登录或已失效' : 'NapCat 已停止'\)/);
});
