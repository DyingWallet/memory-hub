// Windows 实机部署（v1.0.1）反馈的问题的回归测试。全部离线、假数据。
//   ① Release ZIP 的中文文件名必须带 UTF-8 标志（否则 Windows 解压乱码 / 失败），可执行脚本保留 0755；
//   ② 黑话研究日志：「写入 / 解析 / 未确认」分开计数，未确认时把 AI 推测打进日志（仍然不写库）；
//   ③ 会话重置要清掉 qq_wait_for_messages 的等待租约（三个重置入口都要），归一后的 key 也要清；
//   ④ 生成 Linux 服务文件时路径一律用 POSIX 写法（Windows 上跑也不能变成反斜杠）；
//   ⑤ 测试与脚本里不能用 URL.pathname 当文件路径（Windows 上是 /C:/…），要用 fileURLToPath。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createZip, readZip } from './zip-utf8.mjs';
import { serviceUnit, desktopEntry } from './build-linux-service.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('① ZIP：中文文件名带 UTF-8 标志、内容与 CRC 正确、可执行位保留；发布脚本用它而不是系统的 zip / tar', () => {
  const files = [
    { name: 'pkg/roles/小鲸鱼.md', data: Buffer.from('# 示例人格\n'.repeat(50)), mode: 0o100644 },
    { name: 'pkg/assets/deepseek娘.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), mode: 0o100644 },
    { name: 'pkg/control-center.command', data: Buffer.from('#!/bin/zsh\necho hi\n'), mode: 0o100755 },
  ];
  const out = readZip(createZip(files));
  assert.equal(out.length, 3);
  for (const [i, f] of files.entries()) {
    assert.equal(out[i].name, f.name, '文件名按 UTF-8 原样读回');
    assert.ok(out[i].flags & 0x0800, `${f.name} 带 UTF-8 标志（bit 11）`);
    assert.deepEqual(out[i].data, f.data);
    assert.equal(out[i].crc, zlib.crc32(f.data) >>> 0);
    assert.equal(out[i].mode, f.mode, '保留 Unix 权限');
  }
  assert.equal(out[0].method, 8, '能压缩的用 deflate');
  assert.equal(out[1].method, 0, '压缩不划算的直接存储');
  assert.equal(readZip(createZip([{ name: 'a\\b.txt', data: Buffer.from('x') }]))[0].name, 'a/b.txt', 'Windows 路径分隔符转成 /');
  const build = read('scripts/build-release.mjs');
  assert.match(build, /createZip\(entries\)/);
  assert.ok(!/spawnSync\((?:winTar|'zip')/.test(build), '不再调用系统的 zip / tar.exe');
  assert.match(build, /\\\.\(command\|sh\)\$/, '.command / .sh 固定记成可执行');
});

test('② 黑话研究日志：写入数与未确认数分开统计；未确认附 AI 推测但不写库', () => {
  const src = read('src/bridge.js');
  const start = src.indexOf('const results = parseResearchJson(output);');
  assert.ok(start > 0);
  const fn = src.slice(start, src.indexOf('invalidateSlangLearnerSession();', start));
  assert.match(fn, /let written = 0;/);
  assert.match(fn, /let unconfirmed = 0;/);
  assert.match(fn, /黑话研究：写入 \$\{written\} 条候选解释（解析 \$\{results\.length\} 条，未确认 \$\{unconfirmed\} 条）/);
  assert.ok(!fn.includes('已更新 ${results.length} 条候选解释'), '不再用解析条数冒充写入条数');
  const skip = fn.slice(fn.indexOf('if (r.confirmed !== true)'), fn.indexOf('if (r.meaning) entry.meaning'));
  assert.match(skip, /AI 推测/);
  assert.match(skip, /continue;/, '未确认的仍然跳过、不写库');
  assert.ok(!/entry\.(meaning|usage|example)\s*=/.test(skip), '未确认分支里不改词条');
});

test('③ 会话重置清掉等待租约：forgetConversationCaches 连归一后的 key 一起清；三个重置入口都调用它', () => {
  const src = read('src/bridge.js');
  const fc = src.slice(src.indexOf('function forgetConversationCaches(key) {'), src.indexOf('function retireSession(key) {'));
  assert.match(fc, /activeWaits\.delete\(key\);/);
  assert.match(fc, /activeWaits\.delete\(canonicalV2Key\(key\) \?\? key\);/);
  const block = (marker, endMarker) => { const i = src.indexOf(marker); assert.ok(i > 0, marker); return src.slice(i, src.indexOf(endMarker, i)); };
  assert.match(block("url.pathname === '/api/session/reset'", 'archiveSession'), /forgetConversationCaches\(key\);/, '控制台 / 控制中心的「重置会话」');
  assert.match(block("url.pathname === '/api/socialV2/reset'", 'saveState();'), /forgetConversationCaches\(key\);/, '二代仿真全量重置');
  const qqReset = src.slice(src.lastIndexOf('drainPromptQueue(key, \'会话已重置\');'));
  assert.match(qqReset.slice(0, qqReset.indexOf('已重置会话，下次消息将开新上下文')), /forgetConversationCaches\(key\);/, 'QQ 里的 /reset');
});

test('④ Linux 服务文件：路径按 POSIX 拼，不出现反斜杠（在 Windows 上生成也一样）', () => {
  const unit = serviceUnit({ root: '/home/u/qq bridge', node: '/usr/bin/node', pathEnv: '/usr/bin' });
  const desk = desktopEntry({ root: '/home/u/qq bridge', node: '/usr/bin/node' });
  assert.ok(!unit.includes('\\home') && !desk.includes('\\home'), '没有反斜杠路径');
  assert.match(unit, /"\/home\/u\/qq bridge\/src\/launcher\/control-center\.mjs"/);
  const src = read('scripts/build-linux-service.mjs');
  assert.match(src, /const px = path\.posix;/);
  assert.ok(!/const entry = path\.join/.test(src), '生成 Linux 路径不用平台相关的 path.join');
});

test('⑤ 测试与脚本里不用 URL.pathname 当文件路径（Windows 上会变成 C:\\C:\\…）', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'state', '.git', 'dist'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(m?js)$/.test(e.name) && p !== fileURLToPath(import.meta.url)) {
        const txt = fs.readFileSync(p, 'utf8');
        if (/import\.meta\.url\)\.pathname/.test(txt)) offenders.push(path.relative(root, p));
      }
    }
  };
  for (const d of ['scripts', 'src', 'interface-platform/src', 'interface-platform/test']) walk(path.join(root, d));
  assert.deepEqual(offenders, [], `改用 fileURLToPath(import.meta.url)：${offenders.join('、')}`);
});
