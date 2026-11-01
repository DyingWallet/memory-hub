// 配额：每人每日、每群每日、冷却。
//
// 落盘到 state/draw-quota.json，桥接重启后恢复；
// 结构按「日期」分桶，跨天自动清零（读取时判断 date 是否今天）。
//
// 额度表可由 config.draw.json 的 quotaOverride 覆盖（测试期放开群额度，
// 测完把 quotaOverride 设成 null 就回到 policy.js 的默认值）。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { QUOTA_TABLE } from './policy.js';

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** null / 非数字 / 负数 一律视为「不限」。 */
function normalizeLimit(v) {
  if (v === null || v === Infinity) return Infinity;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return Infinity;
  return n;
}

/** 合并 quotaOverride；只写要改的字段即可，其余沿用默认。
 *  注意用 hasOwnProperty 判断「有没有写」：`null ?? base` 会把显式的 null 吞掉，
 *  而这里的 null 恰恰是「不限」的意思（测试期放开额度就靠它）。 */
export function mergeQuotaTable(override) {
  const out = {};
  for (const [tier, base] of Object.entries(QUOTA_TABLE)) {
    const o = override?.[tier] ?? {};
    const pick = (k, d) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : d);
    out[tier] = {
      perUserDaily: normalizeLimit(pick('perUserDaily', base.perUserDaily)),
      cooldownMs: Math.max(0, Number(pick('cooldownMs', base.cooldownMs)) || 0),
      perGroupDaily: normalizeLimit(pick('perGroupDaily', base.perGroupDaily)),
    };
  }
  return out;
}

export function createQuotaStore(stateDir, { now = Date.now, save = true, table } = {}) {
  const quotaTable = table ?? QUOTA_TABLE;
  const file = join(stateDir, 'draw-quota.json');
  mkdirSync(dirname(file), { recursive: true });

  let data = { date: today(), users: {}, groups: {}, lastAt: {} };
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      if (raw?.date === today()) data = { ...data, ...raw };
    } catch {
      /* 文件坏了就当空的，别让出图功能挂掉 */
    }
  }

  function flush() {
    if (!save) return;
    try {
      writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    } catch {
      /* 写盘失败不影响本次出图 */
    }
  }

  /** 只读检查，不消费次数。 */
  function check({ key, userId, tier }) {
    if (data.date !== today()) {
      data = { date: today(), users: {}, groups: {}, lastAt: {} };
    }
    const q = quotaTable[tier] ?? quotaTable.normal;
    const userUsed = data.users?.[userId] ?? 0;
    if (Number.isFinite(q.perUserDaily) && userUsed >= q.perUserDaily) {
      return { ok: false, code: 'quota_user', remaining: 0, limit: q.perUserDaily };
    }
    const groupId = key?.startsWith('group:') ? key.slice(6) : null;
    if (groupId && Number.isFinite(q.perGroupDaily)) {
      const groupUsed = data.groups?.[groupId] ?? 0;
      if (groupUsed >= q.perGroupDaily) {
        return { ok: false, code: 'quota_group', remaining: 0, limit: q.perGroupDaily };
      }
    }
    const last = data.lastAt?.[userId] ?? 0;
    const wait = q.cooldownMs - (now() - last);
    if (q.cooldownMs > 0 && wait > 0) {
      return { ok: false, code: 'cooldown', waitMs: wait };
    }
    const remaining = Number.isFinite(q.perUserDaily) ? q.perUserDaily - userUsed : null;
    return { ok: true, remaining };
  }

  /** 消费一次：出图成功后才调，失败不扣。 */
  function consume({ key, userId }) {
    if (data.date !== today()) {
      data = { date: today(), users: {}, groups: {}, lastAt: {} };
    }
    data.users[userId] = (data.users[userId] ?? 0) + 1;
    const groupId = key?.startsWith('group:') ? key.slice(6) : null;
    if (groupId) data.groups[groupId] = (data.groups[groupId] ?? 0) + 1;
    data.lastAt[userId] = now();
    flush();
  }

  function reset({ userId, groupId }) {
    if (userId) {
      delete data.users[userId];
      delete data.lastAt[userId];
    }
    if (groupId) delete data.groups[groupId];
    flush();
  }

  return { check, consume, reset, _dump: () => data, _table: quotaTable };
}

// 测试用：内存模式
export function createMemoryQuotaStore(opts = {}) {
  return createQuotaStore(opts.stateDir ?? 'D:\\deepseek_workspace\\.tmp\\draw-quota-test', { ...opts, save: false });
}
