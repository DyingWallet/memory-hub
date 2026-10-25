#!/usr/bin/env node
/**
 * 镜像链路的线上演练：真的停一次 memd，验证「失败留痕 / 遗忘重试 / 补回来」。
 *
 * ⚠ 会中断记忆服务几十秒，并且需要非沙箱身份（停 memd、重启桥接）。
 *   必须显式确认：
 *     node scripts\mirror-drill.mjs --confirm
 *
 * 流程与断言：
 *   1. memd 在线时追加 A        → A 落进 facts
 *   2. 暂停看护（尽力）+ 停 memd → 8 秒窗口内 memd 保持不可达
 *   3. 追加 B（写失败）          → 只进 logs/mirror-failures.jsonl，不进遗忘队列
 *   4. 删除 A（忘失败）          → 再进一条失败流水 + 进 state/forget-queue.jsonl
 *   5. 起 memd + 重启桥接        → 桥接启动 30 秒后的重试会清空队列，A 变成 tombstone
 *   6. 清理：把 B 从 social-v2 删掉，恢复看护任务
 *
 * 退出码：0 全通过；1 有断言失败或出错。
 */
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const BRIDGE = process.env.BRIDGE_DIR || 'D:/deepseek_workspace/qq-bridge';
const HUB = process.env.HUB_DIR || 'D:/deepseek_workspace/memory-hub';
const FACTS = process.env.FACTS_FILE || 'D:/deepseek_workspace/memories/facts/2026-10.jsonl';
const INDEX = process.env.MEMD_INDEX || `${HUB}/data/index.db`;
const FAILURES = `${BRIDGE}/logs/mirror-failures.jsonl`;
const QUEUE = `${BRIDGE}/state/forget-queue.jsonl`;
const PS = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';

if (!process.argv.includes('--confirm')) {
  console.log('这会停掉 memd（记忆服务）几十秒。确认要跑就加 --confirm：');
  console.log('  node scripts\\mirror-drill.mjs --confirm');
  process.exit(1);
}

const tag = new Date().toISOString().slice(11, 19).replace(/:/g, '');
const textA = `演练-A-镜像成功-${tag}`;
const textB = `演练-B-写失败-${tag}`;
const token = readFileSync(`${BRIDGE}/state/console-token`, 'utf8').trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);

async function post(path, body) {
  const response = await fetch(`http://127.0.0.1:3100${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} -> ${response.status} ${JSON.stringify(json)}`);
  return json;
}
const append = (key, category, content) => post('/api/socialV2/memory-append', { key, category, content });
const remove = (key, category, content) => post('/api/socialV2/memory-remove', { key, category, content });

const factsMatching = (text) => lines(FACTS).filter((line) => line.includes(text));
async function healthy() {
  try {
    const response = await fetch('http://127.0.0.1:8787/v1/health', { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}
function run(command, args) {
  try {
    execFileSync(command, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

let watchdogPaused = false;
try {
  // 1. memd 在线：正常镜像
  await append('private:709038511', 'activeTopic', textA);
  await sleep(1800);
  const writeLines = factsMatching(textA);
  check('A 镜像成功（memd 在线）', writeLines.length === 1, `facts 命中 ${writeLines.length}`);
  const factId = writeLines.length ? JSON.parse(writeLines[0]).id : '';

  // 2. 尽力暂停看护，然后停 memd
  watchdogPaused = run('schtasks.exe', ['/change', '/tn', 'memd-watchdog', '/disable']);
  console.log(`      ${watchdogPaused ? '看护任务已暂停' : '看护任务没能暂停（继续，靠窗口内探活兜底）'}`);
  run(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `${HUB}/scripts/stop.ps1`]);
  await sleep(8000);
  check('memd 已停且窗口内没有自己回来', !(await healthy()));

  const failuresBefore = lines(FAILURES).length;
  const queueBefore = lines(QUEUE).length;

  // 3. 写失败：只留流水，不进队列
  await append('private:709038511', 'activeTopic', textB);
  await sleep(1800);
  const failuresAfterWrite = lines(FAILURES).length;
  check('B 没有进 memd', factsMatching(textB).length === 0);
  check('写失败留了痕迹', failuresAfterWrite === failuresBefore + 1, `${failuresBefore} → ${failuresAfterWrite}`);
  check('写失败不进遗忘队列（重写会重复）', lines(QUEUE).length === queueBefore, `队列 ${lines(QUEUE).length}`);

  // 4. 删除失败：进队列
  await remove('private:709038511', 'activeTopic', textA);
  await sleep(1800);
  const queueAfter = lines(QUEUE);
  check('删除失败留了痕迹', lines(FAILURES).length === failuresAfterWrite + 1, `失败流水 ${lines(FAILURES).length}`);
  check('删除失败进了遗忘队列', queueAfter.length === queueBefore + 1, `队列 ${queueBefore} → ${queueAfter.length}`);

  // 5. 起 memd + 重启桥接（触发启动 30 秒后的重试）
  run(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `${HUB}/scripts/start.ps1`, '-NoWait']);
  let up = false;
  for (let i = 0; i < 30; i += 1) {
    await sleep(1000);
    if (await healthy()) {
      up = true;
      break;
    }
  }
  check('memd 已恢复', up);

  run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `${HUB}/scripts/sync-qq-bridge.ps1`, '-Apply', '-Restart']);
  console.log('      等桥接启动 30 秒后的遗忘重试…');
  await sleep(42_000);

  check('遗忘队列已被重试清空', lines(QUEUE).length === 0, `剩余 ${lines(QUEUE).length} 条`);
  const tombstoned = factId ? lines(FACTS).some((line) => line.includes(factId) && line.includes('"deleted":true')) : false;
  check('A 在 memd 里已进 tombstone', tombstoned, `id=${factId}`);
  // tombstone 行不带原文，所以「删干净了吗」要看索引，不看 JSONL 文本。
  if (existsSync(INDEX)) {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(INDEX, { readOnly: true });
    const left = db.prepare('select count(*) as n from chunks where text like ?').get(`%${textA}%`).n;
    db.close();
    check('索引里已搜不到 A', left === 0, `chunk ${left} 条`);
  }

  // 6. 清理 B（memd 在线，不会留下镜像）
  await remove('private:709038511', 'activeTopic', textB);
  await sleep(800);
  check('B 已从 social-v2 清掉', !readFileSync(`${BRIDGE}/state/social-v2.json`, 'utf8').includes(textB));
} catch (error) {
  console.log(`ERROR ${error?.message ?? error}`);
} finally {
  if (watchdogPaused) {
    const restored = run('schtasks.exe', ['/change', '/tn', 'memd-watchdog', '/enable']);
    console.log(`看护任务恢复${restored ? '成功' : '失败——手工执行 schtasks /change /tn memd-watchdog /enable'}`);
  }
  const failed = results.filter((entry) => !entry.ok).length;
  console.log(`\n结果：${results.length - failed}/${results.length} 通过`);
  process.exit(failed === 0 ? 0 : 1);
}
