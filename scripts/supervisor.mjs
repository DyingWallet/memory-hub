#!/usr/bin/env node
/**
 * memory-hub 的唯一看护：每分钟跑一次，按顺序做三件事。
 *
 *   1. memd 活着吗？不在就用 scripts\start.ps1 -NoWait 拉起来（最常见的情况，什么都不做）；
 *   2. data\metrics.csv 超过 60 分钟没更新 -> 跑一次 scripts\monitor.mjs；
 *   3. 今天的备份目录还不存在、且已过 04:00 -> 跑一次 scripts\backup.mjs。
 *
 * 为什么合成一个：之前是四个计划任务（登录、看护、监控、备份），触发器各写一份，改一个忘三个，
 * 而且每次都要单独处理「黑框」。现在只有这一个任务，日志也只有一份。
 *
 * 顺序要求：先探活，后面的到期检查各自 try/catch——备份炸了不能影响看护。
 *
 * 环境变量（测试用）：
 *   MEMD_SUPERVISOR_MONITOR_MINUTES   监控间隔，默认 60
 *   MEMD_SUPERVISOR_BACKUP_AT         备份时刻 HH:mm，默认 04:00
 *   MEMD_SUPERVISOR_BACKUP_RETRY_MIN  备份失败后的重试间隔，默认 60
 *   MEMD_SUPERVISOR_DRY_RUN=1         只判断不执行（打印判断结果）
 *
 * 退出码：0 正常（无论有没有动作）；1 只有配置文件都读不出来时。
 */
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../packages/server/dist/config.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LOG_DIR = join(ROOT, 'logs');
const LOG_FILE = join(LOG_DIR, 'supervisor.log');
const TICK_FILE = join(LOG_DIR, 'task-last-tick.txt');
const LOG_MAX_BYTES = 200 * 1024;

const MONITOR_MINUTES = Number(process.env.MEMD_SUPERVISOR_MONITOR_MINUTES ?? 60);
const BACKUP_AT = process.env.MEMD_SUPERVISOR_BACKUP_AT ?? '04:00';
const BACKUP_RETRY_MINUTES = Number(process.env.MEMD_SUPERVISOR_BACKUP_RETRY_MIN ?? 60);
const DRY_RUN = process.env.MEMD_SUPERVISOR_DRY_RUN === '1';

function stamp() {
  // 本地时间，和 -Check / 日志里其它时间戳一致（ISO 的 UTC 看不出是不是刚跑过）。
  return new Date().toLocaleString('sv-SE').replace('T', ' ');
}

function log(message) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
    appendFileSync(LOG_FILE, `${stamp()} ${message}\n`, 'utf8');
  } catch {
    // 日志失败不能影响看护
  }
}

function heartbeat(summary) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(TICK_FILE, `${stamp()} | ${summary}\n`, 'utf8');
  } catch {
    // ignore
  }
}

async function memdHealthy(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

function runNodeScript(script, logName) {
  return new Promise((resolve) => {
    mkdirSync(LOG_DIR, { recursive: true });
    const fd = openSync(join(LOG_DIR, logName), 'a');
    // 'error' 和 'exit' 都可能触发，重复 closeSync 会抛 EBADF，把看护进程直接带崩。
    let closed = false;
    const closeFd = () => {
      if (closed) return;
      closed = true;
      try {
        closeSync(fd);
      } catch {
        // 已经关掉了，忽略
      }
    };
    let child;
    try {
      child = spawn(process.execPath, [join(ROOT, 'scripts', script)], {
        cwd: ROOT,
        windowsHide: true,
        stdio: ['ignore', fd, fd],
      });
    } catch (error) {
      closeFd();
      resolve({ ok: false, detail: `spawn failed: ${error?.message ?? error}` });
      return;
    }
    child.once('error', (error) => {
      closeFd();
      resolve({ ok: false, detail: `spawn error: ${error?.message ?? error}` });
    });
    child.once('exit', (code) => {
      closeFd();
      resolve({ ok: code === 0, detail: `exit=${code}` });
    });
  });
}

function startMemd() {
  return new Promise((resolve) => {
    mkdirSync(LOG_DIR, { recursive: true });
    const fd = openSync(join(LOG_DIR, 'supervisor-start.log'), 'a');
    let closed = false;
    const closeFd = () => {
      if (closed) return;
      closed = true;
      try {
        closeSync(fd);
      } catch {
        // 已经关掉了，忽略
      }
    };
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', join(ROOT, 'scripts', 'start.ps1'), '-NoWait'],
      { cwd: ROOT, windowsHide: true, stdio: ['ignore', fd, fd] },
    );
    child.once('error', (error) => {
      closeFd();
      resolve({ ok: false, detail: `spawn error: ${error?.message ?? error}` });
    });
    child.once('exit', (code) => {
      closeFd();
      resolve({ ok: code === 0, detail: `start.ps1 exit=${code}` });
    });
  });
}

function minutesSince(date) {
  return (Date.now() - date.getTime()) / 60_000;
}

function backupDue(backupDir) {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const todayDir = join(backupDir, today);
  if (existsSync(todayDir)) return { due: false, reason: `today's snapshot exists (${today})` };
  const [hour, minute] = BACKUP_AT.split(':').map((part) => Number(part));
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour || 0, minute || 0, 0, 0);
  if (now < target) return { due: false, reason: `before ${BACKUP_AT}` };

  // 失败保护：同一小时里只尝试一次，避免每分钟重试把磁盘打满。
  const stateFile = join(LOG_DIR, 'supervisor-state.json');
  let state = {};
  try {
    state = JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    state = {};
  }
  const lastAttempt = Number(state.lastBackupAttemptAt) || 0;
  if (lastAttempt && minutesSince(new Date(lastAttempt)) < BACKUP_RETRY_MINUTES) {
    return { due: false, reason: `last attempt ${Math.round(minutesSince(new Date(lastAttempt)))} min ago` };
  }
  return { due: true, reason: 'no snapshot for today', stateFile };
}

function monitorDue(metricsFile) {
  if (!existsSync(metricsFile)) return { due: true, reason: 'metrics.csv missing' };
  const age = minutesSince(statSync(metricsFile).mtime);
  if (age >= MONITOR_MINUTES) return { due: true, reason: `metrics.csv is ${Math.round(age)} min old` };
  return { due: false, reason: `metrics.csv is ${Math.round(age)} min old` };
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    log(`FATAL cannot load config: ${error?.stack ?? error}`);
    process.exit(1);
  }

  const port = config.port;
  const actions = [];

  // 1. memd
  if (await memdHealthy(port)) {
    actions.push('memd=up');
  } else {
    log(`memd down on ${port} -> starting`);
    const started = DRY_RUN ? { ok: true, detail: 'dry-run' } : await startMemd();
    log(`start.ps1 -> ${started.detail}`);
    let healthy = false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (await memdHealthy(port)) {
        healthy = true;
        break;
      }
    }
    actions.push(healthy ? 'memd=restarted' : 'memd=START-FAILED');
    log(healthy ? `memd healthy again on ${port}` : `memd did NOT come up within 10s`);
  }

  // 2. monitor
  const monitor = monitorDue(join(config.dataDir, 'metrics.csv'));
  if (monitor.due) {
    const result = DRY_RUN ? { ok: true, detail: 'dry-run' } : await runNodeScript('monitor.mjs', 'monitor.out.log');
    log(`monitor (${monitor.reason}) -> ${result.detail}`);
    actions.push(`monitor=${result.ok ? 'ran' : 'FAILED'}`);
  }

  // 3. backup
  const backup = backupDue(config.backup.dir);
  if (backup.due) {
    const result = DRY_RUN ? { ok: true, detail: 'dry-run' } : await runNodeScript('backup.mjs', 'backup.out.log');
    log(`backup (${backup.reason}) -> ${result.detail}`);
    actions.push(`backup=${result.ok ? 'ran' : 'FAILED'}`);
    if (backup.stateFile && !DRY_RUN) {
      try {
        writeFileSync(backup.stateFile, `${JSON.stringify({ lastBackupAttemptAt: Date.now() }, null, 2)}\n`, 'utf8');
      } catch {
        // ignore
      }
    }
  }

  heartbeat(actions.join(' '));
}

main().catch((error) => {
  log(`ERROR ${error?.stack ?? error}`);
  process.exit(1);
});
