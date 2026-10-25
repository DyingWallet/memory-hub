// 只读探针（部署后验证用）：连 SnowLuma 的 OneBot WebSocket，打印收到的成员类通知的**字段结构**，
// 用来实测确认 group_increase / group_decrease / group_card / group_recall 的载荷与源码分析一致。
//
// 只连接、只读取：不发送任何消息、不创建会话、不写任何文件。
// 输出里的 QQ 号/群号默认打码（只保留后 3 位）；需要完整值排查时加 --raw（输出不要提交或外传）。
// 用法：node scripts/probe-member-events.mjs [监听秒数，默认 300] [--raw]
// 期间请用另一个号在测试群里：进群、改群名片后说一句话、撤回一条消息、退群。
import { SnowLumaWebSocketClient } from '@snowluma/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverSnowLumaConnection } from '../src/snowluma-conn.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const raw = process.argv.includes('--raw');
const seconds = Number(process.argv.find((a) => /^\d+$/.test(a))) || 300;

const disc = await discoverSnowLumaConnection({ cfg, timeoutMs: 5000 });
if (!disc.ok) {
  console.log(`❌ 无法发现可用的 SnowLuma 连接：${disc.error}`);
  process.exit(2);
}
const bot = new SnowLumaWebSocketClient({ url: disc.wsUrl, accessToken: disc.wsToken || disc.token || undefined, reconnect: false });
const mask = (v) => (raw || v == null ? v : `***${String(v).slice(-3)}`);
const WATCH = new Set(['group_increase', 'group_decrease', 'group_card', 'group_recall', 'friend_recall', 'notify']);
const counts = new Map();

bot.onEvent((event) => {
  if (event?.post_type !== 'notice' || !WATCH.has(event.notice_type)) return;
  counts.set(event.notice_type, (counts.get(event.notice_type) ?? 0) + 1);
  const shape = Object.fromEntries(Object.entries(event).map(([k, v]) => [k, `${typeof v}${['group_id', 'user_id', 'operator_id', 'self_id', 'target_id', 'sender_id'].includes(k) ? `=${mask(v)}` : ['sub_type', 'notice_type'].includes(k) ? `=${v}` : ''}`]));
  console.log(new Date().toISOString(), JSON.stringify(shape));
});
bot.on('open', () => console.log(`已连接 ${disc.wsUrl}，监听 ${seconds} 秒成员类通知…`));
await bot.connect();
setTimeout(() => {
  console.log('\n汇总：', JSON.stringify(Object.fromEntries(counts)));
  console.log('对照：docs/guides/CONTINUITY.md「SnowLuma 事件载荷」一节。group_card 只在改名片后**再说一句话**时才会出现（SnowLuma 由消息派生）。');
  try { bot.close(); } catch {}
  process.exit(0);
}, seconds * 1000);
