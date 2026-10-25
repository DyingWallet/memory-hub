/**
 * 定时对账的调度器（跑在桥接进程里）。
 *
 * 为什么放在桥接里：对账要读 `state/social-v2.json`（桥接独占）和 memd 索引，
 * 而且**要抓的病是「桥接活着、但写不进 memd」**——桥接整个挂掉是另一类事故，
 * 症状明显（QQ 不回话），由看护任务负责。所以这里只做「到点 spawn 一次」，
 * 不把职责塞进 memd-watchdog。
 *
 * 分工：
 *   - 这个文件：到点判断、单实例锁、spawn、读报告、决定要不要通知 owner、记录状态；
 *   - `scripts/reconcile-memory.mjs`：真正的分类与修复（可独立手动跑）。
 *
 * 三条硬约束：
 *   1. 只 spawn 子进程、不 await 在主循环里——对账再慢也不能拖住 QQ 回复；
 *   2. 失败只记日志，不改桥接状态、不重试（等下一个窗口）；
 *   3. 通知有频控（同日同桶只发一次），且内容不含记忆正文。
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 每 15 分钟醒一次（只读一个 JSON，开销可忽略），
// 这样 17:30 这种「小时 + 分钟」窗口不会被整点检查错过。
const BOOT_DELAY_MS = 60 * 1000; // 启动后 60 秒补跑
const RUN_TIMEOUT_MS = 120 * 1000;
const LOCK_STALE_MS = 15 * 60 * 1000;

export const DEFAULT_RECONCILE_CONFIG = {
  enabled: false,
  everyHours: 24,
  runAtHour: 17,
  runAtMinute: 30,
  /** 允许在 runAtHour 之后再宽限几个小时（桥接晚启动时还能补上） */
  graceHours: 2,
  fix: false,
  fixMode: 'missing',
  retainDays: 30,
  alertOn: ['missing', 'superseded'],
};

/** 到点了吗：间隔够了 + 落在运行窗口里。 */
export function isDue({ nowMs, lastRunAt, config }) {
  const cfg = { ...DEFAULT_RECONCILE_CONFIG, ...(config ?? {}) };
  if (!cfg.enabled) return false;
  const intervalMs = Math.max(1, Number(cfg.everyHours) || 24) * 3_600_000;
  if (nowMs - (Number(lastRunAt) || 0) < intervalMs) return false;
  if (Number.isInteger(cfg.runAtHour)) {
    const now = new Date(nowMs);
    const hour = now.getHours();
    const grace = Math.max(0, Number(cfg.graceHours) || 0);
    if (hour < cfg.runAtHour || hour > cfg.runAtHour + grace) return false;
    if (hour === cfg.runAtHour && Number.isInteger(cfg.runAtMinute) && now.getMinutes() < cfg.runAtMinute) return false;
  }
  return true;
}

/** 通知文案：只有计数与路径，不含记忆正文。 */
export function buildAlertText({ counts, alertOn, at }) {
  const hit = alertOn.filter((bucket) => Number(counts?.[bucket]) > 0);
  if (hit.length === 0) return '';
  const parts = hit.map((bucket) => `${bucket} ${counts[bucket]}`);
  const when = new Date(at).toLocaleString('sv-SE').replace('T', ' ').slice(0, 16);
  return `【记忆对账】${when}\n${parts.join(' · ')}\n报告：qq-bridge/logs/reconcile/latest.json`;
}

/** 同一天、同一组桶只发一次；键是日期 + 命中的桶。 */
export function shouldNotify({ state, alertOn, counts, nowMs }) {
  const hit = alertOn.filter((bucket) => Number(counts?.[bucket]) > 0);
  if (hit.length === 0) return { notify: false, signature: '' };
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const signature = `${day}|${hit.join(',')}`;
  return { notify: state?.lastAlertSignature !== signature, signature };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } catch {
    // 状态写不进去不影响主流程
  }
}

/**
 * @param {object} options
 * @param {string} options.root  桥接根目录（脚本与 logs/ 都在它下面）
 * @param {object} options.cfg   桥接 config（读 memory.reconcile）
 * @param {(message: string) => void} [options.log]
 * @param {(text: string) => Promise<unknown>} [options.notifyOwner] 发 QQ 私聊
 * @param {() => number} [options.now]
 */
export function createReconcileScheduler({ root, cfg, log = console.log, notifyOwner, now = Date.now }) {
  const config = { ...DEFAULT_RECONCILE_CONFIG, ...(cfg?.memory?.reconcile ?? {}) };
  const outDir = join(root, 'logs', 'reconcile');
  const stateFile = join(outDir, 'scheduler-state.json');
  const lockFile = join(outDir, '.lock');
  const logFile = join(outDir, 'scheduler.log');
  const script = join(root, 'scripts', 'reconcile-memory.mjs');

  /** 桥接的 stdout 只在控制台里（start.bat 不重定向），所以调度器自己留一份日志。 */
  function logLine(message) {
    log(message);
    try {
      mkdirSync(outDir, { recursive: true });
      appendFileSync(logFile, `${new Date(now()).toISOString()} ${message}\n`, 'utf8');
    } catch {
      // 日志写不进去不影响调度
    }
  }

  function lockFresh() {
    if (!existsSync(lockFile)) return false;
    try {
      const raw = readJson(lockFile, null);
      const ts = Number(raw?.ts) || 0;
      return now() - ts < LOCK_STALE_MS;
    } catch {
      return false;
    }
  }

  function runOnce() {
    return new Promise((resolve) => {
      const args = [script];
      if (config.fix) args.push('--fix', config.fixMode || 'missing');
      if (config.retainDays > 0) args.push('--retain-days', String(config.retainDays));
      const child = spawn(process.execPath, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // ignore
        }
        resolve({ ok: false, detail: 'timeout' });
      }, RUN_TIMEOUT_MS);
      timer.unref?.();
      child.once('error', (error) => {
        clearTimeout(timer);
        resolve({ ok: false, detail: `spawn: ${error?.message ?? error}` });
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve({ ok: code === 0, detail: `exit=${code}` });
      });
    });
  }

  async function check({ force = false } = {}) {
    const state = readJson(stateFile, {});
    const stamp = now();
    if (!force && !isDue({ nowMs: stamp, lastRunAt: state.lastRunAt, config })) return { ran: false, reason: 'not-due' };
    if (lockFresh()) return { ran: false, reason: 'locked' };

    if (!existsSync(script)) {
      logLine(`[reconcile] 脚本不存在，跳过：${script}`);
      return { ran: false, reason: 'no-script' };
    }

    writeJson(lockFile, { pid: process.pid, ts: stamp });
    const startedAt = now();
    try {
      const result = await runOnce();
      const elapsed = ((now() - startedAt) / 1000).toFixed(1);
      const report = readJson(join(outDir, 'latest.json'), null);
      const counts = report?.counts ?? {};
      logLine(
        `[reconcile] ${result.ok ? 'ok' : 'failed'} ${elapsed}s ${result.detail} ` +
          `present=${counts.present ?? '?'} missing=${counts.missing ?? '?'} superseded=${counts.superseded ?? '?'} ` +
          `legacy=${counts.legacy ?? '?'} forgetQueue=${counts.forgetQueue ?? '?'}`,
      );

      const alertOn = Array.isArray(config.alertOn) ? config.alertOn : DEFAULT_RECONCILE_CONFIG.alertOn;
      const { notify, signature } = shouldNotify({ state, alertOn, counts, nowMs: stamp });
      let notified = false;
      if (notify) {
        const text = buildAlertText({ counts, alertOn, at: stamp });
        if (text && typeof notifyOwner === 'function') {
          try {
            await notifyOwner(text);
            notified = true;
            logLine('[reconcile] 已把异常发到 owner 私聊');
          } catch (error) {
            logLine(`[reconcile] 通知发送失败：${error?.message ?? error}`);
          }
        }
      }

      writeJson(stateFile, {
        lastRunAt: stamp,
        lastResult: result.ok ? 'ok' : 'failed',
        lastCounts: counts,
        ...(notified ? { lastAlertSignature: signature, lastAlertAt: stamp } : {}),
      });
      return { ran: true, ok: result.ok, counts, notified };
    } finally {
      try {
        unlinkSync(lockFile);
      } catch {
        // 锁已经不在了
      }
    }
  }

  function pruneHistory(retainDays = config.retainDays) {
    if (!(retainDays > 0)) return 0;
    const dir = join(outDir, 'history');
    if (!existsSync(dir)) return 0;
    const cutoff = now() - retainDays * 86_400_000;
    let removed = 0;
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      try {
        const stat = readFileSync(file, 'utf8');
        void stat;
        const ts = Date.parse(name.replace('.json', ''));
        if (Number.isFinite(ts) && ts < cutoff) {
          rmSync(file);
          removed += 1;
        }
      } catch {
        // 单个文件坏了就跳过
      }
    }
    return removed;
  }

  let timers = [];
  function start() {
    if (!config.enabled) return false;
    const boot = setTimeout(() => {
      void check().catch((error) => logLine(`[reconcile] 启动补跑失败：${error?.message ?? error}`));
    }, BOOT_DELAY_MS);
    boot.unref?.();
    const hourly = setInterval(() => {
      void check().catch((error) => logLine(`[reconcile] 定时检查失败：${error?.message ?? error}`));
    }, CHECK_INTERVAL_MS);
    hourly.unref?.();
    timers = [boot, hourly];
    logLine(
      `[reconcile] 已启用：每 ${config.everyHours}h，窗口 ${String(config.runAtHour).padStart(2, '0')}:${String(config.runAtMinute).padStart(2, '0')}` +
        `(+${config.graceHours}h)，fix=${config.fix ? config.fixMode : 'off'}`,
    );
    return true;
  }

  function stop() {
    for (const timer of timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    timers = [];
  }

  return { config, start, stop, check, pruneHistory, paths: { stateFile, lockFile, outDir } };
}
