// 管理审计日志：追加写 JSONL + 哈希链（每条记录带上一条的 SHA-256）。
//
// 用途：所有模式/权限变更、提权申请、确认、TOTP 校验、审批决定、外部变更告警都写这里
// （state/admin/audit.jsonl）。哈希链只能**发现**事后篡改/删行，不能阻止本机管理员改文件 ——
// 它是取证辅助，不是安全边界。
//
// 写入失败绝不抛给调用方（审计不可用不应让降级/紧急关闭失败），但会记日志并计数。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const GENESIS = '0'.repeat(64);

function hashRecord(prevHash, body) {
  return crypto.createHash('sha256').update(prevHash).update('\n').update(JSON.stringify(body)).digest('hex');
}

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  } catch {
    return [];
  }
}

/**
 * @param {object} opts
 * @param {string} opts.file
 * @param {number} [opts.maxBytes]  超过后滚动为 audit.jsonl.1（只保留 keep 份）
 * @param {number} [opts.keep]
 * @param {(m:string)=>void} [opts.log]
 * @param {() => number} [opts.now]
 */
export function createAuditLog({ file, maxBytes = 5 * 1024 * 1024, keep = 5, log = () => {}, now = Date.now } = {}) {
  if (!file) throw new Error('createAuditLog: 缺少 file');
  let lastHash = null;
  let seq = 0;
  let failures = 0;

  function initFromDisk() {
    const lines = readLines(file);
    const last = lines.length ? (() => { try { return JSON.parse(lines[lines.length - 1]); } catch { return null; } })() : null;
    lastHash = last?.hash ?? GENESIS;
    seq = Number.isSafeInteger(last?.seq) ? last.seq : 0;
  }

  function rotateIfNeeded() {
    let size = 0;
    try { size = fs.statSync(file).size; } catch { return; }
    if (size < maxBytes) return;
    for (let i = keep - 1; i >= 1; i -= 1) {
      try { fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch {}
    }
    try { fs.renameSync(file, `${file}.1`); } catch {}
    try { fs.unlinkSync(`${file}.${keep + 1}`); } catch {}
    // 新文件的链从上一个文件的末尾哈希接续，跨文件仍可校验。
  }

  /** 追加一条审计记录。event 必填，其余字段原样记录（调用方负责不放秘密）。 */
  function append(event, fields = {}) {
    if (lastHash === null) initFromDisk();
    const body = { seq: seq + 1, time: new Date(now()).toISOString(), event: String(event), ...fields };
    const hash = hashRecord(lastHash, body);
    const rec = { ...body, prev: lastHash, hash };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      rotateIfNeeded();
      fs.appendFileSync(file, JSON.stringify(rec) + '\n', { encoding: 'utf8', mode: 0o600 });
      lastHash = hash;
      seq = body.seq;
    } catch (error) {
      failures += 1;
      log(`⚠️ 审计日志写入失败（${event}）：${error?.message ?? error}`);
    }
    return rec;
  }

  function tail(n = 50) {
    return readLines(file).slice(-n).map((l) => { try { return JSON.parse(l); } catch { return { corrupt: l.slice(0, 200) }; } });
  }

  /** 校验当前文件的哈希链；返回 { ok, count, brokenAt }。 */
  function verify() {
    const lines = readLines(file);
    let prev = null;
    for (let i = 0; i < lines.length; i += 1) {
      let rec;
      try { rec = JSON.parse(lines[i]); } catch { return { ok: false, count: lines.length, brokenAt: i + 1 }; }
      const { prev: p, hash, ...body } = rec;
      if (prev !== null && p !== prev) return { ok: false, count: lines.length, brokenAt: i + 1 };
      if (hashRecord(p, body) !== hash) return { ok: false, count: lines.length, brokenAt: i + 1 };
      prev = hash;
    }
    return { ok: true, count: lines.length, brokenAt: null };
  }

  return { append, tail, verify, get failures() { return failures; }, file };
}
