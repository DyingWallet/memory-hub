#!/usr/bin/env node
/**
 * memory-hub 的唯一看护：每分钟跑一次，按顺序做五件事。
 *
 *   1. memd 活着吗？不在就用 scripts\start.ps1 -NoWait 拉起来（最常见的情况，什么都不做）；
 *   2. config.bridge.enabled 为真时，盯着 QQ 桥接的控制台探活，掉了就起（可选，默认关）；
 *   3. data\metrics.csv 超过 60 分钟没更新 -> 跑一次 scripts\monitor.mjs；
 *   4. 今天的备份目录还不存在、且已过 04:00 -> 跑一次 scripts\backup.mjs；
 *   5. config.sleep.enabled 为真、且过了 config.sleep.at 而今天还没跑成 -> 跑一次夜间整理
 *      （scripts\sleep-consolidate.mjs，可选，默认关；它自己建 DSH 整理会话）。
 *
 * 为什么合成一个：之前是四个计划任务（登录、看护、监控、备份），触发器各写一份，改一个忘三个，
 * 而且每次都要单独处理「黑框」。现在只有这一个任务，日志也只有一份。
 *
 * 顺序要求：先探活，后面的到期检查各自 try/catch——备份炸了不能影响看护。
 * 桥接排在 memd 之后、定时任务之前：它是「服务活着吗」这一类，和监控/备份不是一类。
 * 但桥接必须**可选**（config.bridge.enabled），没装桥接的机器不该被它拖累。
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

/**
 * 桥接控制台的探活：401 也算活着（不带 token 时控制台就这么回，说明进程在听）。
 * 其它 4xx/5xx 或者根本连不上，都按「没起」处理。
 */
async function bridgeHealthy(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return response.ok || response.status === 401;
  } catch {
    return false;
  }
}

const STATE_FILE = join(LOG_DIR, 'supervisor-state.json');

function readState() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** 合并写入：备份和桥接共用这个状态文件，谁都不能把别人的键覆盖掉。 */
function writeState(patch) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(STATE_FILE, `${JSON.stringify({ ...readState(), ...patch }, null, 2)}\n`, 'utf8');
  } catch {
    // ignore
  }
}

function runNodeScript(script, logName, extraArgs = []) {
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
      child = spawn(process.execPath, [join(ROOT, 'scripts', script), ...extraArgs], {
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

/**
 * 用隐藏的 powershell 跑一个启动脚本，等它自己退出（启动脚本只负责把服务甩出去，很快返回）。
 * memd 和桥接共用：两边的日志都追加到 supervisor-start.log，出问题只看一个文件。
 */
function spawnPowerShell(scriptPath, extraArgs, cwd) {
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
    let child;
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath, ...extraArgs],
        { cwd, windowsHide: true, stdio: ['ignore', fd, fd] },
      );
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
  return spawnPowerShell(join(ROOT, 'scripts', 'start.ps1'), ['-NoWait'], ROOT);
}

function startBridge(dir) {
  return spawnPowerShell(join(dir, 'start-bridge.ps1'), [], dir);
}

function minutesSince(date) {
  return (Date.now() - date.getTime()) / 60_000;
}

function localDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * 夜间整理到点了吗？
 *
 * 三条都满足才跑：开了开关、过了今天的时刻、今天还没成功跑过。
 * 另外两种「先别跑」：上一轮还在跑（15 分钟的会话 + 余量，20 分钟内不重起）、
 * 上一次失败且还在退避窗口里。
 */
const SLEEP_PERIODS = ['daily', 'weekly', 'monthly', 'yearly'];

/**
 * 某个周期到点了吗：开关开着 + 过了今天的 at + 本周期还没成功跑过。
 * 周/月/年额外有日期门槛（周一 / 1 号 / 1 月 1 日），否则每天都会想跑。
 */
function sleepDueFor(period, sleepCfg) {
  const now = new Date();
  const today = localDate(now);
  const state = readState();
  if (state[`lastSleepSuccessDate_${period}`] === today) return { due: false, reason: 'already ran today' };

  const startedAt = Number(state[`sleepStartedAt_${period}`]) || 0;
  if (startedAt && minutesSince(new Date(startedAt)) < 20) {
    return { due: false, reason: `run in progress (${Math.round(minutesSince(new Date(startedAt)))}min)` };
  }

  const [hour, minute] = String(sleepCfg.at).split(':').map((part) => Number(part));
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour || 0, minute || 0, 0, 0);
  if (now < target) return { due: false, reason: `before ${sleepCfg.at}` };

  if (period === 'weekly' && now.getDay() !== 1) return { due: false, reason: 'not Monday' };
  if (period === 'monthly' && now.getDate() !== 1) return { due: false, reason: 'not the 1st' };
  if (period === 'yearly' && !(now.getMonth() === 0 && now.getDate() === 1)) {
    return { due: false, reason: 'not Jan 1' };
  }

  const failedAt = Number(state[`sleepFailedAt_${period}`]) || 0;
  if (failedAt && minutesSince(new Date(failedAt)) < sleepCfg.retryMinutes) {
    return { due: false, reason: `retry in ${Math.ceil(sleepCfg.retryMinutes - minutesSince(new Date(failedAt)))}min` };
  }
  return { due: true, reason: 'no successful run today' };
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
  const lastAttempt = Number(readState().lastBackupAttemptAt) || 0;
  if (lastAttempt && minutesSince(new Date(lastAttempt)) < BACKUP_RETRY_MINUTES) {
    return { due: false, reason: `last attempt ${Math.round(minutesSince(new Date(lastAttempt)))} min ago` };
  }
  return { due: true, reason: 'no snapshot for today' };
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

  // 2. bridge（可选，默认关）
  const bridge = config.bridge;
  if (bridge.enabled) {
    if (await bridgeHealthy(bridge.probeUrl)) {
      actions.push('bridge=up');
    } else {
      const startScript = join(bridge.dir, 'start-bridge.ps1');
      const retryAt = Number(readState().bridgeRetryAt) || 0;
      if (!existsSync(startScript)) {
        log(`bridge enabled but ${startScript} is missing -> skipped`);
        actions.push('bridge=NO-SCRIPT');
      } else if (retryAt > Date.now()) {
        actions.push(`bridge=down(retry in ${Math.ceil((retryAt - Date.now()) / 60_000)}min)`);
      } else {
        log(`bridge down on ${bridge.probeUrl} -> starting`);
        const started = DRY_RUN ? { ok: true, detail: 'dry-run' } : await startBridge(bridge.dir);
        log(`start-bridge.ps1 -> ${started.detail}`);
        let healthy = false;
        const deadline = Date.now() + bridge.startTimeoutSeconds * 1000;
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          if (await bridgeHealthy(bridge.probeUrl)) {
            healthy = true;
            break;
          }
        }
        if (healthy) {
          actions.push('bridge=restarted');
          log(`bridge healthy again on ${bridge.probeUrl}`);
          if (retryAt) writeState({ bridgeRetryAt: 0 });
        } else {
          // 起不来（比如 DSH 没开、start-bridge.ps1 找不到端口）就退避，别每分钟刷日志。
          actions.push('bridge=START-FAILED');
          log(`bridge did NOT come up within ${bridge.startTimeoutSeconds}s -> retry in ${bridge.retryMinutes}min`);
          if (!DRY_RUN) writeState({ bridgeRetryAt: Date.now() + bridge.retryMinutes * 60_000 });
        }
      }
    }
  }

  // 3. monitor
  const monitor = monitorDue(join(config.dataDir, 'metrics.csv'));
  if (monitor.due) {
    const result = DRY_RUN ? { ok: true, detail: 'dry-run' } : await runNodeScript('monitor.mjs', 'monitor.out.log');
    log(`monitor (${monitor.reason}) -> ${result.detail}`);
    actions.push(`monitor=${result.ok ? 'ran' : 'FAILED'}`);
  }

  // 4. backup
  const backup = backupDue(config.backup.dir);
  if (backup.due) {
    const result = DRY_RUN ? { ok: true, detail: 'dry-run' } : await runNodeScript('backup.mjs', 'backup.out.log');
    log(`backup (${backup.reason}) -> ${result.detail}`);
    actions.push(`backup=${result.ok ? 'ran' : 'FAILED'}`);
    if (!DRY_RUN) writeState({ lastBackupAttemptAt: Date.now() });
  }

  // 5. 整理（可选，默认关）。四个周期共用一套脚本，各自的 state 键分开：
  //    daily 每天、weekly 周一、monthly 1 号、yearly 1 月 1 日，都在 config.sleep.at 之后。
  //    整理者要用 MCP 记忆工具写回，所以 memd 不在就整体跳过，等下一分钟。
  if (config.sleep.enabled) {
    const memdUp = await memdHealthy(port);
    for (const kind of SLEEP_PERIODS) {
      const due = sleepDueFor(kind, config.sleep);
      if (!due.due) {
        actions.push(`sleep-${kind}=skip(${due.reason})`);
        continue;
      }
      if (!memdUp) {
        actions.push(`sleep-${kind}=skip(memd down)`);
        continue;
      }
      log(`sleep ${kind} (${due.reason}) -> starting`);
      if (!DRY_RUN) writeState({ [`sleepStartedAt_${kind}`]: Date.now() });
      const result = DRY_RUN
        ? { ok: true, detail: 'dry-run' }
        : await runNodeScript('sleep-consolidate.mjs', `sleep-${kind}.out.log`, [`--period=${kind}`]);
      log(`sleep-consolidate --period=${kind} -> ${result.detail}`);
      if (!DRY_RUN) {
        if (result.ok) {
          // 退出码 0 也可能是「今天没东西可整理」，同样算当天完成。
          writeState({
            [`lastSleepSuccessDate_${kind}`]: localDate(new Date()),
            [`sleepStartedAt_${kind}`]: 0,
            [`sleepFailedAt_${kind}`]: 0,
          });
        } else {
          writeState({ [`sleepStartedAt_${kind}`]: 0, [`sleepFailedAt_${kind}`]: Date.now() });
        }
      }
      actions.push(`sleep-${kind}=${result.ok ? 'ran' : 'FAILED'}`);
    }
  }

  heartbeat(actions.join(' '));
}

main().catch((error) => {
  log(`ERROR ${error?.stack ?? error}`);
  process.exit(1);
});
