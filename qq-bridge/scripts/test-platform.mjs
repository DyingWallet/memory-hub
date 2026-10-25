// 接口平台（仓库内的独立子目录 interface-platform/）离线回归，接入 test:audit。全部假数据，不需要 QQ / SnowLuma / DSH。
// 找不到平台目录即失败（仓库不完整）；可用 QQ_BRIDGE_PLATFORM_DIR 指定别处的平台。
//   ① 平台自身的单元与端到端测试（假 SnowLuma + 真实 @snowluma/sdk 客户端）
//   ② 控制中心把平台当子进程管理：启停、概览、受限转发、接入桥接（备份/还原）
//   ③ 桥接 viaPlatform：token 自愈不得扫描 SnowLuma 目录、不得把端点改回真实 SnowLuma
//   ④ 控制中心页面契约：顶部两个大标签，切换不发请求，令牌不进 localStorage
//   ⑤ 边界：控制中心只经 HTTP 管理接口与平台通信，不导入平台模块、不读写平台数据目录
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startControlCenter } from '../src/launcher/control-center.mjs';
import { discoverSnowLumaConnection, snowLumaHomeCandidates } from '../src/snowluma-conn.js';
import { pathToFileURL } from 'node:url';
// 不碰真实 NapCat 目录（macOS 上读 QQ 沙盒容器会弹授权窗并卡住测试）
process.env.QQ_BRIDGE_NAPCAT_HOME ||= path.join(os.tmpdir(), 'qq-bridge-test-no-napcat');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLATFORM_DIR = path.resolve(process.env.QQ_BRIDGE_PLATFORM_DIR || path.join(root, 'interface-platform'));
const HAS_PLATFORM = fs.existsSync(path.join(PLATFORM_DIR, 'src', 'index.mjs'));
// 接口平台已经在仓库里：缺了就是仓库不完整，直接失败（不再跳过）
const SKIP = false;
if (!HAS_PLATFORM) { console.error(`❌ 接口平台不在 ${PLATFORM_DIR}：仓库不完整`); process.exitCode = 1; }
// 测试夹具可以直接用平台的模块（测试不是运行时边界）；运行时代码（控制中心）不行，见 ⑤
const { createFakeSnowLuma } = HAS_PLATFORM ? await import(pathToFileURL(path.join(PLATFORM_DIR, 'test', 'fixtures', 'fake-snowluma.mjs')).href) : {};
const { startPlatform } = HAS_PLATFORM ? await import(pathToFileURL(path.join(PLATFORM_DIR, 'src', 'index.mjs')).href) : {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qq-platform-'));
async function until(fn, ms = 8000, what = '条件') {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50); }
  throw new Error(`等待超时：${what}`);
}

test('① 接口平台自身测试全部通过', { skip: SKIP }, () => {
  const r = spawnSync(process.execPath, ['--test', '--test-timeout=30000', 'test/units.test.mjs', 'test/e2e.test.mjs'], { cwd: PLATFORM_DIR, encoding: 'utf8', timeout: 120_000 });
  const summary = (r.stdout ?? '').split('\n').filter((l) => /^# (tests|pass|fail)/.test(l)).join(' / ');
  assert.equal(r.status, 0, `${summary}\n${(r.stdout ?? '').split('\n').filter((l) => /^not ok|error:|expected|actual/.test(l)).join('\n')}${r.stderr ?? ''}`);
  assert.match(summary, /# fail 0/);
  assert.match(summary, /# pass [1-9]/);
});

async function api(port, token, method, route, body) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { 'x-control-token': token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('② 控制中心管理接口平台子进程：启动、概览出现账号、受限转发、接入桥接备份与还原、退出时停止', { timeout: 60_000, skip: SKIP }, async () => {
  const fake = await createFakeSnowLuma({ token: 'fake-ws-token', selfId: 10001 });
  const d = tmp();
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ version: '9.9.9-test' }));
  fs.mkdirSync(path.join(d, 'node_modules'));
  const original = { ownerQQ: 12345678, snowluma: { wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000', accessToken: 'old-http-token', homeDir: 'D:\\SnowLuma' } };
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify(original));
  // 平台的数据目录放在临时目录（经环境变量交给平台子进程），绝不碰真实的 interface-platform/state
  const pdir = path.join(d, 'platform-data');
  fs.mkdirSync(pdir, { recursive: true });
  // 端口 0 不能用（控制中心要知道平台端口），找一个空闲端口
  const net = await import('node:net');
  const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  fs.writeFileSync(path.join(pdir, 'platform.json'), JSON.stringify({ instances: [{ id: 'snowluma-main', provider: 'snowluma', upstream: { wsUrl: fake.url, accessToken: fake.token } }] }));
  fs.mkdirSync(path.join(d, 'state'), { recursive: true });
  fs.writeFileSync(path.join(d, 'state', 'control-center.json'), JSON.stringify({ platformPort: port }));
  const prevData = process.env.INTERFACE_PLATFORM_DATA_DIR;
  process.env.INTERFACE_PLATFORM_DATA_DIR = pdir;
  const fakeBridge = path.join(d, 'fake-bridge.mjs');
  fs.writeFileSync(fakeBridge, 'setInterval(() => {}, 1000);');
  const cc = await startControlCenter({ open: false, port: 0, root: d, bridgeEntry: fakeBridge, platformEntry: path.join(PLATFORM_DIR, 'src', 'index.mjs'), installSignalHandlers: false, exitOnShutdown: false, log: () => {} });
  const T = cc.token;
  try {
    assert.equal(cc.platform.running, false, '启动控制中心不会启动接口平台');
    let st = await api(cc.port, T, 'GET', '/api/state');
    assert.equal(st.body.platform.reachable, false);
    assert.equal(st.body.platform.overview, null, '平台没运行时控制中心不去读平台文件');
    // 平台没运行时接入桥接要明确失败，且不改 config.json
    const early = await api(cc.port, T, 'POST', '/api/platform/link-bridge', { enabled: true });
    assert.equal(early.status, 409);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, 'config.json'), 'utf8')), original);

    assert.equal((await api(cc.port, T, 'POST', '/api/platform/start', {})).body.ok, true);
    await until(async () => (await api(cc.port, T, 'GET', '/api/state')).body.platform.overview?.accounts?.[0]?.health.loggedIn, 10_000, '平台概览出现已登录账号');
    fake.heartbeat();
    st = await until(async () => { const s = await api(cc.port, T, 'GET', '/api/state'); return s.body.platform.overview?.counts.accountsReady === 1 && s; }, 5000, '账号收发就绪');
    assert.equal(st.body.platform.overview.accounts[0].account, 'qq:10001');
    const logs = await api(cc.port, T, 'GET', '/api/logs?source=platform&after=0');
    assert.ok(logs.body.lines.some((l) => l.text.startsWith('{"pl":1') && l.text.includes('接口平台已启动')), '平台结构化日志进入控制中心');
    const pdata = fs.readFileSync(path.join(pdir, 'data-token'), 'utf8').trim(); // 测试自己读来断言；控制中心不读
    assert.ok(!st.body.platform.overview.instances.some((i) => JSON.stringify(i).includes(fake.token)), '概览不外露上游令牌');
    assert.ok(!logs.body.lines.some((l) => l.text.includes(pdata)), '控制中心日志里没有平台数据令牌');

    // 受限转发：账号桥接开关可以；任意管理路径不行
    const off = await api(cc.port, T, 'POST', '/api/platform/accounts/qq:10001/bridge', { enabled: false });
    assert.equal(off.body.bridgeEnabled, false);
    assert.equal((await api(cc.port, T, 'POST', '/api/platform/shutdown', {})).status, 404, '不能经控制中心转发任意管理接口');
    await api(cc.port, T, 'POST', '/api/platform/accounts/qq:10001/bridge', { enabled: true });

    // 接入桥接：写入平台兼容入口与数据令牌，备份原值；还原后与原来一致
    const link = await api(cc.port, T, 'POST', '/api/platform/link-bridge', { enabled: true });
    assert.equal(link.body.ok, true);
    const linked = JSON.parse(fs.readFileSync(path.join(d, 'config.json'), 'utf8'));
    assert.equal(linked.snowluma.wsUrl, `ws://127.0.0.1:${port}/onebot/v11/ws`);
    assert.equal(linked.snowluma.httpUrl, `http://127.0.0.1:${port}/onebot/v11`);
    assert.equal(linked.snowluma.accessToken, pdata);
    assert.equal(linked.snowluma.viaPlatform, true);
    assert.equal(linked.snowluma.followDiscoveredEndpoint, false);
    assert.equal(linked.ownerQQ, 12345678, '其他字段不动');
    assert.ok(fs.existsSync(path.join(d, 'state', 'platform-link-backup.json')));
    // 桥接按这份配置真的能经平台调用 OneBot HTTP
    const r = await fetch(`${linked.snowluma.httpUrl}/get_login_info`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${linked.snowluma.accessToken}` }, body: '{}' });
    assert.equal((await r.json()).data.user_id, 10001);
    // 经平台时选择 SnowLuma 目录不写桥接 homeDir
    st = await api(cc.port, T, 'GET', '/api/state');
    assert.equal(st.body.platform.link.viaPlatform, true);

    const unlink = await api(cc.port, T, 'POST', '/api/platform/link-bridge', { enabled: false });
    assert.equal(unlink.body.restoredFromBackup, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, 'config.json'), 'utf8')), original, '恢复直连后与原配置完全一致');

    // 固定命令集里的 platform stop
    await cc.runCommand('platform stop');
    await until(() => !cc.platform.running, 10_000, '平台停止');
    assert.equal(fake.connections, 0, '平台停止后断开上游（SnowLuma 本身不受影响）');
  } finally {
    await cc.shutdown('test');
    await fake.close();
    if (prevData === undefined) delete process.env.INTERFACE_PLATFORM_DATA_DIR; else process.env.INTERFACE_PLATFORM_DATA_DIR = prevData;
  }
});

test('③ 桥接 viaPlatform：自愈只认平台端点，不扫描 SnowLuma 目录、不改回真实端点', { skip: SKIP }, async () => {
  const fake = await createFakeSnowLuma({ token: 'real-snowluma-ws-token', selfId: 10001 });
  const home = tmp();
  fs.mkdirSync(path.join(home, 'config'));
  // SnowLuma 目录里有真实端点；viaPlatform 时绝不能被用上
  fs.writeFileSync(path.join(home, 'config', 'onebot_10001.json'), JSON.stringify({ networks: { httpServers: [{ port: 39999, accessToken: 'real-http' }], wsServers: [{ port: fake.port, accessToken: fake.token }] } }));
  const dataDir = tmp();
  fs.writeFileSync(path.join(dataDir, 'platform.json'), JSON.stringify({ port: 0, instances: [{ id: 'snowluma-main', provider: 'snowluma', upstream: { homeDir: home } }] }));
  const p = await startPlatform({ dataDir, stdoutLogs: false, installSignalHandlers: false, exitOnShutdown: false });
  try {
    await until(() => p.platform.accounts()[0]?.health.loggedIn, 5000, '平台经目录连上');
    const cfg = { snowluma: { viaPlatform: true, httpUrl: `http://127.0.0.1:${p.port}/onebot/v11`, wsUrl: `ws://127.0.0.1:${p.port}/onebot/v11/ws`, accessToken: p.platform.tokens.data, homeDir: home, launcherPath: path.join(home, 'launcher.bat') } };
    assert.deepEqual(snowLumaHomeCandidates({ cfg }), [], 'viaPlatform 时不扫描任何 SnowLuma 目录');
    const r = await discoverSnowLumaConnection({ cfg, timeoutMs: 3000 });
    assert.equal(r.ok, true, JSON.stringify(r.tried));
    assert.equal(r.baseUrl, cfg.snowluma.httpUrl, '自愈结果仍是平台地址');
    assert.equal(r.token, p.platform.tokens.data);
    assert.equal(r.wsUrl, null, '不会带回 SnowLuma 的真实 WS 端点');
    assert.equal(r.wsToken, null, '不会带回 SnowLuma 的真实 WS 令牌');
    const bridgeSrc = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8');
    assert.match(bridgeSrc, /followDiscoveredEndpoint !== false && cfg\.snowluma\?\.viaPlatform !== true/, 'viaPlatform 强制不跟随端点');
  } finally {
    await p.shutdown('test');
    await fake.close();
  }
});

test('④ 控制中心页面契约：两个顶部大标签、切换不发请求、令牌不进 localStorage、SnowLuma 启停仍只在用户点击', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'control-center.html'), 'utf8');
  assert.match(html, /role="tablist" aria-label="模块"/);
  assert.match(html, /id="tab-bridge"[^>]*aria-controls="panel-bridge"/);
  assert.match(html, /id="tab-platform"[^>]*aria-controls="panel-platform"/);
  for (const v of ['overview', 'instances', 'accounts', 'logs', 'settings']) assert.match(html, new RegExp(`id="ptab-${v}"`), `接口平台子区域 ${v}`);
  // 不再是左右双栏
  assert.ok(!/grid-template-columns:\s*1fr 1fr/.test(html), '不使用左右双栏布局');
  const tabsFn = html.slice(html.indexOf('function makeTabs'), html.indexOf('// ── 日志视图'));
  assert.ok(tabsFn.length > 100);
  assert.ok(!/api\(|fetch\(|setInterval|new WebSocket|EventSource/.test(tabsFn), '标签切换不发请求、不建连接、不加定时器');
  assert.equal((html.match(/setInterval\(/g) ?? []).length, 2, '全页只有两组轮询定时器');
  assert.ok(!/localStorage\.setItem\([^)]*[Tt]oken/.test(html) && !/pref\.set\([^)]*[Tt]oken/.test(html), '令牌不进 localStorage');
  assert.match(html, /sessionStorage\.setItem\('ccToken'/);
  assert.match(html, /尚未提供/, '未实现的平台标注「尚未提供」');
  // SnowLuma 启停按钮只调用控制中心的 /api/snowluma/*，接口平台没有任何启停 SnowLuma 的途径
  const platformSrc = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.mjs')) platformSrc.push(fs.readFileSync(p, 'utf8')); } };
  if (HAS_PLATFORM) walk(path.join(PLATFORM_DIR, 'src'));
  for (const src of platformSrc) for (const bad of ['child_process', 'launcher.bat', 'snowlumaLaunchSpec']) assert.ok(!src.includes(bad), `接口平台代码不得包含「${bad}」`);
});

test('⑦ 同仓库不同程序：桥接代码不导入平台模块，平台代码也不导入桥接模块；平台的 state/ 不入库', () => {
  const importsOf = (dir) => {
    const out = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(m?js)$/.test(e.name)) for (const m of fs.readFileSync(p, 'utf8').matchAll(/(?:from\s+|import\(\s*)['"]([^'"]+)['"]/g)) out.push([path.relative(root, p), m[1], path.resolve(path.dirname(p), m[1])]); } };
    walk(dir);
    return out;
  };
  for (const [f, spec] of importsOf(path.join(root, 'src'))) assert.ok(!/interface-platform/.test(spec), `${f} 不得导入平台模块：${spec}`);
  for (const [f, spec, abs] of importsOf(path.join(PLATFORM_DIR, 'src'))) {
    if (!spec.startsWith('.')) continue;
    assert.ok(abs.startsWith(path.join(PLATFORM_DIR, 'src') + path.sep), `${f} 只能导入平台自己的模块：${spec}`);
  }
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.match(ignore, /^interface-platform\/state\/$/m, '.gitignore 要排除平台的 state/');
  // 版本号与项目统一：平台的 package.json = 项目的 package.json，平台代码从自己的 package.json 读，不另写死
  const ver = (f) => JSON.parse(fs.readFileSync(f, 'utf8')).version;
  assert.equal(ver(path.join(PLATFORM_DIR, 'package.json')), ver(path.join(root, 'package.json')), '接口平台版本号要与项目一致');
  const core = fs.readFileSync(path.join(PLATFORM_DIR, 'src', 'core', 'platform.mjs'), 'utf8');
  assert.match(core, /PLATFORM_VERSION = String\(JSON\.parse\(fs\.readFileSync\(new URL\('\.\.\/\.\.\/package\.json'/, '平台代码从 package.json 读版本');
});

test('⑤ 边界：控制中心只经 HTTP 管理接口与平台通信，不导入平台模块、不读写平台数据目录', () => {
  const code = fs.readFileSync(path.join(root, 'src', 'launcher', 'control-center.mjs'), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  for (const bad of ['interface-platform/src', "'interface-platform', 'src', 'core'", 'dsh-comminicate', 'platform.json', "'data-token'", "'admin-token'", 'INTERFACE_PLATFORM_DATA_DIR']) {
    assert.ok(!code.includes(bad), `control-center.mjs 不得包含「${bad}」`);
  }
  for (const imp of code.matchAll(/^import .* from '([^']+)';$/gm)) assert.ok(!/interface-platform/.test(imp[1]), `不得导入平台模块：${imp[1]}`);
  assert.match(code, /INTERFACE_PLATFORM_ADMIN_TOKEN: platformKey/, '管理令牌由控制中心保管并在启动时交给平台');
  assert.match(code, /\/v1\/admin\/bridge-link/, '桥接凭据经管理接口获取');
  for (const f of ['src/bridge.js', 'src/mcp-snowluma-safe.js', 'src/snowluma-conn.js']) {
    assert.ok(!fs.readFileSync(path.join(root, f), 'utf8').includes('interface-platform/'), `${f} 不得引用平台目录`);
  }
});

test('⑥ 开启卡：NapCat 与 SnowLuma 各自开启/关闭、可同时开启互不干扰（测试里不启动真实 QQ / SnowLuma）', { timeout: 60_000, skip: SKIP }, async () => {
  const nap = await createFakeSnowLuma({ token: 'nap-tok', selfId: 10001, authStyle: 'napcat' });
  const snow = await createFakeSnowLuma({ token: 'snow-tok', selfId: 10002 });
  const d = tmp();
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ version: '9.9.9-test' }));
  fs.mkdirSync(path.join(d, 'node_modules'));
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ ownerQQ: 12345678 }));
  // 假 NapCat 配置目录（按 NapCat 的文件名与字段）与假 SnowLuma 配置目录
  const napHome = path.join(d, 'napcat-home');
  fs.mkdirSync(path.join(napHome, 'config'), { recursive: true });
  fs.writeFileSync(path.join(napHome, 'config', 'onebot11_10001.json'), JSON.stringify({ network: { websocketServers: [{ enable: true, host: '127.0.0.1', port: nap.port, token: nap.token }] } }));
  const pdir = path.join(d, 'platform-data');
  fs.mkdirSync(pdir, { recursive: true });
  // 平台里预先只有一个连接假 SnowLuma 的实例（模拟 Windows 上已有的配置）
  fs.writeFileSync(path.join(pdir, 'platform.json'), JSON.stringify({ instances: [{ id: 'snowluma-main', provider: 'snowluma', enabled: false, upstream: { wsUrl: snow.url, accessToken: snow.token } }] }));
  const net = await import('node:net');
  const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const port = await freePort();
  const napWebui = await freePort(); // 本机可能真的在跑 NapCat（6099），测试用一个空闲端口代替
  fs.mkdirSync(path.join(d, 'state'), { recursive: true });
  // napcatQQApp 指向不存在的路径：开启卡不会去启动真实 QQ，只做「建实例 + 连接」
  fs.writeFileSync(path.join(d, 'state', 'control-center.json'), JSON.stringify({ platformPort: port, napcatQQApp: path.join(d, 'no-QQ.app'), napcatCommand: '', napcatHome: napHome, napcatWebuiPort: napWebui }));
  const prevData = process.env.INTERFACE_PLATFORM_DATA_DIR;
  process.env.INTERFACE_PLATFORM_DATA_DIR = pdir;
  const cc = await startControlCenter({ open: false, port: 0, root: d, bridgeEntry: path.join(d, 'nope.mjs'), platformEntry: path.join(PLATFORM_DIR, 'src', 'index.mjs'), installSignalHandlers: false, exitOnShutdown: false, log: () => {} });
  const T = cc.token;
  try {
    assert.equal(cc.platform.running, false);
    // 开启 NapCat：自动启动接口平台、新建 napcat-main 并连上
    const on = await api(cc.port, T, 'POST', '/api/backends/napcat/on', {});
    assert.equal(on.body.ok, true, JSON.stringify(on.body));
    assert.ok(on.body.steps.some((t) => t.includes('已启动接口平台')));
    assert.ok(on.body.steps.some((t) => t.includes('没有启动 NapCat')), `找不到 QQ 时不启动程序，只连接：${on.body.steps.join(' | ')}`);
    assert.equal(cc.napcat.running, false);
    nap.heartbeat();
    let st = await until(async () => { nap.heartbeat(); const s = await api(cc.port, T, 'GET', '/api/state'); return s.body.platform.overview?.accounts?.find((a) => a.account === 'qq:10001' && a.health.ioReady) && s; }, 10_000, 'NapCat 账号就绪');
    assert.equal(st.body.platform.overview.instances.find((i) => i.id === 'napcat-main').provider, 'napcat');
    // 开启 SnowLuma：连接已有实例（没选目录，不启动程序）；两者同时在线
    const on2 = await api(cc.port, T, 'POST', '/api/backends/snowluma/on', {});
    assert.ok(on2.body.steps.some((t) => t.includes('已连接实例 snowluma-main')), JSON.stringify(on2.body));
    st = await until(async () => { nap.heartbeat(); snow.heartbeat(); const s = await api(cc.port, T, 'GET', '/api/state'); return (s.body.platform.overview?.accounts ?? []).filter((a) => a.health.ioReady).length === 2 && s; }, 10_000, '两个后端同时就绪');
    // 关闭 SnowLuma 不影响 NapCat
    const off = await api(cc.port, T, 'POST', '/api/backends/snowluma/off', {});
    assert.ok(off.body.steps.some((t) => t.includes('已断开实例 snowluma-main')));
    await until(() => snow.connections === 0, 5000, 'SnowLuma 链路断开');
    st = await api(cc.port, T, 'GET', '/api/state');
    assert.equal(st.body.platform.overview.accounts.find((a) => a.account === 'qq:10001').health.backendReachable, true, 'NapCat 不受影响');
    assert.equal(nap.connections, 1);
    assert.equal((await api(cc.port, T, 'POST', '/api/backends/wechat/on', {})).status, 404, '未知后端没有开启卡');
  } finally {
    await cc.shutdown('test');
    await nap.close();
    await snow.close();
    if (prevData === undefined) delete process.env.INTERFACE_PLATFORM_DATA_DIR; else process.env.INTERFACE_PLATFORM_DATA_DIR = prevData;
  }
});

test('⑧ 平台里默认生成的 SnowLuma 实例（没有目录也没有令牌）：控制中心知道 SnowLuma 目录时自动补上，按账号连上；用户自己配过令牌的实例不动', { timeout: 60_000, skip: SKIP }, async () => {
  const snow = await createFakeSnowLuma({ token: 'snow-tok', selfId: 10002 });
  const d = tmp();
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ version: '9.9.9-test' }));
  fs.mkdirSync(path.join(d, 'node_modules'));
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ ownerQQ: 12345678 }));
  // 假 SnowLuma 目录：账号配置里是假后端的端口与令牌（与真实 SnowLuma 的 config/onebot_<QQ>.json 同格式）
  const snowDir = path.join(d, 'SnowLuma-test');
  fs.mkdirSync(path.join(snowDir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(snowDir, 'package.json'), JSON.stringify({ name: '@snowluma/runtime', version: '2.0.3' }));
  fs.writeFileSync(path.join(snowDir, 'index.mjs'), '');
  fs.writeFileSync(path.join(snowDir, 'launcher.bat'), '');
  fs.writeFileSync(path.join(snowDir, 'config', 'onebot_10002.json'), JSON.stringify({ networks: { wsServers: [{ host: '127.0.0.1', port: snow.port, accessToken: snow.token }] } }));
  const pdir = path.join(d, 'platform-data');
  fs.mkdirSync(pdir, { recursive: true });
  // 升级场景：平台里有一个只带默认值的 snowluma-main，外加一个用户自己配了令牌的实例
  fs.writeFileSync(path.join(pdir, 'platform.json'), JSON.stringify({ instances: [
    { id: 'snowluma-main', provider: 'snowluma', enabled: true, upstream: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '', homeDir: '' } },
    { id: 'snowluma-mine', provider: 'snowluma', enabled: false, upstream: { wsUrl: 'ws://127.0.0.1:1', accessToken: 'my-token', homeDir: '' } },
  ] }));
  const net = await import('node:net');
  const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  fs.mkdirSync(path.join(d, 'state'), { recursive: true });
  fs.writeFileSync(path.join(d, 'state', 'control-center.json'), JSON.stringify({ platformPort: port, snowlumaDir: snowDir }));
  const prevData = process.env.INTERFACE_PLATFORM_DATA_DIR;
  process.env.INTERFACE_PLATFORM_DATA_DIR = pdir;
  const cc = await startControlCenter({ open: false, port: 0, root: d, bridgeEntry: path.join(d, 'nope.mjs'), platformEntry: path.join(PLATFORM_DIR, 'src', 'index.mjs'), installSignalHandlers: false, exitOnShutdown: false, log: () => {} });
  const T = cc.token;
  try {
    assert.equal((await api(cc.port, T, 'POST', '/api/platform/start', {})).body.ok, true);
    const st = await until(async () => {
      snow.heartbeat();
      const s = await api(cc.port, T, 'GET', '/api/state');
      const main = s.body.platform.overview?.instances?.find((i) => i.id === 'snowluma-main');
      return main?.upstream?.homeDir && (main.links ?? []).some((l) => l.state === 'open' && l.account === 'qq:10002') && s;
    }, 20_000, 'snowluma-main 自动补上目录并连上');
    const insts = st.body.platform.overview.instances;
    assert.equal(path.resolve(insts.find((i) => i.id === 'snowluma-main').upstream.homeDir), path.resolve(snowDir));
    assert.equal(insts.find((i) => i.id === 'snowluma-mine').upstream.homeDir, '', '用户自己配了令牌的实例不动');
    const logs = await api(cc.port, T, 'GET', '/api/logs?source=platform&after=0');
    assert.ok(logs.body.lines.some((l) => l.text.includes('已自动补上目录')), '在平台日志里说明做了什么');
  } finally {
    await cc.shutdown('test');
    await snow.close();
    if (prevData === undefined) delete process.env.INTERFACE_PLATFORM_DATA_DIR; else process.env.INTERFACE_PLATFORM_DATA_DIR = prevData;
  }
});
