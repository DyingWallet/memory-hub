#!/usr/bin/env node
/**
 * 修复 DSH 会话文件里的「孤立代理项」（lone surrogate）。
 *
 * 背景（2026-11-04 事故）：QQ 桥接把含 emoji 的文本按 UTF-16 码元截断，留下半个
 * 字符（例如 🍗 只剩高代理 U+D83C）。这个坏字符被写进 DSH 会话后，DeepSeek
 * Messages API 的 JSON 解析器会拒绝整份请求：
 *
 *   400 Failed to parse the request body as JSON:
 *       messages[0].content[0].text: unexpected end of hex escape
 *
 * 而 DSH 只把 400 显示成 "DeepSeek Messages request failed (400)"，且 400 不在
 * 重试白名单里 —— 会话从此每次唤醒都失败，不会自愈。
 *
 * 本脚本把会话文件里所有孤立的 \uD800-\uDFFF 转义替换成 U+FFFD（�），
 * 语义上只丢半个 emoji，不动任何其它内容。
 *
 * 用法：
 *   node fix-session-surrogates.mjs                        # 扫描，dry-run
 *   node fix-session-surrogates.mjs --apply                # 写回（默认备份到 <DSH_HOME>/session-backups）
 *   node fix-session-surrogates.mjs <file...> [--apply]    # 只处理指定文件
 *
 * 选项：
 *   --apply                真正写入（默认只扫描）
 *   --trim-tail            丢弃文件末尾那半行（DSH 被强杀时可能在写的半条记录）
 *   --backup-dir <dir>     备份目录（默认 <DSH_HOME>/session-backups/<时间戳>/）
 *   --quiet                少输出（给自动化调用）
 *
 * 退出码：0 成功（含「没有坏字符」）、2 结构校验失败拒绝写入、3 环境不满足。
 *
 * 注意：DSH 会持有会话文件句柄并继续追加，**必须在 DSH 退出后**再 --apply，
 * 否则改动会被内存态覆盖。改完重启 DSH 才会重新加载。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

// --- 环境检查：zstd 需要 node >= 22.15 -------------------------------------
if (typeof zlib.zstdDecompressSync !== 'function' || typeof zlib.zstdCompressSync !== 'function') {
  console.error(`[fatal] 当前 node ${process.version} 没有 zlib 的 zstd 支持（需要 >= 22.15）。`);
  console.error('        用工作区便携版：tools\\node\\node.exe');
  process.exit(3);
}

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const trimTail = argv.includes('--trim-tail');
const quiet = argv.includes('--quiet');
const backupDirArg = (() => {
  const i = argv.indexOf('--backup-dir');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : '';
})();
const explicit = argv.filter((a, i) => {
  if (a.startsWith('--')) return false;
  if (argv[i - 1] === '--backup-dir') return false;
  return true;
});

const dshHome = process.env.DSH_HOME
  ? path.resolve(process.env.DSH_HOME)
  : path.join(os.homedir(), '.dsh');

const log = (...args) => {
  if (!quiet) console.log(...args);
};

// 写回重试：DSH 强杀后句柄释放有延迟，杀软也可能短暂占用。
const WRITE_ATTEMPTS = 10;
const WRITE_RETRY_MS = 800;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** JSON 文本里位于 index 之前的连续反斜杠数量：用于区分真正的转义和字面量 `\\u`。 */
function backslashRunBefore(text, index) {
  let n = 0;
  let i = index - 1;
  while (i >= 0 && text[i] === '\\') {
    n++;
    i--;
  }
  return n;
}

/** 找 JSON 文本里所有 \uXXXX 转义，判断哪些是孤立的。返回待替换的 [start, end) 区间。 */
function loneEscapeRanges(text) {
  const re = /\\u([0-9a-fA-F]{4})/g;
  const tokens = [];
  let m;
  while ((m = re.exec(text))) {
    // `\\ud83c`（被转义的反斜杠后跟 ud83c）是字面文本，不是转义序列。
    if (backslashRunBefore(text, m.index) % 2 === 1) continue;
    tokens.push({ start: m.index, end: m.index + m[0].length, code: parseInt(m[1], 16) });
  }
  const ranges = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.code >= 0xd800 && t.code <= 0xdbff) {
      const next = tokens[i + 1];
      if (next && next.code >= 0xdc00 && next.code <= 0xdfff && next.start === t.end) {
        i++; // 合法代理对，一起跳过
        continue;
      }
      ranges.push(t);
    } else if (t.code >= 0xdc00 && t.code <= 0xdfff) {
      ranges.push(t);
    }
  }
  return ranges;
}

/** 文件里直接以 UTF-8 存下来的孤立代理（理论上不可能，保险起见也处理）。 */
function hasRawLoneSurrogate(text) {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = text.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

function fixText(text) {
  const ranges = loneEscapeRanges(text);
  let out = text;
  if (ranges.length > 0) {
    out = '';
    let cursor = 0;
    for (const r of ranges) {
      out += text.slice(cursor, r.start) + '\\ufffd';
      cursor = r.end;
    }
    out += text.slice(cursor);
  }
  if (hasRawLoneSurrogate(out)) out = out.toWellFormed();
  return { text: out, fixed: ranges.length };
}

function candidateSessions(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      // 真实布局：<root>/<cwd-key>/<session-id>/session.v4.jsonl.zstd
      // 只看 session.v4*。.bak-* 之类不会被当会话（见下方备份命名）。
      if (entry.isFile() && /^session\.v\d+\.jsonl(\.zstd)?$/u.test(entry.name)) out.push(full);
    }
  };
  walk(root);
  return out;
}

const sessionsRoot = path.join(dshHome, 'sessions');
const files = explicit.length > 0 ? explicit : candidateSessions(sessionsRoot);

if (files.length === 0) {
  log('没有找到会话文件。');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
// --backup-dir 是**根目录**，每次运行在其下建时间戳子目录；否则第二次运行会
// 覆盖上一次的备份（2026-11-04 实际踩到：recovery 传根目录时旧备份被覆盖）。
const backupRoot = backupDirArg ? path.resolve(backupDirArg) : path.join(dshHome, 'session-backups');
const backupDir = path.join(backupRoot, stamp);

let touched = 0;
let refused = 0;
let writeFailed = 0;

for (const file of files) {
  const raw = fs.readFileSync(file);
  const isZstd = file.endsWith('.zstd');
  let text;
  try {
    text = isZstd ? zlib.zstdDecompressSync(raw).toString('utf8') : raw.toString('utf8');
  } catch (error) {
    console.log(`[skip] ${file}: 解压失败 ${error.message}`);
    refused++;
    continue;
  }

  const lines = text.split('\n');
  let tailBroken = false;
  let parseFail = 0;
  let lastNonEmpty = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    lastNonEmpty = i;
  }
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try {
      JSON.parse(lines[i]);
    } catch {
      if (i === lastNonEmpty) tailBroken = true;
      else parseFail++;
    }
  }
  if (parseFail > 0) {
    console.log(`[abort] ${path.basename(path.dirname(file))}: 有 ${parseFail} 行不是合法 JSON（不是末尾半行），拒绝写入。`);
    refused++;
    continue;
  }
  if (tailBroken && !trimTail) {
    console.log(`[abort] ${path.basename(path.dirname(file))}: 末尾有一条半行记录（DSH 被强杀时正写到一半）。`);
    console.log('        确认可以丢弃这一行后，加 --trim-tail 重跑。');
    refused++;
    continue;
  }

  // 末尾半行：DSH 被强杀时可能正在写的最后一条记录。只有 --trim-tail 才丢。
  let working = text;
  if (tailBroken) {
    const kept = lines.slice(0, lastNonEmpty);
    working = kept.join('\n');
    if (!working.endsWith('\n')) working += '\n';
  }

  const { text: fixed, fixed: count } = fixText(working);
  if (count === 0 && !tailBroken) continue;

  touched++;
  const sessionDir = path.basename(path.dirname(file));
  const firstBad = loneEscapeRanges(text)[0];
  if (firstBad) {
    const before = text.slice(0, firstBad.start);
    const lineStart = before.lastIndexOf('\n') + 1;
    let lineEnd = text.indexOf('\n', firstBad.start);
    if (lineEnd === -1) lineEnd = text.length;
    const lineText = text.slice(lineStart, lineEnd);
    const col = firstBad.start - lineStart;
    const badLineIdx = before.split('\n').length;
    log(`[${apply ? 'fix' : 'dry'}] ${sessionDir}: ${count} 处孤立代理，首处第 ${badLineIdx} 行`);
    log(`       上下文: ${JSON.stringify(lineText.slice(Math.max(0, col - 70), col + 20))}`);
  }
  if (tailBroken) log(`[${apply ? 'fix' : 'dry'}] ${sessionDir}: 末尾半行将被丢弃（--trim-tail）`);

  // 结构校验：修复后每行仍是合法 JSON；非空行数只允许因为丢弃末尾半行少 1
  const fixedLines = fixed.split('\n');
  const nonEmpty = (arr) => arr.filter((line) => line.trim()).length;
  const expected = nonEmpty(lines) - (tailBroken ? 1 : 0);
  if (nonEmpty(fixedLines) !== expected) {
    console.log(`[abort] ${sessionDir}: 非空行数 ${nonEmpty(lines)} -> ${nonEmpty(fixedLines)}（预期 ${expected}），拒绝写入`);
    refused++;
    continue;
  }
  let bad = 0;
  for (const line of fixedLines) {
    if (!line.trim()) continue;
    try {
      JSON.parse(line);
    } catch {
      bad++;
    }
  }
  if (bad > 0) {
    console.log(`[abort] ${sessionDir}: 修复后仍有 ${bad} 行不是合法 JSON，拒绝写入`);
    refused++;
    continue;
  }

  if (!apply) continue;

  const target = path.join(backupDir, sessionDir, path.basename(file));
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
  } catch (error) {
    console.log(`[fail] ${sessionDir}: 备份失败 ${error.code ?? error.message}，未写入`);
    writeFailed++;
    continue;
  }

  const outBuf = isZstd
    ? zlib.zstdCompressSync(Buffer.from(fixed, 'utf8'))
    : Buffer.from(fixed, 'utf8');

  // 写回要重试：DSH 强杀后句柄释放有延迟，杀软也可能短暂占用。
  // 每次先以 r+ 探测（只打开不写），拿到句柄才覆盖。
  let wrote = false;
  let lastError = null;
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt++) {
    try {
      const fd = fs.openSync(file, 'r+');
      fs.closeSync(fd);
      fs.writeFileSync(file, outBuf);
      wrote = true;
      break;
    } catch (error) {
      lastError = error;
      if (attempt < WRITE_ATTEMPTS) await sleep(WRITE_RETRY_MS);
    }
  }
  if (!wrote) {
    console.log(`[fail] ${sessionDir}: 写入失败 ${lastError?.code ?? lastError?.message}（重试 ${WRITE_ATTEMPTS} 次）`);
    console.log('       文件仍被占用或被拒写。多半是 DeepSeek Harness / 它的 electron 子进程没退干净，');
    console.log('       或者当前窗口没有写 %USERPROFILE%\\.dsh 的权限（不要从 DSH 里的终端跑）。');
    writeFailed++;
    continue;
  }
  log(`[done] ${sessionDir}\n       备份: ${target}\n       写入: ${outBuf.length} 字节`);
}

if (touched === 0) {
  if (refused > 0) log(`扫描完成：${refused} 个文件因结构问题被拒绝，没有写入。`);
  else log('扫描完成：没有发现孤立代理，无需修复。');
} else if (!apply) {
  log(`\n共 ${touched} 个文件需要修复。加 --apply 才会真正写入（自动备份）。`);
} else {
  log(
    `\n共修复 ${touched - writeFailed} 个文件${refused > 0 ? `，${refused} 个被拒绝` : ''}${writeFailed > 0 ? `，${writeFailed} 个写入失败` : ''}。`,
  );
}
process.exit(writeFailed > 0 ? 4 : refused > 0 ? 2 : 0);
