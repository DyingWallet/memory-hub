#!/usr/bin/env node
/**
 * fix-session-surrogates.mjs 的回归测试：干净文件不动、孤立代理被替换、
 * 末尾半行需要 --trim-tail、中间行损坏必须拒绝、备份落在指定目录。
 *
 *   node scripts/test-fix-session-surrogates.mjs
 *
 * 注意：子进程一律 `stdio: 'inherit'`。DSH 沙箱禁止用管道捕获另一个程序的
 * stdio（EPERM），用 pipe 会让这个测试在本机直接不可运行。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXER = path.join(here, 'fix-session-surrogates.mjs');
const dir = path.join(here, '..', 'tests', '.tmp-surrogates');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

const write = (name, lines) => {
  const text = lines.join('\n') + '\n';
  fs.writeFileSync(path.join(dir, name), zlib.zstdCompressSync(Buffer.from(text, 'utf8')));
};
const read = (name) => zlib.zstdDecompressSync(fs.readFileSync(path.join(dir, name))).toString('utf8');

/** 与 fixer 相同口径：找孤立的 \uXXXX 转义（排除被转义的 \\u 字面量）。 */
function loneEscapes(text) {
  const re = /\\u([0-9a-fA-F]{4})/g;
  const tokens = [];
  let m;
  while ((m = re.exec(text))) {
    let n = 0;
    let i = m.index - 1;
    while (i >= 0 && text[i] === '\\') {
      n++;
      i--;
    }
    if (n % 2 === 1) continue;
    tokens.push({ start: m.index, code: parseInt(m[1], 16), end: m.index + m[0].length });
  }
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.code >= 0xd800 && t.code <= 0xdbff) {
      const nxt = tokens[i + 1];
      if (nxt && nxt.code >= 0xdc00 && nxt.code <= 0xdfff && nxt.start === t.end) {
        i++;
        continue;
      }
      out.push(t);
    } else if (t.code >= 0xdc00 && t.code <= 0xdfff) out.push(t);
  }
  return out;
}

let failures = 0;
const check = (cond, label, extra = '') => {
  if (cond) console.log('ok   ' + label);
  else {
    failures++;
    console.log('FAIL ' + label + (extra ? ' :: ' + extra : ''));
  }
};
const run = (args) => spawnSync(process.execPath, [FIXER, ...args], { stdio: 'inherit' });
const validJson = (text) =>
  text
    .split('\n')
    .filter(Boolean)
    .every((line) => {
      try {
        JSON.parse(line);
        return true;
      } catch {
        return false;
      }
    });

// --- case 1: 干净文件（完整 emoji + 字面 \\ud83d）不应被改 -------------------
write('clean.v4.jsonl.zstd', [
  JSON.stringify({ type: 'session', id: 'clean' }),
  JSON.stringify({ data: { text: '完整 \u{1F357} 和字面量 \\ud83d 还有 \u{1F35A}' } }),
  JSON.stringify({ type: 'turn/end' }),
]);
const cleanBefore = read('clean.v4.jsonl.zstd');
let r = run([path.join(dir, 'clean.v4.jsonl.zstd'), '--apply', '--backup-dir', path.join(dir, 'bk')]);
check(r.status === 0, 'clean: exit 0', String(r.status));
check(read('clean.v4.jsonl.zstd') === cleanBefore, 'clean: unchanged');

// --- case 2: 孤立高/低代理应替换成 U+FFFD ----------------------------------
write('bad.v4.jsonl.zstd', [
  JSON.stringify({ type: 'session', id: 'bad' }),
  JSON.stringify({ data: { text: '高代理 ' + '\ud83c' } }),
  JSON.stringify({ data: { text: '低代理 ' + '\udf57' } }),
  JSON.stringify({ type: 'turn/end' }),
]);
check(loneEscapes(read('bad.v4.jsonl.zstd')).length === 2, 'bad: 2 lone escapes before');
r = run([path.join(dir, 'bad.v4.jsonl.zstd'), '--apply', '--backup-dir', path.join(dir, 'bk')]);
const badAfter = read('bad.v4.jsonl.zstd');
check(r.status === 0, 'bad: exit 0', String(r.status));
check(loneEscapes(badAfter).length === 0, 'bad: lone escapes gone');
check(badAfter.includes('\\ufffd'), 'bad: replaced with \\ufffd');
check(badAfter.split('\n').filter(Boolean).length === 4, 'bad: line count kept');
check(validJson(badAfter), 'bad: all lines valid JSON');

// --- case 3: 末尾半行默认拒绝，--trim-tail 丢弃 ----------------------------
const tailLines = [JSON.stringify({ type: 'session', id: 'tail' }), JSON.stringify({ data: { text: '前半截' } })];
fs.writeFileSync(
  path.join(dir, 'tail.v4.jsonl.zstd'),
  zlib.zstdCompressSync(Buffer.from(tailLines.join('\n') + '\n{"type":"turn/end","data":{"reason":"o', 'utf8')),
);
const tailBefore = read('tail.v4.jsonl.zstd');
r = run([path.join(dir, 'tail.v4.jsonl.zstd'), '--apply', '--backup-dir', path.join(dir, 'bk')]);
check(r.status === 2, 'tail: refused without --trim-tail', String(r.status));
check(read('tail.v4.jsonl.zstd') === tailBefore, 'tail: untouched when refused');
r = run([path.join(dir, 'tail.v4.jsonl.zstd'), '--apply', '--trim-tail', '--backup-dir', path.join(dir, 'bk')]);
const tailAfter = read('tail.v4.jsonl.zstd');
check(r.status === 0, 'tail: accepted with --trim-tail', String(r.status));
check(tailAfter.split('\n').filter(Boolean).length === 2, 'tail: half line dropped');
check(validJson(tailAfter), 'tail: all lines valid JSON');

// --- case 4: 中间行损坏必须拒绝 --------------------------------------------
fs.writeFileSync(
  path.join(dir, 'mid.v4.jsonl.zstd'),
  zlib.zstdCompressSync(
    Buffer.from([JSON.stringify({ type: 'session' }), '{"broken": ', JSON.stringify({ type: 'turn/end' })].join('\n') + '\n', 'utf8'),
  ),
);
const midBefore = read('mid.v4.jsonl.zstd');
r = run([path.join(dir, 'mid.v4.jsonl.zstd'), '--apply', '--backup-dir', path.join(dir, 'bk')]);
check(r.status === 2, 'mid: refused', String(r.status));
check(read('mid.v4.jsonl.zstd') === midBefore, 'mid: untouched');

// --- case 5: 备份在指定目录，不留在会话目录 --------------------------------
const bkDir = path.join(dir, 'bk');
const bkFiles = fs.existsSync(bkDir) ? fs.readdirSync(bkDir, { recursive: true }).map(String) : [];
check(bkFiles.some((f) => f.includes('bad.v4.jsonl.zstd')), 'backup: created for bad');
check(!fs.readdirSync(dir).some((f) => f.includes('.bak-')), 'backup: no .bak beside sessions');

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
