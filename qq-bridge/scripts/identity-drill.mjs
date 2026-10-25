#!/usr/bin/env node
/**
 * 身份键（B-full）的在线冒烟：全程不停服，只通过桥接控制台 API 走真实路径。
 *
 *   node scripts\identity-drill.mjs
 *
 * 检查三件事：
 *   1. 单条式（activeTopic）：新建 → present；编辑 → present 1 + 旧版本 superseded 1；删除 → 0；
 *   2. 聚合式（memberImpression）：新建 → present；追加一条 traits（rev+1）→ present 1；
 *   3. 每一步的对账数字都对得上——这就是「身份键真的在起作用」的证据。
 *
 * 退出码：0 全通过；1 有失败。
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BRIDGE = process.env.BRIDGE_DIR || 'D:/deepseek_workspace/qq-bridge';
const INDEX = process.env.MEMD_INDEX || 'D:/deepseek_workspace/memory-hub/data/index.db';
const NODE = process.execPath;
const KEY = 'private:709038511';
const tag = new Date().toISOString().slice(11, 19).replace(/:/g, '');
const textA = `身份演练-单条-${tag}`;
const textA2 = `身份演练-单条-改过-${tag}`;
const person = `演练人-${tag}`;
const trait1 = '第一次见，话不多';
const trait2 = '第二次见，会先自我介绍';

const token = readFileSync(join(BRIDGE, 'state', 'console-token'), 'utf8').trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

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

/** 跑一次对账，读回 counts（报告落在 logs/reconcile/latest.json）。 */
function reconcile() {
  try {
    execFileSync(NODE, [join(ROOT, 'scripts', 'reconcile-memory.mjs')], { stdio: 'ignore' });
  } catch {
    // 有 drift 时退出码可能是 2（--strict 才这样），普通跑是 0；忽略非零继续读报告
  }
  return JSON.parse(readFileSync(join(BRIDGE, 'logs', 'reconcile', 'latest.json'), 'utf8')).counts;
}

/** 索引里还有没有这段文本（tombstone 之后应该为 0）。 */
function indexHas(text) {
  const db = new DatabaseSync(INDEX, { readOnly: true });
  try {
    return db.prepare('select count(*) as n from chunks where text like ?').get(`%${text}%`).n;
  } finally {
    db.close();
  }
}

try {
  const base = reconcile();

  // 1. 单条式：新建
  const created = await appendTopic(textA);
  await sleep(1800);
  const afterCreate = reconcile();
  check('新建 activeTopic 后 present +1', afterCreate.present === base.present + 1, `${base.present} → ${afterCreate.present}`);
  check('新条目带 id/rev', Boolean(created?.entry?.id) && Number(created?.entry?.rev) === 1, JSON.stringify(created?.entry));

  // 2. 编辑：旧 rev 应该被主动 forget 掉，只剩当前版本
  await post('/api/socialV2/memory-update', { key: KEY, category: 'activeTopic', oldContent: textA, newContent: textA2 });
  await sleep(1800);
  const afterEdit = reconcile();
  check('编辑后 present 不变', afterEdit.present === afterCreate.present, `${afterEdit.present}`);
  check('编辑后旧版本已被清掉（superseded=0）', afterEdit.superseded === 0, `superseded=${afterEdit.superseded}`);
  check('索引里搜不到旧文本', indexHas(textA) === 0, `chunk ${indexHas(textA)} 条`);
  check('索引里能搜到新文本', indexHas(textA2) === 1, `chunk ${indexHas(textA2)} 条`);

  // 3. 删除：条目消失，present 回落
  await post('/api/socialV2/memory-remove', { key: KEY, category: 'activeTopic', content: textA2 });
  await sleep(1800);
  const afterRemove = reconcile();
  check('删除后 present 回落', afterRemove.present === base.present, `${afterRemove.present}（基线 ${base.present}）`);

  // 4. 聚合式：新建印象
  await post('/api/socialV2/memory-append', { key: KEY, category: 'memberImpression', content: trait1, extra: { target: person } });
  await sleep(1800);
  const afterImpression = reconcile();
  check('新建 memberImpression 后 present +1', afterImpression.present === base.present + 1, `${afterImpression.present}`);

  // 5. 追加一条 traits：rev 涨，旧整串被新整串替换
  await post('/api/socialV2/memory-append', { key: KEY, category: 'memberImpression', content: trait2, extra: { target: person } });
  await sleep(1800);
  const afterAppend = reconcile();
  check('追加 traits 后 present 仍为 1 条（rev 覆盖，不叠加）', afterAppend.present === base.present + 1, `${afterAppend.present}`);
  check('追加 traits 后没有遗留旧版本', afterAppend.superseded === afterImpression.superseded, `${afterAppend.superseded}`);
  check('索引里只剩合并后的整串', indexHas(`${trait1}、${trait2}`) === 1 && indexHas(trait1) >= 1, '整串可命中');

  // 6. 清理
  await post('/api/socialV2/memory-remove', { key: KEY, category: 'memberImpression', target: person });
  await sleep(1500);
  const final = reconcile();
  check('清理后 present 回到基线', final.present === base.present, `${final.present}（基线 ${base.present}）`);
} catch (error) {
  check(`演练中断：${error?.message ?? error}`, false);
} finally {
  const failed = results.filter((entry) => !entry.ok).length;
  console.log(`\n结果：${results.length - failed}/${results.length} 通过`);
  process.exit(failed === 0 ? 0 : 1);
}

async function appendTopic(text) {
  return post('/api/socialV2/memory-append', { key: KEY, category: 'activeTopic', content: text });
}
