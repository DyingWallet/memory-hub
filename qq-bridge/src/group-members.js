// 持久化的群成员表：跨场景披露的成员校验依据。
//
// 为什么要落盘：披露要求「确认提问者是这个群的成员」，而成员表来自 QQ 接口。
// 每次都去拉一遍太慢、也容易被限频；只在**检测到成员变化**时更新就够了：
//   · group_increase → 加入；group_decrease → 移出；group_card → 只改备注，不动成员集；
//   · 断线期间漏掉的事件由 reconcileGroupMembers 在重连后对账（bridge.js 已有）；
//   · 兜底：条目超过 maxAgeMs（默认 24 小时）才强制重拉一次，防止长期缺席。
//
// 安全口径：拿不到成员表时**拒绝**（fail-closed），不拿旧缓存放行——旧缓存可能还留着
// 已经退群的人，那等于让退群的人继续读群历史。
import fs from 'node:fs';
import path from 'node:path';

export const GROUP_MEMBER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * @param {object} options
 * @param {string} options.file 持久化路径（bridge 的 state/ 下）
 * @param {number} [options.maxAgeMs] 超过多久强制重拉
 * @param {() => number} [options.now]
 * @param {{info?:Function,warn?:Function}} [options.logger]
 */
export function createGroupMemberStore({ file, maxAgeMs = GROUP_MEMBER_MAX_AGE_MS, now = Date.now, logger = console } = {}) {
  let state = { version: 1, groups: {} };
  let loaded = false;

  function load() {
    if (loaded) return;
    loaded = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.groups && typeof parsed.groups === 'object') {
        state = { version: 1, groups: parsed.groups };
      }
    } catch {
      // 首次运行 / 文件损坏：当作空表，下一次 ensure 会重新拉。
    }
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (error) {
      logger?.warn?.(`[group-members] 写入失败：${error?.message ?? error}`);
    }
  }

  function entry(groupId) {
    load();
    return state.groups[String(groupId)] ?? null;
  }

  function isMember(groupId, userId) {
    const e = entry(groupId);
    if (!e) return false;
    return e.ids.includes(String(userId));
  }

  function set(groupId, ids, source = 'fetch') {
    load();
    const gid = String(groupId);
    state.groups[gid] = {
      ids: Array.from(new Set(ids.map(String).filter(Boolean))),
      updatedAt: now(),
      source,
    };
    save();
    return state.groups[gid];
  }

  function add(groupId, userId) {
    const e = entry(groupId);
    if (!e) return null; // 没有基线就不猜：等下一次 full fetch
    const uid = String(userId);
    if (e.ids.includes(uid)) return e;
    e.ids.push(uid);
    e.updatedAt = now();
    e.source = 'event';
    save();
    return e;
  }

  function remove(groupId, userId) {
    const e = entry(groupId);
    if (!e) return null;
    const uid = String(userId);
    const next = e.ids.filter((id) => id !== uid);
    if (next.length === e.ids.length) return e;
    e.ids = next;
    e.updatedAt = now();
    e.source = 'event';
    save();
    return e;
  }

  function needsRefresh(groupId) {
    const e = entry(groupId);
    if (!e || !Array.isArray(e.ids) || e.ids.length === 0) return true;
    return now() - Number(e.updatedAt || 0) > maxAgeMs;
  }

  /**
   * 确保某群的成员表可用；需要时用 fetchIds 重拉。
   * @returns {Promise<{ok: boolean, source: 'cache'|'fetch', error?: string}>}
   */
  async function ensure(groupId, fetchIds, { force = false } = {}) {
    if (!force && !needsRefresh(groupId)) return { ok: true, source: 'cache' };
    let ids;
    try {
      ids = await fetchIds(String(groupId));
    } catch (error) {
      return { ok: false, source: 'fetch', error: error?.message ?? String(error) };
    }
    if (!Array.isArray(ids) || ids.length === 0) {
      return { ok: false, source: 'fetch', error: '成员表为空' };
    }
    set(groupId, ids, 'fetch');
    return { ok: true, source: 'fetch' };
  }

  /** 校验 + 必要时刷新；拿不到成员表时 member=false（fail-closed）。 */
  async function verifyMember(groupId, userId, fetchIds, options = {}) {
    const ensured = await ensure(groupId, fetchIds, options);
    if (!ensured.ok) return { member: false, reason: `无法校验群 ${groupId} 成员：${ensured.error}` };
    return { member: isMember(groupId, userId), reason: null };
  }

  /**
   * 批量刷新（每天一次的兜底）：force=false 时只刷「过期或没有基线」的群。
   * 返回每个群刷新了多少人、哪些失败——调用方只记日志，不因为某个群失败而中断。
   */
  async function refreshAll(groupIds, fetchIds, { force = false } = {}) {
    const refreshed = [];
    const failed = [];
    for (const groupId of groupIds ?? []) {
      const gid = String(groupId);
      const result = await ensure(gid, fetchIds, { force });
      if (!result.ok) {
        failed.push({ groupId: gid, error: result.error ?? 'unknown' });
        continue;
      }
      const current = entry(gid);
      refreshed.push({ groupId: gid, source: result.source, members: current?.ids?.length ?? 0 });
    }
    return { refreshed, failed };
  }

  /** 成员事件：join 加入、leave 移出、card 不动成员集（只有备注变了）。 */
  function applyNotice({ groupId, userId, kind }) {
    if (!groupId || !userId) return null;
    if (kind === 'join' || kind === 'increase') return add(groupId, userId);
    if (kind === 'leave' || kind === 'decrease') return remove(groupId, userId);
    return entry(groupId);
  }

  function groupsOf(userId) {
    load();
    const uid = String(userId);
    return Object.entries(state.groups)
      .filter(([, e]) => Array.isArray(e.ids) && e.ids.includes(uid))
      .map(([gid]) => gid);
  }

  function stats() {
    load();
    return Object.fromEntries(
      Object.entries(state.groups).map(([gid, e]) => [gid, { members: e.ids.length, updatedAt: e.updatedAt, source: e.source }]),
    );
  }

  return { file, isMember, set, add, remove, needsRefresh, ensure, verifyMember, refreshAll, applyNotice, groupsOf, stats };
}
