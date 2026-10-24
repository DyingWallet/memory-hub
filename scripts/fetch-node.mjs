#!/usr/bin/env node
/**
 * 把便携版 Node 装到工作区根部（`../tools/node`），幂等。
 *
 *   node scripts/fetch-node.mjs              # 默认版本（VERSION 常量）
 *   node scripts/fetch-node.mjs v24.22.1     # 指定版本
 *   node scripts/fetch-node.mjs --check      # 只报告，不下载
 *
 * 为什么独立：memd / pet-llm / 桥接都在跑 node，而 DSH 自带的 node 在安装目录里——
 * Windows 会锁住运行中的映像，导致 DSH 升级时无法改名安装目录（ERROR_SHARING_VIOLATION 32）。
 * 把 node 放到 DSH 之外，升级就不用先停这些服务。
 *
 * 下载用 node 的 fetch（本机 curl/IWR 的 TLS 会握手失败），校验用官方的
 * SHASUMS256.txt，解压用 Windows 自带的 tar.exe（不用装 7zip）。
 */
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const VERSION = 'v24.22.1';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const toolsDir = resolve(root, '..', 'tools');
const nodeDir = join(toolsDir, 'node');
const nodeExe = join(nodeDir, 'node.exe');

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const version = args.find((arg) => /^v\d+\.\d+\.\d+$/.test(arg)) ?? VERSION;

const current = () => {
  try {
    return execFileSync(nodeExe, ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
};

if (checkOnly) {
  const found = current();
  console.log(JSON.stringify({ nodeDir, installed: Boolean(found), version: found, expected: version }, null, 2));
  process.exit(found === version ? 0 : 1);
}

if (current() === version) {
  console.log(`already installed: ${nodeExe} (${version})`);
  process.exit(0);
}

const archive = `node-${version}-win-x64.zip`;
const base = `https://nodejs.org/dist/${version}`;
const tmpDir = join(toolsDir, '.download');
mkdirSync(tmpDir, { recursive: true });
const zipPath = join(tmpDir, archive);
const sumsPath = join(tmpDir, 'SHASUMS256.txt');

async function download(url, dest) {
  process.stdout.write(`downloading ${url}\n`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));
}

await download(`${base}/SHASUMS256.txt`, sumsPath);
await download(`${base}/${archive}`, zipPath);

const expectedLine = readFileSync(sumsPath, 'utf8')
  .split('\n')
  .find((line) => line.trim().endsWith(` ${archive}`));
if (!expectedLine) throw new Error(`no SHA256 for ${archive} in SHASUMS256.txt`);
const expected = expectedLine.split(/\s+/)[0];
const actual = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
if (actual !== expected) throw new Error(`sha256 mismatch: expected ${expected}, got ${actual}`);
console.log(`sha256 ok (${actual.slice(0, 16)}…)`);

// tar.exe 能直接解 zip；--strip-components=1 去掉 `node-vX-win-x64/` 顶层目录。
const staging = join(toolsDir, '.staging');
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
execFileSync('tar.exe', ['-xf', zipPath, '-C', staging, '--strip-components=1'], { stdio: 'inherit' });

rmSync(nodeDir, { recursive: true, force: true });
renameSync(staging, nodeDir);
writeFileSync(join(nodeDir, 'VERSION'), `${version}\n`, 'utf8');
rmSync(tmpDir, { recursive: true, force: true });

const installed = current();
console.log(`installed ${installed} -> ${nodeExe}`);
if (installed !== version) {
  console.error('post-install check failed');
  process.exit(1);
}
