// 控制中心管理的子进程（桥接 / SnowLuma）：启动、停止、日志环形缓冲、崩溃自动重启、状态快照。
//
// 只由控制中心（src/launcher/control-center.mjs）在**用户点击按钮**时调用；
// 桥接、MCP 工具、AI 都没有任何途径调用这里（见 scripts/test-control-center.mjs 的 L6 断言）。

import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Windows 上按进程树强制结束（cmd.exe → node.exe 两层，只杀外层会留下孤儿进程）。 */
export function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve(false);
    if (process.platform === 'win32') {
      const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
      execFile(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (err) => resolve(!err));
    } else {
      try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
      resolve(true);
    }
  });
}

/**
 * @param {object} o
 * @param {string} o.name           'bridge' | 'snowluma'
 * @param {() => {command:string,args:string[],cwd:string,env?:object}|{error:string}} o.resolveLaunch  每次启动时重新计算（路径可能变）
 * @param {number} [o.maxLines]     内存里保留的日志行数
 * @param {string} [o.logDir]       日志落盘目录（按天滚动）
 * @param {(line:string)=>string} [o.redact]
 * @param {(exit:{code:number|null,signal:string|null})=>boolean} [o.shouldRestart]  返回 true 才自动重启
 * @param {() => Promise<boolean>} [o.gracefulStop]  优雅停止（返回 true 表示已请求退出）
 * @param {() => number} [o.now]
 */
export function createManagedProcess({ name, resolveLaunch, maxLines = 3000, logDir = null, redact = (s) => s, shouldRestart = () => false, gracefulStop = null, now = Date.now }) {
  let child = null;
  let seq = 0;
  const lines = []; // { seq, time, stream, text }
  let startedAt = 0;
  let lastExit = null; // { code, signal, at }
  let restarts = 0;
  let stopping = false;
  let autoRestart = true;
  let restartTimer = null;
  let partial = { stdout: '', stderr: '' };

  function logFile() {
    if (!logDir) return null;
    const d = new Date(now());
    const p = (n) => String(n).padStart(2, '0');
    return path.join(logDir, `${name}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.log`);
  }

  function push(stream, text) {
    const clean = redact(String(text).replace(/\u001b\[[0-9;]*[A-Za-z]/g, ''));
    seq += 1;
    lines.push({ seq, time: now(), stream, text: clean });
    if (lines.length > maxLines) lines.splice(0, lines.length - maxLines);
    const f = logFile();
    if (f) {
      try {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.appendFileSync(f, `[${new Date(now()).toISOString()}] ${stream === 'stderr' ? 'ERR ' : ''}${clean}\n`, { encoding: 'utf8', mode: 0o600 });
      } catch {}
    }
  }

  function feed(stream, chunk) {
    const text = partial[stream] + chunk.toString('utf8');
    const parts = text.split(/\r?\n/);
    partial[stream] = parts.pop() ?? '';
    for (const line of parts) push(stream, line);
  }

  function note(text) { push('system', text); }

  function start() {
    if (child) return { ok: false, error: `${name} 已在运行（PID ${child.pid}）` };
    const launch = resolveLaunch();
    if (launch?.error) { note(`无法启动：${launch.error}`); return { ok: false, error: launch.error }; }
    stopping = false;
    partial = { stdout: '', stderr: '' };
    let proc;
    try {
      proc = spawn(launch.command, launch.args, {
        cwd: launch.cwd,
        env: { ...process.env, ...(launch.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      note(`启动失败：${error?.message ?? error}`);
      return { ok: false, error: String(error?.message ?? error) };
    }
    child = proc;
    startedAt = now();
    note(`已启动（PID ${proc.pid}）：${launch.display ?? `${launch.command} ${launch.args.join(' ')}`}`);
    proc.stdout.on('data', (c) => feed('stdout', c));
    proc.stderr.on('data', (c) => feed('stderr', c));
    proc.on('error', (error) => note(`进程错误：${error?.message ?? error}`));
    proc.on('exit', (code, signal) => {
      for (const s of ['stdout', 'stderr']) if (partial[s]) { push(s, partial[s]); partial[s] = ''; }
      child = null;
      lastExit = { code, signal, at: now() };
      note(`已退出（退出码 ${code ?? '无'}${signal ? `，信号 ${signal}` : ''}）`);
      if (!stopping && autoRestart && shouldRestart({ code, signal })) {
        restarts += 1;
        const delay = Math.min(60_000, 5_000 * Math.min(6, restarts));
        note(`${Math.round(delay / 1000)} 秒后自动重启（第 ${restarts} 次）`);
        restartTimer = setTimeout(() => { restartTimer = null; start(); }, delay);
        restartTimer.unref?.();
      }
    });
    return { ok: true, pid: proc.pid };
  }

  async function stop({ timeoutMs = 8000 } = {}) {
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (!child) return { ok: true, already: true };
    stopping = true;
    const proc = child;
    const exited = new Promise((r) => proc.once('exit', () => r(true)));
    if (gracefulStop) {
      note('请求优雅退出…');
      let asked = false;
      try { asked = await gracefulStop(); } catch {}
      if (asked) {
        const done = await Promise.race([exited, new Promise((r) => setTimeout(() => r(false), timeoutMs))]);
        if (done) return { ok: true, graceful: true };
        note('优雅退出超时，改为强制结束');
      }
    }
    await killTree(proc.pid);
    const done = await Promise.race([exited, new Promise((r) => setTimeout(() => r(false), 5000))]);
    return { ok: done, graceful: false };
  }

  function snapshot() {
    return {
      name,
      running: !!child,
      pid: child?.pid ?? null,
      startedAt: child ? startedAt : null,
      uptimeMs: child ? now() - startedAt : 0,
      lastExit,
      restarts,
      autoRestart,
      restartPending: !!restartTimer,
    };
  }

  return {
    start,
    stop,
    note,
    snapshot,
    linesSince: (after = 0, limit = 1000) => lines.filter((l) => l.seq > after).slice(-limit),
    get lastSeq() { return seq; },
    setAutoRestart(v) { autoRestart = !!v; if (!v && restartTimer) { clearTimeout(restartTimer); restartTimer = null; } },
    resetRestarts() { restarts = 0; },
    get running() { return !!child; },
  };
}
