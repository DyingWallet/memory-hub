// 全局人物库：以 QQ 号为唯一主键，记录每个人在各群的名片/昵称、成员关系、认识程度与分层记忆。
//
// 设计约束（来自 docs/guides/CONTINUITY.md，硬性）：
//   · 身份只认 QQ 号。昵称/群名片只是附带字段，**绝不**用来合并两个 QQ 号，也不用来猜身份。
//     「同名不同号」= 两个人；「同号不同名」= 一个人。小号关联只能由管理员显式设置。
//   · 记忆按作用域存放：group:<群号> / private:<QQ号> / global。可见范围在**注入时**由
//     memory-policy.js 过滤，模型拿不到超出当前会话可见范围的条目。
//   · 首次部署时群里已有的成员只标记为 listed（见过名单），不当作新人。
//   · 删除是真删除：deletePerson 抹掉此人全部作用域的记录。
//
// 本模块只做数据与规则，不碰网络、不碰 DSH；时间来源可注入，便于离线测试。

import { createJsonStore } from '../lib/json-store.js';

export const ACQUAINTANCE_LEVELS = ['listed', 'observed', 'talked', 'familiar'];
const NOTE_MAX_CHARS = 120;
const NOTES_PER_SCOPE = 30;
const HISTORY_MAX = 10;
const QQ_RE = /^[1-9]\d{0,11}$/;
const GROUP_RE = /^[1-9]\d{0,11}$/;

export function normalizeQQ(value) {
  const s = String(value ?? '').trim();
  return QQ_RE.test(s) ? s : null;
}

export function normalizeGroupId(value) {
  const s = String(value ?? '').trim();
  return GROUP_RE.test(s) ? s : null;
}

// 控制字符 / 零宽字符 / 双向控制符 / BOM：用码点构造，避免源码里出现不可见字符。
const INVISIBLE_RE = new RegExp(`[${[[0x00, 0x1f], [0x7f, 0x7f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff]]
  .map(([a, b]) => `${String.fromCharCode(92)}u${a.toString(16).padStart(4, '0')}-${String.fromCharCode(92)}u${b.toString(16).padStart(4, '0')}`).join('')}]`, 'g');

/** 对外导出：任何要进提示词/事件文本的名片昵称都先过这里。 */
export function cleanDisplayName(value, max = 30) {
  return cleanName(value, max);
}

function cleanName(value, max = 60) {
  // 名片/昵称来自群友，可能含换行/控制字符/零宽字符；只保留可显示的单行文本。
  return String(value ?? '')
    .replace(/[\r\n\t\v\f]/g, ' ')
    .replace(INVISIBLE_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function levelIndex(level) {
  const i = ACQUAINTANCE_LEVELS.indexOf(level);
  return i < 0 ? 0 : i;
}

function pushHistory(list, value, at) {
  const arr = Array.isArray(list) ? list : [];
  if (!value) return arr;
  if (arr.length && arr[arr.length - 1].value === value) return arr;
  arr.push({ value, at });
  if (arr.length > HISTORY_MAX) arr.splice(0, arr.length - HISTORY_MAX);
  return arr;
}

function emptyData() {
  return {
    people: {},
    groups: {},
    legacyReview: [],
    migrations: { memberImpressions: {} },
    noteSeq: 0,
  };
}

/** 把 scope 字符串规整为 group:<id> / private:<qq> / global；非法返回 null。 */
export function normalizeScope(scope) {
  const s = String(scope ?? '').trim();
  if (s === 'global') return 'global';
  const m = /^(group|private):(\d+)$/.exec(s);
  if (!m) return null;
  const id = m[1] === 'group' ? normalizeGroupId(m[2]) : normalizeQQ(m[2]);
  return id ? `${m[1]}:${id}` : null;
}

/**
 * @param {object} opts
 * @param {string} opts.file   state/social/people.json
 * @param {() => number} [opts.now]
 * @param {(m:string)=>void} [opts.log]
 * @param {number} [opts.dedupeWindowMs] 同一入群/退群事件的去重窗口
 * @param {number} [opts.returningGapMs]  超过这个间隔再出现算「久别回归」
 */
export function createPeopleRegistry({ file, now = Date.now, log = () => {}, dedupeWindowMs = 10 * 60 * 1000, returningGapMs = 30 * 24 * 60 * 60 * 1000 } = {}) {
  const store = createJsonStore({
    file,
    version: 1,
    empty: emptyData,
    log,
  });
  const recentEvents = new Map(); // 事件指纹 -> 时间
  let dirty = false;
  let saveTimer = null;

  function data() { return store.data; }

  function markDirty() {
    dirty = true;
    if (saveTimer) return;
    // 消息高峰时合并写盘：最多 2 秒落一次。
    saveTimer = setTimeout(() => { saveTimer = null; flush(); }, 2000);
    saveTimer.unref?.();
  }

  function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!dirty) return;
    try {
      store.save();
      dirty = false;
    } catch (error) {
      log(`⚠️ 人物库写盘失败：${error?.message ?? error}`);
    }
  }

  function ensurePerson(qq, at) {
    const people = data().people;
    let p = people[qq];
    let created = false;
    if (!p) {
      p = {
        qq,
        firstSeenAt: at,
        lastSeenAt: at,
        firstSeenIn: null,
        nickname: '',
        nicknameHistory: [],
        acquaintance: 'listed',
        acquaintanceSetBy: null,
        preferredName: null,
        preferences: {},
        groups: {},
        private: null,
        notes: [],
        aliases: [],
        talkCount: 0,
      };
      people[qq] = p;
      created = true;
    }
    return { p, created };
  }

  function ensureGroupEntry(p, groupId, at, source) {
    let g = p.groups[groupId];
    let created = false;
    if (!g) {
      g = {
        status: 'member',
        card: '',
        cardHistory: [],
        firstSeenAt: at,
        lastSeenAt: at,
        joinedAt: null,
        leftAt: null,
        joinCount: 0,
        messageCount: 0,
        source,
      };
      p.groups[groupId] = g;
      created = true;
    }
    return { g, created };
  }

  function raiseAcquaintance(p, level) {
    if (p.acquaintanceSetBy === 'admin') return; // 管理员手动设定过就不再自动改
    if (levelIndex(level) > levelIndex(p.acquaintance)) p.acquaintance = level;
  }

  function seenEvent(fingerprint) {
    const t = now();
    for (const [k, at] of recentEvents) if (t - at > dedupeWindowMs) recentEvents.delete(k);
    if (recentEvents.has(fingerprint)) return true;
    recentEvents.set(fingerprint, t);
    if (recentEvents.size > 5000) recentEvents.delete(recentEvents.keys().next().value);
    return false;
  }

  function otherGroupsOf(p, exceptGroupId) {
    return Object.entries(p.groups)
      .filter(([gid]) => gid !== exceptGroupId)
      .map(([gid, g]) => ({ groupId: gid, status: g.status, lastSeenAt: g.lastSeenAt, source: g.source }));
  }

  /**
   * 记一次「看到此人发消息」。
   * @returns {{qq, isNewPerson, isNewInGroup, cardChanged, nicknameChanged, returningAfterMs}|null}
   */
  function observeMessage({ kind, groupId = null, userId, card = '', nickname = '', directedAtSelf = false } = {}) {
    const qq = normalizeQQ(userId);
    if (!qq) return null;
    const at = now();
    const { p, created } = ensurePerson(qq, at);
    const gap = created ? 0 : at - (Number(p.lastSeenAt) || at);
    const result = { qq, isNewPerson: created, isNewInGroup: false, cardChanged: null, nicknameChanged: null, returningAfterMs: gap >= returningGapMs ? gap : 0 };
    const nick = cleanName(nickname);
    if (nick && nick !== p.nickname) {
      if (p.nickname) result.nicknameChanged = { from: p.nickname, to: nick };
      p.nickname = nick;
      p.nicknameHistory = pushHistory(p.nicknameHistory, nick, at);
    }
    if (kind === 'group') {
      const gid = normalizeGroupId(groupId);
      if (gid) {
        if (!p.firstSeenIn) p.firstSeenIn = `group:${gid}`;
        const { g, created: newInGroup } = ensureGroupEntry(p, gid, at, 'message');
        result.isNewInGroup = newInGroup;
        const c = cleanName(card);
        if (c && c !== g.card) {
          if (g.card) result.cardChanged = { from: g.card, to: c };
          g.card = c;
          g.cardHistory = pushHistory(g.cardHistory, c, at);
        }
        if (g.status !== 'member') { g.status = 'member'; g.leftAt = null; }
        g.lastSeenAt = at;
        g.messageCount = (Number(g.messageCount) || 0) + 1;
      }
    } else if (kind === 'private') {
      if (!p.firstSeenIn) p.firstSeenIn = `private:${qq}`;
      p.private = p.private ?? { firstSeenAt: at, lastSeenAt: at, messageCount: 0 };
      p.private.lastSeenAt = at;
      p.private.messageCount = (Number(p.private.messageCount) || 0) + 1;
    }
    p.lastSeenAt = at;
    raiseAcquaintance(p, kind === 'private' || directedAtSelf ? 'talked' : 'observed');
    if (kind === 'private' || directedAtSelf) p.talkCount = (Number(p.talkCount) || 0) + 1;
    markDirty();
    return result;
  }

  /**
   * 记一次入群通知（notice/group_increase）。
   * category：
   *   stranger        —— 系统第一次认识这个 QQ 号
   *   knownElsewhere  —— 在其他（允许记录的）群见过
   *   returning       —— 以前就在本群，退群后又回来
   *   alreadyMember   —— 本群记录里本来就是成员（多半是首次部署前就在、或漏了退群事件）
   *   duplicate       —— 重复投递的同一事件，调用方应忽略
   */
  function observeJoin({ groupId, userId, card = '', nickname = '', time = null, subType = '', operatorId = null } = {}) {
    const qq = normalizeQQ(userId);
    const gid = normalizeGroupId(groupId);
    if (!qq || !gid) return null;
    const fp = `join:${gid}:${qq}:${time ?? ''}`;
    if (seenEvent(fp)) return { category: 'duplicate', qq, groupId: gid };
    const at = now();
    const existed = !!data().people[qq];
    const { p } = ensurePerson(qq, at);
    const prior = p.groups[gid] ? { ...p.groups[gid] } : null;
    // 逻辑去重：同一人在去重窗口内已被记为本群「刚入群」，就不再当作新事件（断线重连重放）。
    if (prior && prior.status === 'member' && prior.joinedAt && at - prior.joinedAt < dedupeWindowMs) {
      return { category: 'duplicate', qq, groupId: gid };
    }
    const others = otherGroupsOf(p, gid);
    let category;
    if (!existed) category = 'stranger';
    else if (prior && prior.status === 'left') category = 'returning';
    else if (prior && prior.status === 'member') category = 'alreadyMember';
    else if (others.length > 0 || p.private) category = 'knownElsewhere';
    else category = 'stranger';
    const { g } = ensureGroupEntry(p, gid, at, 'join');
    g.status = 'member';
    g.joinedAt = at;
    g.leftAt = null;
    g.joinCount = (Number(g.joinCount) || 0) + 1;
    g.lastSeenAt = at;
    if (prior === null) g.source = 'join';
    const c = cleanName(card);
    if (c && c !== g.card) { g.card = c; g.cardHistory = pushHistory(g.cardHistory, c, at); }
    const nick = cleanName(nickname);
    if (nick && nick !== p.nickname) { p.nickname = nick; p.nicknameHistory = pushHistory(p.nicknameHistory, nick, at); }
    if (!p.firstSeenIn) p.firstSeenIn = `group:${gid}`;
    p.lastSeenAt = at;
    markDirty();
    return {
      category,
      qq,
      groupId: gid,
      subType: String(subType || ''),
      operatorId: normalizeQQ(operatorId),
      otherGroups: others,
      knownPrivately: !!p.private,
      acquaintance: p.acquaintance,
      previous: prior,
    };
  }

  /** 记一次退群/被踢（notice/group_decrease）。 */
  function observeLeave({ groupId, userId, time = null, subType = '', operatorId = null } = {}) {
    const qq = normalizeQQ(userId);
    const gid = normalizeGroupId(groupId);
    if (!qq || !gid) return null;
    if (seenEvent(`leave:${gid}:${qq}:${time ?? ''}`)) return { category: 'duplicate', qq, groupId: gid };
    const at = now();
    const p = data().people[qq];
    if (!p || !p.groups[gid]) {
      // 没见过的人退群：只建最小记录，不制造「认识」。
      const { p: np } = ensurePerson(qq, at);
      const { g } = ensureGroupEntry(np, gid, at, 'leave');
      g.status = 'left';
      g.leftAt = at;
      markDirty();
      return { category: 'unknownLeft', qq, groupId: gid, subType: String(subType || ''), operatorId: normalizeQQ(operatorId) };
    }
    const g = p.groups[gid];
    if (g.status === 'left' && g.leftAt && at - g.leftAt < dedupeWindowMs) return { category: 'duplicate', qq, groupId: gid };
    g.status = 'left';
    g.leftAt = at;
    markDirty();
    return { category: 'left', qq, groupId: gid, subType: String(subType || ''), operatorId: normalizeQQ(operatorId), card: g.card };
  }

  /** 群名片变更（notice/group_card）。返回 { from, to } 或 null（无变化）。 */
  function observeCardChange({ groupId, userId, cardNew = '', cardOld = '' } = {}) {
    const qq = normalizeQQ(userId);
    const gid = normalizeGroupId(groupId);
    if (!qq || !gid) return null;
    const at = now();
    const { p } = ensurePerson(qq, at);
    const { g } = ensureGroupEntry(p, gid, at, 'card');
    const to = cleanName(cardNew);
    const from = g.card || cleanName(cardOld);
    if (to === g.card) return null;
    g.card = to;
    g.cardHistory = pushHistory(g.cardHistory, to, at);
    markDirty();
    return { qq, groupId: gid, from, to };
  }

  /**
   * 首次部署 / 重连后的成员名单对账。
   * 首次（该群没有 baselineAt）：所有人只标 listed，**不当作新人**、不触发任何唤醒。
   * 之后：名单里有、记录里没有的 → 记为成员（source=reconcile，漏掉的入群事件，不唤醒）；
   *       记录里是成员、名单里没有的 → 记为 left（source=reconcile）。
   * @param {Array<{user_id, card?, nickname?, join_time?}>} members
   */
  function reconcileGroup(groupId, members, { selfId = null } = {}) {
    const gid = normalizeGroupId(groupId);
    if (!gid || !Array.isArray(members)) return null;
    const at = now();
    const groups = data().groups;
    const meta = groups[gid] ?? (groups[gid] = { baselineAt: null, lastReconcileAt: null });
    const first = !meta.baselineAt;
    const present = new Set();
    let added = 0;
    let missedJoins = 0;
    for (const m of members) {
      const qq = normalizeQQ(m?.user_id);
      if (!qq || (selfId != null && qq === String(selfId))) continue;
      present.add(qq);
      const { p } = ensurePerson(qq, at);
      const { g, created } = ensureGroupEntry(p, gid, at, first ? 'baseline' : 'reconcile');
      if (created) {
        added += 1;
        if (!first) missedJoins += 1;
        const jt = Number(m?.join_time);
        if (Number.isFinite(jt) && jt > 0) g.joinedAt = jt * 1000;
      }
      if (g.status !== 'member') { g.status = 'member'; g.leftAt = null; }
      const c = cleanName(m?.card);
      if (c && c !== g.card) { g.card = c; g.cardHistory = pushHistory(g.cardHistory, c, at); }
      const nick = cleanName(m?.nickname);
      if (nick && nick !== p.nickname) { p.nickname = nick; p.nicknameHistory = pushHistory(p.nicknameHistory, nick, at); }
      if (!p.firstSeenIn) p.firstSeenIn = `group:${gid}`;
    }
    let missedLeaves = 0;
    if (!first) {
      for (const p of Object.values(data().people)) {
        const g = p.groups[gid];
        if (g && g.status === 'member' && !present.has(p.qq)) {
          g.status = 'left';
          g.leftAt = at;
          missedLeaves += 1;
        }
      }
    }
    if (first) meta.baselineAt = at;
    meta.lastReconcileAt = at;
    markDirty();
    return { groupId: gid, baseline: first, added, missedJoins, missedLeaves, total: present.size };
  }

  function hasBaseline(groupId) {
    const gid = normalizeGroupId(groupId);
    return !!(gid && data().groups[gid]?.baselineAt);
  }

  function getPerson(userId) {
    const qq = normalizeQQ(userId);
    return qq ? (data().people[qq] ?? null) : null;
  }

  /** 列出人物（管理用）。query 只做子串匹配，结果仍以 QQ 号区分，不合并同名。 */
  function listPeople({ groupId = null, query = '', limit = 50 } = {}) {
    const gid = groupId ? normalizeGroupId(groupId) : null;
    const q = cleanName(query).toLowerCase();
    const out = [];
    for (const p of Object.values(data().people)) {
      if (gid && !p.groups[gid]) continue;
      if (q) {
        const hay = [p.qq, p.nickname, p.preferredName?.value ?? '', ...Object.values(p.groups).map((g) => g.card)].join(' ').toLowerCase();
        if (!hay.includes(q)) continue;
      }
      out.push(p);
    }
    out.sort((a, b) => (Number(b.lastSeenAt) || 0) - (Number(a.lastSeenAt) || 0));
    return out.slice(0, Math.max(1, Math.min(500, limit)));
  }

  /**
   * 在指定会话里按「名字」找人：只返回候选列表，**不**替调用方挑一个。
   * 同名多人时调用方必须让人确认（或直接用 QQ 号）。
   */
  function findByName(name, { groupId = null } = {}) {
    const n = cleanName(name);
    if (!n) return [];
    const gid = groupId ? normalizeGroupId(groupId) : null;
    return Object.values(data().people).filter((p) => {
      if (gid) return p.groups[gid]?.card === n || (p.nickname === n && p.groups[gid]);
      return p.nickname === n || Object.values(p.groups).some((g) => g.card === n);
    }).map((p) => p.qq);
  }

  function nextNoteId() {
    data().noteSeq = (Number(data().noteSeq) || 0) + 1;
    return `n${data().noteSeq}`;
  }

  /**
   * 添加一条人物记忆。
   * scope 决定它属于哪个会话；visibility 默认等于 scope（最严）。
   * share=true 时进入 pending，管理员批准后才变成 public（跨群共享）。
   */
  function addNote(userId, { text, scope, source = 'witnessed', certainty = 'impression', origin = 'ai', share = false, pinned = false, reportedBy = null } = {}) {
    const qq = normalizeQQ(userId);
    if (!qq) throw Object.assign(new Error('userId 必须是 QQ 号'), { statusCode: 400 });
    const sc = normalizeScope(scope);
    if (!sc) throw Object.assign(new Error('scope 必须是 group:<群号> / private:<QQ号> / global'), { statusCode: 400 });
    const clean = cleanName(text, NOTE_MAX_CHARS);
    if (!clean) throw Object.assign(new Error('记忆内容不能为空'), { statusCode: 400 });
    if (!['witnessed', 'backread', 'hearsay', 'inferred'].includes(source)) source = 'witnessed';
    if (!['explicit', 'impression'].includes(certainty)) certainty = 'impression';
    const at = now();
    const { p } = ensurePerson(qq, at);
    const existing = p.notes.find((n) => n.scope === sc && n.text === clean);
    if (existing) {
      existing.updatedAt = at;
      if (pinned) existing.pinned = true;
      if (share && existing.shareStatus === 'local') existing.shareStatus = 'pending';
      markDirty();
      return existing;
    }
    const inScope = p.notes.filter((n) => n.scope === sc);
    if (inScope.length >= NOTES_PER_SCOPE) {
      // 满了先淘汰最旧的非 pinned 条目；全是 pinned 就拒绝。
      const victim = inScope.filter((n) => !n.pinned).sort((a, b) => a.updatedAt - b.updatedAt)[0];
      if (!victim) throw Object.assign(new Error('该作用域的置顶记忆已满'), { statusCode: 409 });
      p.notes = p.notes.filter((n) => n !== victim);
    }
    const isGlobal = sc === 'global';
    const note = {
      id: nextNoteId(),
      text: clean,
      scope: sc,
      // global 作用域只有管理员能直接写入；它天然是 public。
      visibility: isGlobal ? 'public' : sc,
      shareStatus: isGlobal ? 'approved' : (share ? 'pending' : 'local'),
      source,
      certainty,
      origin,
      pinned: !!pinned,
      reportedBy: normalizeQQ(reportedBy),
      createdAt: at,
      updatedAt: at,
    };
    p.notes.push(note);
    markDirty();
    return note;
  }

  function findNote(qq, noteId) {
    const p = getPerson(qq);
    return p ? (p.notes.find((n) => n.id === noteId) ?? null) : null;
  }

  /** 管理员批准/驳回一条共享申请。批准后 visibility=public（跨群可见，受共享策略再过滤）。 */
  function reviewNote(userId, noteId, approve) {
    const note = findNote(normalizeQQ(userId), String(noteId));
    if (!note) return null;
    if (approve) { note.shareStatus = 'approved'; note.visibility = 'public'; }
    else { note.shareStatus = 'local'; note.visibility = note.scope === 'global' ? 'public' : note.scope; }
    note.updatedAt = now();
    markDirty();
    return note;
  }

  function deleteNote(userId, noteId) {
    const p = getPerson(userId);
    if (!p) return false;
    const before = p.notes.length;
    p.notes = p.notes.filter((n) => n.id !== String(noteId));
    if (p.notes.length !== before) { markDirty(); return true; }
    return false;
  }

  /** 编辑一条记忆的文字（纠正）。纠正后的条目自动置顶，不参与淘汰。 */
  function editNote(userId, noteId, text) {
    const note = findNote(normalizeQQ(userId), String(noteId));
    if (!note) return null;
    const clean = cleanName(text, NOTE_MAX_CHARS);
    if (!clean) throw Object.assign(new Error('记忆内容不能为空'), { statusCode: 400 });
    note.text = clean;
    note.pinned = true;
    note.certainty = 'explicit';
    note.updatedAt = now();
    markDirty();
    return note;
  }

  /** 管理员可改的字段：称呼、认识程度、互动偏好、小号关联。其余字段由事件驱动。 */
  function updatePerson(userId, patch = {}, { by = 'admin' } = {}) {
    const qq = normalizeQQ(userId);
    if (!qq) throw Object.assign(new Error('userId 必须是 QQ 号'), { statusCode: 400 });
    const { p } = ensurePerson(qq, now());
    if (patch.preferredName !== undefined) {
      const v = cleanName(patch.preferredName, 30);
      p.preferredName = v ? { value: v, setBy: by, at: now() } : null;
    }
    if (patch.acquaintance !== undefined) {
      if (!ACQUAINTANCE_LEVELS.includes(patch.acquaintance)) throw Object.assign(new Error(`acquaintance 必须是 ${ACQUAINTANCE_LEVELS.join(' / ')}`), { statusCode: 400 });
      p.acquaintance = patch.acquaintance;
      p.acquaintanceSetBy = by;
    }
    if (patch.preferences && typeof patch.preferences === 'object') {
      const allowedKeys = ['teasing', 'proactiveChat', 'poke', 'recallPast'];
      for (const k of allowedKeys) {
        if (patch.preferences[k] === undefined) continue;
        const v = patch.preferences[k];
        if (v === null) delete p.preferences[k];
        else if (['ok', 'avoid'].includes(v)) p.preferences[k] = v;
      }
    }
    if (patch.addAlias !== undefined) {
      const a = normalizeQQ(patch.addAlias);
      if (!a || a === qq) throw Object.assign(new Error('addAlias 必须是另一个 QQ 号'), { statusCode: 400 });
      if (!p.aliases.includes(a)) p.aliases.push(a);
    }
    if (patch.removeAlias !== undefined) {
      p.aliases = p.aliases.filter((a) => a !== String(patch.removeAlias));
    }
    markDirty();
    return p;
  }

  /** 真删除：此人的全部记录（含各群名片、所有作用域的记忆）。 */
  function deletePerson(userId) {
    const qq = normalizeQQ(userId);
    if (!qq || !data().people[qq]) return false;
    delete data().people[qq];
    for (const p of Object.values(data().people)) {
      if (Array.isArray(p.aliases)) p.aliases = p.aliases.filter((a) => a !== qq);
    }
    data().legacyReview = (data().legacyReview || []).filter((r) => r.userId !== qq);
    markDirty();
    flush();
    return true;
  }

  /** 清掉某个群的全部群内记录（群名片、群内记忆），保留其他群与全局信息。 */
  function forgetGroup(groupId) {
    const gid = normalizeGroupId(groupId);
    if (!gid) return 0;
    let n = 0;
    for (const p of Object.values(data().people)) {
      if (p.groups[gid]) { delete p.groups[gid]; n += 1; }
      p.notes = p.notes.filter((x) => x.scope !== `group:${gid}`);
    }
    delete data().groups[gid];
    markDirty();
    flush();
    return n;
  }

  /**
   * 保留策略：删除超过 maxIdleMs 未出现、且没有任何记忆/管理员设定的 listed 记录。
   * 有记忆或被管理员设置过的人物不自动删除。
   */
  function pruneIdle(maxIdleMs) {
    if (!(maxIdleMs > 0)) return 0;
    const cutoff = now() - maxIdleMs;
    let n = 0;
    for (const [qq, p] of Object.entries(data().people)) {
      if ((Number(p.lastSeenAt) || 0) >= cutoff) continue;
      if (p.notes.length || p.preferredName || p.acquaintanceSetBy || p.aliases.length) continue;
      if (levelIndex(p.acquaintance) >= levelIndex('talked')) continue;
      delete data().people[qq];
      n += 1;
    }
    if (n) markDirty();
    return n;
  }

  /**
   * 迁移旧版二代记忆 memberImpressions（按名字、按会话存）。
   * 名字 → QQ 号只在**唯一**映射时导入（同一会话最近消息里该名字只对应一个 userId）；
   * 映射不上或有歧义的进入 legacyReview 待人工确认，**不猜**。
   * @param {string} convKey  group:<id> / private:<qq>
   * @param {Record<string,{traits?:string[]}>} impressions
   * @param {Array<{sender?:string,userId?:string|null}>} recentMessages
   */
  function importLegacyImpressions(convKey, impressions, recentMessages) {
    const scope = normalizeScope(convKey);
    if (!scope || !impressions || typeof impressions !== 'object') return { imported: 0, review: 0, skipped: true };
    const done = data().migrations.memberImpressions;
    if (done[scope]) return { imported: 0, review: 0, skipped: true };
    const nameToIds = new Map();
    for (const m of Array.isArray(recentMessages) ? recentMessages : []) {
      const qq = normalizeQQ(m?.userId);
      const name = cleanName(m?.sender);
      if (!qq || !name) continue;
      if (!nameToIds.has(name)) nameToIds.set(name, new Set());
      nameToIds.get(name).add(qq);
    }
    const privateQQ = scope.startsWith('private:') ? scope.slice(8) : null;
    let imported = 0;
    let review = 0;
    for (const [rawName, im] of Object.entries(impressions)) {
      if (['__proto__', 'constructor', 'prototype'].includes(rawName)) continue;
      const name = cleanName(rawName);
      const traits = Array.isArray(im?.traits) ? im.traits.map((t) => cleanName(t, NOTE_MAX_CHARS)).filter(Boolean) : [];
      let ids = nameToIds.get(name);
      if ((!ids || ids.size === 0) && privateQQ) ids = new Set([privateQQ]);
      if (!ids || ids.size !== 1) {
        data().legacyReview.push({ scope, name, traits, reason: !ids || ids.size === 0 ? '找不到对应 QQ 号' : `同名对应 ${ids.size} 个 QQ 号`, candidates: ids ? [...ids] : [], at: now() });
        review += 1;
        continue;
      }
      const [qq] = [...ids];
      for (const t of traits) {
        addNote(qq, { text: t, scope, source: 'witnessed', certainty: 'impression', origin: 'migration' });
        imported += 1;
      }
      if (!traits.length) ensurePerson(qq, now());
    }
    if (data().legacyReview.length > 500) data().legacyReview.splice(0, data().legacyReview.length - 500);
    done[scope] = now();
    markDirty();
    return { imported, review, skipped: false };
  }

  function stats() {
    const people = Object.values(data().people);
    return {
      people: people.length,
      groups: Object.keys(data().groups).length,
      notes: people.reduce((s, p) => s + p.notes.length, 0),
      pendingShare: people.reduce((s, p) => s + p.notes.filter((n) => n.shareStatus === 'pending').length, 0),
      legacyReview: (data().legacyReview || []).length,
    };
  }

  return {
    load: () => store.load(),
    flush,
    backup: (label) => store.backup(label),
    restore: (f) => store.restore(f),
    listBackups: () => store.listBackups(),
    observeMessage,
    observeJoin,
    observeLeave,
    observeCardChange,
    reconcileGroup,
    hasBaseline,
    getPerson,
    listPeople,
    findByName,
    addNote,
    editNote,
    reviewNote,
    deleteNote,
    updatePerson,
    deletePerson,
    forgetGroup,
    pruneIdle,
    importLegacyImpressions,
    stats,
    get loadReport() { return store.loadReport; },
    get data() { return data(); },
  };
}
