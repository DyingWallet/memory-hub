import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * cordis.patch.yml 的写入者必须保持「无 UTF-8 BOM」。
 *
 * DSH 0.2.2 能读带 BOM 的 patch：启动、热加载、settings/describe 全部正常，
 * 只有 settings/update 回 `settings/rejected: Unexpected scalar at node end`。
 * 表现是插件全绿、qq-mode 模式却写不穿（只在本地生效），是最难发现的一类
 * 升级回归。根因是 Windows PowerShell 5.1 的 `Set-Content -Encoding UTF8`
 * 默认写 BOM（2026-11-12 在 install-sleep-preset.ps1 上实测）。
 *
 * 这里只钉住仓库里的写入者与检查者；真实 profile 文件由
 * doctor.mjs 的 `profile.patchBom` 与 post-upgrade.ps1 的 `patch BOM` 项检查。
 */
const read = (rel: string) => readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8');

test('install-sleep-preset.ps1 用无 BOM 的 UTF-8 写 patch', () => {
  const script = read('scripts/install-sleep-preset.ps1');
  assert.ok(
    !/^\s*Set-Content[^\n]*-Encoding UTF8/m.test(script),
    'PS 5.1 的 Set-Content -Encoding UTF8 会给 cordis.patch.yml 加 BOM，DSH 0.2.2 会拒绝 settings/update',
  );
  assert.ok(
    /\[System\.IO\.File\]::WriteAllText/.test(script),
    '写 patch 必须走 WriteAllText',
  );
  assert.ok(
    /UTF8Encoding\(\$false\)/.test(script),
    '必须显式构造无 BOM 的 UTF8Encoding($false)',
  );
});

test('doctor.mjs 把 patch 的 BOM 当核心检查项', () => {
  const doctor = read('scripts/doctor.mjs');
  assert.ok(doctor.includes('profile.patchBom'), 'doctor 必须有 profile.patchBom 检查');
  assert.ok(doctor.includes('0xef') && doctor.includes('0xbb'), 'BOM 判据应为 EF BB BF');
});

test('post-upgrade.ps1 带 BOM 检查与 -FixBom', () => {
  const script = read('scripts/post-upgrade.ps1');
  assert.ok(/\[switch\]\$FixBom/.test(script), 'post-upgrade 要提供 -FixBom 一键修复');
  assert.ok(script.includes("Add-Result 'patch BOM'"), '结果表里要有 patch BOM 项');
});

test('setup-dsh-mcp.mjs 读 patch 时剥 BOM，--check 报 BOM', () => {
  const script = read('scripts/setup-dsh-mcp.mjs');
  assert.ok(script.includes('stripBom'), '写回前必须剥掉 BOM');
  assert.ok(script.includes('patchHasBom'), '--check 要报 patchHasBom');
});
