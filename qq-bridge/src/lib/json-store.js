// 带版本号的 JSON 状态文件：原子写入 + 损坏回退 + 滚动备份 + 结构迁移。
//
// 为什么不用 SQLite：桥接现有的全部运行态（会话映射、二代状态、黑话库、令牌账本）都是
// state/ 下的 JSON 文件，备份/迁移/ACL 收紧/隐私扫描都按「文件」设计；引入原生模块
// （better-sqlite3）会让 Windows 部署多一个编译环节，node:sqlite 在 Node 22.13 仍是实验特性。
// 本项目的数据量是「几个群 × 几百人」级别，单文件 JSON 足够，且人能直接读、能手工修。
//
// 写入策略：先写同目录唯一临时文件并 fsync，再 rename 覆盖（Windows 上目标被占用时退避重试）。
// 进程在任何一步中断，磁盘上要么是旧文件、要么是新文件，不会出现半截 JSON。
// 读到损坏文件时不覆盖它：先改名为 `.corrupt-<时间>` 留证，再尝试最近一份备份。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

export function renameWithRetry(from, to, attempts = 5) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) throw error;
      sleepSync(40 * (i + 1));
    }
  }
  throw lastError;
}

/** 原子写文本：临时文件 → fsync → rename。失败时清理临时文件后抛出。 */
export function atomicWriteFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w', 0o600);
    fs.writeFileSync(fd, text, 'utf8');
    try { fs.fsyncSync(fd); } catch {}
    fs.closeSync(fd);
    fd = null;
    renameWithRetry(tmp, file);
  } catch (error) {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

export function atomicWriteJsonFile(file, obj) {
  atomicWriteFile(file, JSON.stringify(obj, null, 2) + '\n');
}

/** 读 JSON；容忍 UTF-8 BOM。返回 { ok, value, error, missing }。 */
export function readJsonFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { ok: false, missing: error?.code === 'ENOENT', error };
  }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, missing: false, error };
  }
}

function stamp(now = Date.now()) {
  return new Date(now).toISOString().replace(/[:.]/g, '-');
}

/**
 * 创建一个版本化 JSON 存储。
 *
 * @param {object} opts
 * @param {string} opts.file          文件绝对路径
 * @param {number} opts.version       当前结构版本（整数，从 1 开始）
 * @param {() => object} opts.empty   生成空数据（不含 version 字段）
 * @param {Record<number,(data:object)=>object>} [opts.migrations]  migrations[n] 把 n 版升到 n+1
 * @param {number} [opts.keepBackups] 保留的滚动备份数（默认 7）
 * @param {number} [opts.backupIntervalMs] 两次自动备份的最小间隔（默认 6 小时）
 * @param {(msg:string)=>void} [opts.log]
 */
export function createJsonStore(opts) {
  const {
    file, version, empty, migrations = {}, keepBackups = 7,
    backupIntervalMs = 6 * 60 * 60 * 1000, log = () => {},
  } = opts;
  if (!file || !Number.isInteger(version) || version < 1 || typeof empty !== 'function') {
    throw new Error('createJsonStore: file / version / empty 参数无效');
  }
  const backupDir = path.join(path.dirname(file), 'backups');
  const baseName = path.basename(file);
  let data = null;
  let lastBackupAt = 0;
  let loadReport = { source: 'none', migratedFrom: null, recoveredFrom: null };

  function listBackups() {
    try {
      return fs.readdirSync(backupDir)
        .filter((n) => n.startsWith(`${baseName}.`) && n.endsWith('.bak'))
        .sort()
        .map((n) => path.join(backupDir, n));
    } catch {
      return [];
    }
  }

  function migrate(raw) {
    let cur = raw;
    let v = Number.isInteger(cur?.version) ? cur.version : 0;
    const from = v;
    if (v > version) {
      // 新版本写的文件被旧版本读到：不降级、不覆盖，直接拒绝（防止回滚后把新字段写丢）。
      const err = new Error(`${baseName} 的结构版本 ${v} 高于当前程序支持的 ${version}，请升级程序或从备份恢复`);
      err.code = 'STORE_VERSION_TOO_NEW';
      throw err;
    }
    while (v < version) {
      const step = migrations[v];
      if (typeof step !== 'function') {
        // 没有显式迁移步骤：0 版（无 version 字段）视为空白起点，其余版本缺迁移属于程序错误。
        if (v === 0) { cur = { ...empty(), ...(cur && typeof cur === 'object' ? cur : {}) }; }
        else throw new Error(`${baseName} 缺少从版本 ${v} 升级的迁移步骤`);
      } else {
        cur = step(cur);
      }
      v += 1;
      cur = { ...cur, version: v };
    }
    return { value: cur, migratedFrom: from !== version ? from : null };
  }

  function load() {
    const primary = readJsonFile(file);
    if (primary.ok && primary.value && typeof primary.value === 'object' && !Array.isArray(primary.value)) {
      const { value, migratedFrom } = migrate(primary.value);
      data = value;
      loadReport = { source: 'file', migratedFrom, recoveredFrom: null };
      if (migratedFrom !== null) {
        // 迁移前留一份原样备份，迁移出错时可手工回退。
        backup(`pre-migrate-v${migratedFrom}`, primary.value);
        save();
        log(`${baseName} 已从结构版本 ${migratedFrom} 迁移到 ${version}`);
      }
      return data;
    }
    if (!primary.missing) {
      // 文件存在但读不出来：改名留证，绝不覆盖。
      const evidence = `${file}.corrupt-${stamp()}`;
      try { renameWithRetry(file, evidence); } catch {}
      log(`⚠️ ${baseName} 损坏（${primary.error?.message ?? primary.error}），已改名为 ${path.basename(evidence)}，尝试从备份恢复`);
      for (const bak of listBackups().reverse()) {
        const r = readJsonFile(bak);
        if (r.ok && r.value && typeof r.value === 'object') {
          const { value } = migrate(r.value);
          data = value;
          loadReport = { source: 'backup', migratedFrom: null, recoveredFrom: path.basename(bak) };
          save();
          log(`${baseName} 已从备份 ${path.basename(bak)} 恢复`);
          return data;
        }
      }
      log(`⚠️ ${baseName} 没有可用备份，以空数据启动（损坏文件已保留）`);
    }
    data = { ...empty(), version };
    loadReport = { source: primary.missing ? 'new' : 'empty-after-corrupt', migratedFrom: null, recoveredFrom: null };
    return data;
  }

  function save() {
    if (!data) throw new Error(`${baseName} 尚未 load()`);
    data.version = version;
    data.savedAt = Date.now();
    atomicWriteJsonFile(file, data);
    if (Date.now() - lastBackupAt >= backupIntervalMs) backup('auto');
  }

  function backup(label = 'manual', value = data) {
    if (!value) return null;
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      const target = path.join(backupDir, `${baseName}.${stamp()}.${String(label).replace(/[^a-z0-9-]/gi, '')}.bak`);
      atomicWriteJsonFile(target, value);
      lastBackupAt = Date.now();
      const all = listBackups();
      for (const old of all.slice(0, Math.max(0, all.length - keepBackups))) {
        try { fs.unlinkSync(old); } catch {}
      }
      return target;
    } catch (error) {
      log(`⚠️ ${baseName} 备份失败：${error?.message ?? error}`);
      return null;
    }
  }

  /** 从指定备份文件恢复（会先备份当前数据）。 */
  function restore(backupFile) {
    const r = readJsonFile(backupFile);
    if (!r.ok || !r.value || typeof r.value !== 'object') throw new Error(`备份不可读：${backupFile}`);
    backup('pre-restore');
    data = migrate(r.value).value;
    save();
    return data;
  }

  return {
    file,
    load,
    save,
    backup,
    restore,
    listBackups,
    get data() { if (!data) load(); return data; },
    get loadReport() { return loadReport; },
  };
}
