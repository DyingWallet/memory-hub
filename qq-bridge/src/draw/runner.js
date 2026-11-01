// 出图执行器：spawn tools/draw/qq_draw.mjs，读它写出的结果文件。
//
// 为什么不用 stdout 拿结果：受限环境下（以及部分 Windows 控制台）管道读子进程输出会 EPERM / 乱码，
// 所以子进程把结果写成 JSON 文件，这边只读文件。
//
// stderr 只用于诊断：先尝试 pipe 抓取；若环境不允许管道（EPERM），自动退回忽略，
// 不影响出图本身。
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULTS = {
  scriptPath: 'D:\\deepseek_workspace\\qq-bridge\\tools\\draw\\qq_draw.mjs',
  nodePath: process.execPath,
  timeoutMs: 240_000,
  // 结果文件目录：**不能用系统临时目录，也不能用 state/**。
  // 桥接进程常被限制为只能写工作区（mkdtemp 到 C:\Users\...\Temp 会 EPERM），
  // state/ 被 hardenDir 加固后同样写不了。落到出图目录下，由子进程自己创建。
  resultDir: 'D:\\deepseek_workspace\\outputs\\qq\\.results',
};

export function createRunner(cfg = {}) {
  const opt = { ...DEFAULTS };
  for (const [k, v] of Object.entries(cfg)) {
    if (v !== undefined && v !== null) opt[k] = v;
  }

  function newResultFile() {
    const name = `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.json`;
    return join(opt.resultDir, name);
  }

  function runOnce({ preset, extra, out }, { captureStderr } = { captureStderr: true }) {
    return new Promise((resolve) => {
      const resultFile = newResultFile();
      const args = [opt.scriptPath, '--preset', preset, '--result', resultFile];
      if (extra) args.push('--extra', extra);
      if (out) args.push('--out', out);

      let child;
      try {
        child = spawn(opt.nodePath, args, {
          windowsHide: true,
          stdio: captureStderr ? ['ignore', 'ignore', 'pipe'] : 'ignore',
        });
      } catch (e) {
        try {
          rmSync(resultFile, { force: true });
        } catch {
          /* ignore */
        }
        resolve({ ok: false, code: 'spawn_failed', error: e.message, __retryNoPipe: captureStderr });
        return;
      }

      let stderr = '';
      if (child.stderr) {
        child.stderr.on('data', (b) => {
          stderr += b.toString('utf8');
          if (stderr.length > 4000) stderr = stderr.slice(-4000);
        });
      }

      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        try {
          rmSync(resultFile, { force: true });
        } catch {
          /* ignore */
        }
        resolve(v);
      };

      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        done({ ok: false, code: 'timeout', error: `出图超过 ${opt.timeoutMs}ms` });
      }, opt.timeoutMs);

      child.on('error', (e) => {
        clearTimeout(timer);
        done({ ok: false, code: 'spawn_failed', error: e.message, __retryNoPipe: captureStderr });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (!existsSync(resultFile)) {
          done({
            ok: false,
            code: 'no_result',
            error: `子进程未写结果文件（exit ${code}）${stderr ? ` stderr=${stderr.trim().slice(-600)}` : ''}`,
          });
          return;
        }
        try {
          done(JSON.parse(readFileSync(resultFile, 'utf8')));
        } catch (e) {
          done({ ok: false, code: 'bad_json', error: `${e.message}${stderr ? ` stderr=${stderr.trim().slice(-400)}` : ''}` });
        }
      });
    });
  }

  /** 带 1 次重试；参数类错误不重试；管道失败自动退回无管道。 */
  async function run(job) {
    let first = await runOnce(job, { captureStderr: true });
    if (first.__retryNoPipe) {
      first = await runOnce(job, { captureStderr: false });
      if (first.ok) return first;
    }
    if (first.ok) return first;
    if (['bad_preset', 'bad_args', 'bad_model', 'refuse_xixi_nsfw'].includes(first.code)) return first;
    return runOnce(job, { captureStderr: false });
  }

  function health() {
    const exists = existsSync(opt.scriptPath);
    let presetsOk = false;
    try {
      const p = join(opt.scriptPath, '..', 'draw_presets.json');
      const j = JSON.parse(readFileSync(p, 'utf8'));
      presetsOk = Boolean(j?.presets);
    } catch {
      presetsOk = false;
    }
    return { scriptExists: exists, presetsOk, scriptPath: opt.scriptPath };
  }

  return { run, health };
}
