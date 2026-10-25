#!/usr/bin/env node
// 同条件基准：同一台机器、同一个假 SnowLuma、同一工作负载，对比「直连上游」与「经过接口平台兼容入口」。
// 只测平台自身引入的相对开销；真实后端的延迟预算要在 Windows 实机 + 真 SnowLuma 上重测（见 docs/MILESTONES.md）。
//
// 用法：node test/bench-latency.mjs [--n 2000] [--size 200]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeSnowLuma } from './fixtures/fake-snowluma.mjs';
import { startPlatform } from '../src/index.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const N = arg('--n', 2000);
const SIZE = arg('--size', 200);

function pct(arr, p) { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; }
function summary(name, rtts, ms) {
  return `${name.padEnd(10)} P50 ${pct(rtts, 50).toFixed(3)}ms  P95 ${pct(rtts, 95).toFixed(3)}ms  P99 ${pct(rtts, 99).toFixed(3)}ms  吞吐 ${(rtts.length / (ms / 1000)).toFixed(0)}/s`;
}

async function open(url) {
  const w = new WebSocket(url);
  await new Promise((r, x) => { w.onopen = r; w.onerror = () => x(new Error(`连不上 ${url}`)); });
  return w;
}

/** 顺序发 N 个动作，测每个的往返时间。 */
async function actionRtts(w) {
  const pending = new Map();
  w.onmessage = (m) => { const o = JSON.parse(m.data); const p = pending.get(o.echo); if (p) { pending.delete(o.echo); p(); } };
  const text = 'x'.repeat(SIZE);
  const rtts = [];
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    const s = performance.now();
    await new Promise((r) => { pending.set(`b${i}`, r); w.send(JSON.stringify({ action: 'send_group_msg', params: { group_id: 20001, message: text }, echo: `b${i}` })); });
    rtts.push(performance.now() - s);
  }
  return { rtts, ms: performance.now() - t0 };
}

/** 上游推 N 个事件，测到达客户端的时间（事件里带发送时刻）。 */
async function eventLatency(fake, w) {
  const lat = [];
  let done;
  const all = new Promise((r) => { done = r; });
  w.onmessage = (m) => {
    const o = JSON.parse(m.data);
    if (o.post_type !== 'message') return;
    lat.push(performance.now() - o.bench_t);
    if (lat.length === N) done();
  };
  for (let i = 0; i < N; i++) {
    fake.push({ post_type: 'message', message_type: 'group', group_id: 20001, user_id: 30001, message_id: i, message: 'x'.repeat(SIZE), sender: { user_id: 30001 }, bench_t: performance.now() });
    if (i % 50 === 0) await new Promise((r) => setImmediate(r));
  }
  await all;
  return lat;
}

const fake = await createFakeSnowLuma();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-bench-'));
fs.writeFileSync(path.join(dataDir, 'platform.json'), JSON.stringify({ port: 0, instances: [{ id: 'bench', provider: 'snowluma', upstream: { wsUrl: fake.url, accessToken: fake.token } }] }));
const p = await startPlatform({ dataDir, stdoutLogs: false, installSignalHandlers: false, exitOnShutdown: false });
const until = async (fn) => { while (!fn()) await new Promise((r) => setTimeout(r, 20)); };
await until(() => p.platform.accounts().some((a) => a.health.loggedIn));

console.log(`基准：N=${N}，载荷 ${SIZE} 字节，Node ${process.versions.node}，${process.platform}/${process.arch}`);
const cpu0 = process.cpuUsage();
const direct = await open(`${fake.url}?access_token=${fake.token}`);
const viaPl = await open(`ws://127.0.0.1:${p.port}/onebot/v11/ws?access_token=${p.platform.tokens.data}`);

// 预热
await actionRtts(direct); await actionRtts(viaPl);

const d = await actionRtts(direct);
const v = await actionRtts(viaPl);
console.log('\n动作往返（客户端 → 上游 → 客户端）');
console.log(summary('直连', d.rtts, d.ms));
console.log(summary('经平台', v.rtts, v.ms));
console.log(`新增开销 P50 ${(pct(v.rtts, 50) - pct(d.rtts, 50)).toFixed(3)}ms  P99 ${(pct(v.rtts, 99) - pct(d.rtts, 99)).toFixed(3)}ms`);

direct.close();
const evPl = await eventLatency(fake, viaPl);
console.log('\n事件推送（上游 → 平台 → 客户端，同进程计时）');
console.log(`经平台     P50 ${pct(evPl, 50).toFixed(3)}ms  P95 ${pct(evPl, 95).toFixed(3)}ms  P99 ${pct(evPl, 99).toFixed(3)}ms`);

const cpu = process.cpuUsage(cpu0);
console.log(`\n进程 CPU（含假上游与客户端）：用户 ${(cpu.user / 1000).toFixed(0)}ms / 系统 ${(cpu.system / 1000).toFixed(0)}ms；RSS ${(process.memoryUsage().rss / 1048576).toFixed(1)}MB`);
console.log('注意：假上游、平台、客户端在同一进程内，结果只用于比较相对开销，不是交付承诺。');
viaPl.close();
await p.shutdown('bench');
await fake.close();
