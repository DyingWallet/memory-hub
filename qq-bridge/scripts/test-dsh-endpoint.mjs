// v0.4.1 回归：DSH 地址自动识别。显式配置照用；留空时桌面版优先 19387，否则 3080；
// 异步版本挑第一个能连上的端口。用临时 DSH_HOME 和临时监听端口，不碰真实 DSH。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { dshBaseUrlCandidates, detectDshDesktop, resolveDshBaseUrl } from '../src/lib/dsh-endpoint.mjs';

function fakeHome({ desktop }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-dshhome-'));
  if (desktop) {
    const d = path.join(home, 'dsh-runtimes', 'r1');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'runtime.json'), JSON.stringify({ desktopVersion: '0.2.0-rc.2' }));
  }
  // 指向不存在的 App 包：在装了 DSH 桌面版的 Mac 上跑测试时，不让真实的 /Applications 干扰结果
  return { DSH_HOME: home, DSH_DESKTOP_APP: path.join(home, 'no-such.app') };
}

test('显式 baseUrl 照用（去掉末尾斜杠）', () => {
  assert.deepEqual(dshBaseUrlCandidates('http://127.0.0.1:19387/', fakeHome({ desktop: false })), ['http://127.0.0.1:19387']);
});

test('留空：桌面版优先 19387，命令行版优先 3080', () => {
  const desk = fakeHome({ desktop: true });
  assert.equal(detectDshDesktop(desk), '0.2.0-rc.2');
  assert.deepEqual(dshBaseUrlCandidates('', desk), ['http://127.0.0.1:19387', 'http://127.0.0.1:3080']);
  const cli = fakeHome({ desktop: false });
  assert.equal(detectDshDesktop(cli), null);
  assert.deepEqual(dshBaseUrlCandidates(undefined, cli), ['http://127.0.0.1:3080', 'http://127.0.0.1:19387']);
});

test('异步解析：显式地址能连上 → reachable；连不上 → 回退到第一个候选', async () => {
  const srv = net.createServer((s) => s.end());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const ok = await resolveDshBaseUrl(url, { env: fakeHome({ desktop: false }) });
  assert.deepEqual([ok.url, ok.auto, ok.reachable], [url, false, true]);
  await new Promise((r) => srv.close(r));
  const bad = await resolveDshBaseUrl(url, { env: fakeHome({ desktop: false }), timeoutMs: 300 });
  assert.deepEqual([bad.url, bad.reachable], [url, false]);
});

test('macOS：没有 dsh-runtimes 时按桌面版 App 包的 Info.plist 识别（DSH 未启动也优先 19387）', () => {
  const env = fakeHome({ desktop: false });
  const app = path.join(env.DSH_HOME, 'DeepSeek Harness.app');
  fs.mkdirSync(path.join(app, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleShortVersionString</key>\n<string>0.2.0-rc.2</string></dict></plist>');
  const macEnv = { ...env, DSH_DESKTOP_APP: app };
  assert.equal(detectDshDesktop(macEnv, { platform: 'darwin' }), '0.2.0-rc.2');
  assert.equal(detectDshDesktop(macEnv, { platform: 'win32' }), null, 'Windows 上不看 App 包');
  if (process.platform === 'darwin') assert.deepEqual(dshBaseUrlCandidates('', macEnv), ['http://127.0.0.1:19387', 'http://127.0.0.1:3080']);
});

// ── DSH 桌面版 0.2.1：随机端口的动态发现 ────────────────────────────────────────
import http from 'node:http';
import { parseLsofPorts, parseNetstatPorts, parseTasklistPids, listDesktopListenPorts, listLoopbackListenPorts, parseAnyLoopbackPorts, looksLikeDsh } from '../src/lib/dsh-endpoint.mjs';
import { NodeApiClient } from '../src/dsh-client.js';

test('解析：lsof / netstat / tasklist 只取 DSH 进程的回环监听端口', async () => {
  assert.deepEqual(parseLsofPorts('p99338\nf26\nn127.0.0.1:57764\nf27\nn*:9999\nn[::1]:50000\n'), [57764, 50000], '只要回环地址，不要 *:端口');
  assert.deepEqual(parseTasklistPids('"DeepSeek Harness.exe","4321","Console","1","120,000 K"\n"node.exe","999","Console","1","1 K"\n'), ['4321']);
  const netstat = '  TCP    127.0.0.1:61001        0.0.0.0:0              LISTENING       4321\n  TCP    127.0.0.1:3100         0.0.0.0:0              LISTENING       999\n  TCP    0.0.0.0:61002          0.0.0.0:0              LISTENING       4321\n';
  assert.deepEqual(parseNetstatPorts(netstat, ['4321']), [61001], '只要该 PID 的回环端口');
  // 注入 exec：mac 走 lsof，win 先 tasklist 再 netstat，其它平台不查
  const mac = await listDesktopListenPorts({ platform: 'darwin', exec: async (f) => (f.endsWith('lsof') ? 'n127.0.0.1:57764\n' : '') });
  assert.deepEqual(mac, [57764]);
  const win = await listDesktopListenPorts({ platform: 'win32', exec: async (f) => (f.endsWith('tasklist.exe') ? '"DeepSeek Harness.exe","4321"\n' : netstat) });
  assert.deepEqual(win, [61001]);
  assert.deepEqual(await listDesktopListenPorts({ platform: 'linux', exec: async () => 'n127.0.0.1:1\n' }), []);
});

test('特征确认：只认 DSH 的 401 提示文字；别的服务（200 / 其它 401）不认', async () => {
  const mk = (status, body) => new Promise((r) => { const s = http.createServer((q, res) => { res.writeHead(status, { 'content-type': 'text/plain' }); res.end(body); }); s.listen(0, '127.0.0.1', () => r(s)); });
  const dsh = await mk(401, 'dsh web authentication required; reopen the URL printed by dsh web.');
  const other = await mk(401, 'Unauthorized');
  const ok200 = await mk(200, 'hello');
  try {
    assert.equal(await looksLikeDsh(`http://127.0.0.1:${dsh.address().port}`), true);
    assert.equal(await looksLikeDsh(`http://127.0.0.1:${other.address().port}`), false);
    assert.equal(await looksLikeDsh(`http://127.0.0.1:${ok200.address().port}`), false);
    assert.equal(await looksLikeDsh('http://127.0.0.1:9', { timeoutMs: 300 }), false, '连不上就是不认');
  } finally { for (const s of [dsh, other, ok200]) await new Promise((r) => s.close(r)); }
});

test('解析顺序：显式地址照用不发现；留空时固定端口连不上才动态发现，且必须通过特征确认', async () => {
  const env = fakeHome({ desktop: false });
  const listPorts = async () => [41001, 41002];
  const probe = async (u) => u.endsWith(':41002');
  const r = await resolveDshBaseUrl('', { env, timeoutMs: 200, listPorts, probe });
  assert.deepEqual([r.url, r.reachable, r.discovered], ['http://127.0.0.1:41002', true, true]);
  let called = false;
  const explicit = await resolveDshBaseUrl('http://127.0.0.1:9', { env, timeoutMs: 200, listPorts: async () => { called = true; return [41002]; }, probe });
  assert.equal(explicit.url, 'http://127.0.0.1:9');
  assert.equal(called, false, '显式配置时不做动态发现');
  const none = await resolveDshBaseUrl('', { env, timeoutMs: 200, listPorts, anyPorts: null, probe: async () => false });
  assert.equal(none.reachable, false, '特征不符的端口不采用');
});

test('兜底：DSH 进程名下没有端口时，扫全部回环监听端口并靠 401 特征确认', async () => {
  // Electron 把 web 服务放在 helper 子进程里：主进程 PID 名下没有回环端口。
  const netstat = [
    '  TCP    127.0.0.1:7642         0.0.0.0:0              LISTENING       9999',
    '  TCP    127.0.0.1:8787         0.0.0.0:0              LISTENING       8888',
    '  TCP    0.0.0.0:7643           0.0.0.0:0              LISTENING       9999',
  ].join('\r\n');
  assert.deepEqual(parseAnyLoopbackPorts(netstat), [7642, 8787], '只取回环监听，不要 0.0.0.0');
  assert.deepEqual(
    await listLoopbackListenPorts({ platform: 'win32', exec: async (file) => (file.endsWith('netstat.exe') ? netstat : '') }),
    [7642, 8787],
  );
  assert.deepEqual(await listLoopbackListenPorts({ platform: 'linux', exec: async () => netstat }), [], '其它平台不查');

  const env = fakeHome({ desktop: false });
  const probed = [];
  const r = await resolveDshBaseUrl('', {
    env,
    timeoutMs: 120,
    listPorts: async () => [],
    anyPorts: async () => [8787, 7642, 8790],
    probe: async (url) => {
      probed.push(url);
      return url.endsWith(':7642');
    },
  });
  assert.deepEqual([r.url, r.reachable, r.discovered], ['http://127.0.0.1:7642', true, true]);
  assert.equal(probed.some((url) => url.endsWith(':8787')), false, '跳过 memd 自己的端口');
  assert.equal(probed.some((url) => url.endsWith(':8790')), false, '跳过 pet 自己的端口');
});

test('DSH 客户端换地址：baseUrl 更新并让旧凭据失效（Cookie 绑定 host:port）', () => {
  const api = new NodeApiClient('http://127.0.0.1:19387', undefined, {});
  api.cookie = 'old-cookie';
  assert.equal(api.setBaseUrl('http://127.0.0.1:57764/'), true);
  assert.equal(api.baseUrl, 'http://127.0.0.1:57764');
  assert.equal(api.cookie, null, '旧 Cookie 作废');
  assert.equal(api.setBaseUrl('http://127.0.0.1:57764'), false, '没变化时不动');
});

test('桥接接线：留空自动识别时，DSH 不可用期间定期重新识别并切换地址', () => {
  const src = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  const seg = src.slice(src.indexOf('const checkDsh = async () => {'), src.indexOf('const checkDsh = async () => {') + 1500);
  assert.match(seg, /!ok && dshBaseUrlAuto/, '只在自动识别模式、DSH 不可用时重新识别');
  assert.match(seg, /api\.setBaseUrl\(ep\.url\)/, '切换到新地址');
  assert.match(src, /dshBaseUrlAuto = ep\.auto;/);
});

test('preset：不再使用 DSH 0.2.1 不认的提示词变量（cwd）', () => {
  for (const dir of fs.readdirSync(new URL('../dsh/agent-presets/', import.meta.url))) {
    const f = new URL(`../dsh/agent-presets/${dir}/agent.cordis.yml`, import.meta.url);
    if (!fs.existsSync(f)) continue;
    assert.ok(!fs.readFileSync(f, 'utf8').includes('{{cwd}}'), `${dir} 不得使用 {{cwd}}`);
  }
  for (const f of fs.readdirSync(new URL('../plugins/qq-agent-presets/presets/', import.meta.url))) {
    assert.ok(!fs.readFileSync(new URL(`../plugins/qq-agent-presets/presets/${f}`, import.meta.url), 'utf8').includes('{{cwd}}'), `${f} 不得使用 {{cwd}}`);
  }
});
