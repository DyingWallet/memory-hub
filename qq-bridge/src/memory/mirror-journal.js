/**
 * 镜像写入的痕迹：失败流水 + 遗忘队列。
 *
 * 为什么需要：`mirrorWrite` 是 fire-and-forget，失败只打一条 `log.warn`，
 * 桥接一重启就再也看不见；而 `mirrorForget` 失败是**不可恢复的隐私问题**
 * ——用户说了「忘掉」，memd 里还留着，没有任何东西会再提这件事。
 *
 * 两个文件分工：
 *   - `logs/mirror-failures.jsonl`：只追加的流水，给人看的（发生了什么、什么时候）。
 *   - `state/forget-queue.jsonl`：待办，会被消掉的（谁还没忘干净）。删干净就变成空文件。
 *
 * 设计约束（这几条别改）：
 *   1. 永不抛异常。镜像本来就是 fail-soft 路径，日志写失败不能反过来弄挂回复。
 *   2. 队列写盘用「临时文件 + rename」，避免桥接被杀时留下半截 JSON。
 *   3. 重试有上限（默认 5 次），超过就留在队列里等人工——**不静默丢弃**，
 *      静默丢弃等于把「没忘掉」伪装成「忘掉了」。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_MAX_ATTEMPTS = 5;

export function createMirrorJournal({ root, log = console, maxAttempts = DEFAULT_MAX_ATTEMPTS, now = Date.now }) {
  const logsDir = join(root, 'logs');
  const stateDir = join(root, 'state');
  const failureFile = join(logsDir, 'mirror-failures.jsonl');
  const queueFile = join(stateDir, 'forget-queue.jsonl');

  function ensureDir(dir) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // 目录建不出来就放弃写文件，不影响主流程
    }
  }

  function textOf(error) {
    if (!error) return 'unknown';
    const message = typeof error === 'string' ? error : error.message ?? error;
    return String(message).slice(0, 500);
  }

  function readQueue() {
    if (!existsSync(queueFile)) return [];
    let raw = '';
    try {
      raw = readFileSync(queueFile, 'utf8');
    } catch {
      return [];
    }
    const items = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed.scene === 'string' && typeof parsed.text === 'string') items.push(parsed);
      } catch {
        // 坏行跳过：宁可漏一条待办，也不能让整个队列卡死
      }
    }
    return items;
  }

  function writeQueue(items) {
    ensureDir(stateDir);
    const body = items.map((item) => `${JSON.stringify(item)}\n`).join('');
    const tmp = `${queueFile}.tmp`;
    try {
      writeFileSync(tmp, body, 'utf8');
      renameSync(tmp, queueFile);
    } catch (error) {
      log.warn?.(`[memory] forget queue write failed: ${textOf(error)}`);
    }
  }

  /** 追加一条失败流水。op = write | forget | update */
  function recordFailure(entry) {
    ensureDir(logsDir);
    const line = {
      ts: new Date(now()).toISOString(),
      op: entry.op ?? 'write',
      scene: entry.scene ?? '',
      category: entry.category ?? '',
      ...(entry.target ? { target: String(entry.target) } : {}),
      ...(entry.missing ? { missing: true } : {}),
      error: textOf(entry.error),
    };
    try {
      appendFileSync(failureFile, `${JSON.stringify(line)}\n`, 'utf8');
    } catch (error) {
      log.warn?.(`[memory] failure log write failed: ${textOf(error)}`);
    }
    return line;
  }

  /**
   * 把「该忘而没忘掉」的条目放进队列。同一条（scene+category+target+text）
   * 已经在队列里时不重复入队，只更新错误信息与时间。
   *
   * `entry`（id / rev / target）必须一起落盘：重试时要靠它重算出**同一把身份键**。
   * 2026-10-26 复测踩过：只存文本，重试就算成旧的内容指纹键，forget 命中不到
   * 却返回成功——队列看着清空了，副本还留在 memd 里。
   */
  function enqueueForget(entry, dedupeKey) {
    const items = readQueue();
    const stamp = now();
    const identity = entry.entry && typeof entry.entry === 'object' ? entry.entry : null;
    const existing = items.find((item) => item.dedupeKey === dedupeKey);
    if (existing) {
      existing.lastError = textOf(entry.error);
      existing.lastTriedAt = stamp;
      if (identity && !existing.entry) existing.entry = identity;
    } else {
      items.push({
        ts: new Date(stamp).toISOString(),
        dedupeKey,
        scene: entry.scene,
        category: entry.category,
        ...(identity ? { entry: identity } : {}),
        ...(entry.target ? { target: String(entry.target) } : {}),
        text: entry.text,
        attempts: 0,
        lastError: textOf(entry.error),
        lastTriedAt: stamp,
      });
    }
    writeQueue(items);
    return items.length;
  }

  /**
   * 重试队列。`attempt(entry)` 返回 true 表示这一次忘掉了。
   * 返回 { drained, left, gaveUp }：gaveUp 是超过重试上限、留给人工的条数。
   */
  async function drain(attempt) {
    const items = readQueue();
    if (items.length === 0) return { drained: 0, left: 0, gaveUp: 0 };
    let drained = 0;
    let gaveUp = 0;
    const left = [];
    for (const item of items) {
      const attempts = Number(item.attempts) || 0;
      if (attempts >= maxAttempts) {
        left.push(item);
        gaveUp += 1;
        continue;
      }
      let ok = false;
      let error = '';
      try {
        ok = (await attempt(item)) === true;
      } catch (caught) {
        error = textOf(caught);
      }
      if (ok) {
        drained += 1;
        continue;
      }
      left.push({
        ...item,
        attempts: attempts + 1,
        lastError: error || item.lastError || 'unknown',
        lastTriedAt: now(),
      });
    }
    writeQueue(left);
    return { drained, left: left.length, gaveUp };
  }

  return { recordFailure, enqueueForget, drain, readQueue, files: { failureFile, queueFile } };
}
