// macOS 无窗口启动 App（scripts/build-mac-app.mjs）离线测试：脚本内容的约定；在 macOS 上实际编译一次（不运行）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appleScriptSource, buildMacApp, APP_NAME, BUNDLE_ID } from './build-mac-app.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('App 脚本：后台启动控制中心（nohup、输出进日志、不占 stdin）；再次双击走 reopen；控制中心退出后 App 自己退出', () => {
  const s = appleScriptSource();
  assert.match(s, /on run[\s\S]*startCenter\(\)/);
  assert.match(s, /on reopen[\s\S]*startCenter\(\)/, '再次双击只重新打开页面（控制中心单实例）');
  assert.match(s, /on idle[\s\S]*if not centerRunning\(\) then quit/);
  assert.match(s, /nohup node .*>> state\/control-center-app\.log 2>&1 < \/dev\/null &/);
  assert.match(s, /quoted form of d/, '路径一律 quoted form，不直接拼进 shell');
  assert.match(s, /\(text 1 thru -2 of pat\) & "\[s\]"/, 'pgrep 不会匹配到自己所在的 sh');
  assert.ok(!/SnowLuma|launcher\.bat/i.test(s), 'App 不启停 SnowLuma');
  assert.ok(!/QQ\.app|napcat/i.test(s), 'App 不启动 QQ / NapCat，只启动控制中心');
});

test('control-center.command 第一次运行时自动生成 App：只在 App 不存在时生成、失败不影响启动、可用环境变量关闭', () => {
  const s = fs.readFileSync(path.join(root, 'control-center.command'), 'utf8');
  const gen = s.indexOf('node scripts/build-mac-app.mjs');
  const start = s.indexOf('node src/launcher/control-center.mjs');
  assert.ok(gen > 0 && start > gen, '先（按需）生成 App，再启动控制中心');
  assert.match(s, /if \[\[ ! -d "\$APP" && -z "\$QQ_BRIDGE_NO_MAC_APP" \]\]; then/, '只在 App 不存在、且没关掉时生成');
  assert.match(s, /APP="QQ Bridge 控制中心\.app"/);
  assert.match(s, /else\n\s+echo "\[qq-bridge\] 没能生成 App/, '生成失败只提示，不退出');
  assert.ok(!/build-mac-app\.mjs[^\n]*\|\|\s*exit/.test(s), '生成失败不会中断启动');
});

test('不入库：生成的 .app 在 .gitignore 里；有 npm run mac-app', () => {
  assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /^\/\*\.app\/$/m);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts['mac-app'], 'node scripts/build-mac-app.mjs');
});

test('macOS：实际生成到临时目录——常驻、无 Dock 图标、自己的 Bundle ID、本机签名有效', { skip: process.platform !== 'darwin' && '只能在 macOS 上生成' }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-mac-app-test-'));
  const app = buildMacApp({ outDir: out });
  assert.equal(path.basename(app), `${APP_NAME}.app`);
  const info = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }));
  assert.equal(info.LSUIElement, true);
  assert.equal(info.OSAAppletStayOpen, true);
  assert.equal(info.CFBundleIdentifier, BUNDLE_ID);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', app]);
  fs.rmSync(out, { recursive: true, force: true });
});
