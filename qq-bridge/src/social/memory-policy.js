// 人物记忆的共享策略与注入过滤 —— **可见范围由程序在注入时执行，不交给模型自觉**。
//
// 三档共享策略（continuity.sharePolicy，默认 identity）：
//   none      —— 不共享：在某个群里只看得到「本群」记录，连「在别的群见过 TA」都不说。
//   identity  —— 仅共享基础身份（默认）：额外知道「这是同一个 QQ 号」、在几个别的群见过、
//                管理员设定的跨群称呼、认识程度。**不**带任何别处的记忆内容。
//   shared    —— 共享经授权的全局印象：再加上 visibility=public 的记忆
//                （global 作用域，或群内记忆经管理员批准共享的条目）。
//
// 无论哪一档，**私聊来源的记忆（private:<QQ>）只在与这个人本人的私聊里可见**，
// 绝不出现在任何群会话或其他人的私聊里。
//
// 群级覆盖：continuity.groups[<群号>].sharePolicy 可以把某个群调得更严（例如工作群设为 none）。
// 两个群之间实际生效的策略取两边较严的那一档（none < identity < shared）。
//
// 冲突处理（同一个人，全局记录与本群记录不一致时）：
//   1. 称呼：本群群名片 > 管理员设定的跨群称呼 > QQ 昵称。展示时同时给出，并标注来源。
//   2. 记忆：本群记录排在前面并标注「本群」；全局/共享记录标注「跨群共享」。
//      模型被明确告知「以本群记录为准」。
//   3. 置顶（pinned，含纠正过的条目）优先于普通印象；explicit（对方明确说过）优先于 impression。
//   4. 文字完全相同的条目只保留一条（优先保留本群的）。

const POLICY_ORDER = ['none', 'identity', 'shared'];

export function normalizePolicy(value, fallback = 'identity') {
  const v = String(value ?? '').trim();
  return POLICY_ORDER.includes(v) ? v : fallback;
}

function stricter(a, b) {
  return POLICY_ORDER[Math.min(POLICY_ORDER.indexOf(a), POLICY_ORDER.indexOf(b))];
}

/** 读取某个群的策略配置（含默认值）。 */
export function groupPolicy(continuityCfg = {}, groupId) {
  const base = normalizePolicy(continuityCfg.sharePolicy, 'identity');
  const g = continuityCfg.groups?.[String(groupId)] ?? {};
  return {
    sharePolicy: g.sharePolicy ? stricter(base, normalizePolicy(g.sharePolicy, base)) : base,
    // recordable=false：这个群不写人物库（只做本轮处理），也不被别的群看见。
    recordable: g.recordable !== false,
    label: typeof g.label === 'string' ? g.label.trim().slice(0, 20) : '',
  };
}

/** 当前会话与另一个群之间生效的共享策略。 */
export function effectivePolicyBetween(continuityCfg, convKey, otherGroupId) {
  const base = normalizePolicy(continuityCfg?.sharePolicy, 'identity');
  const m = /^(group|private):(\d+)$/.exec(String(convKey));
  const here = m && m[1] === 'group' ? groupPolicy(continuityCfg, m[2]).sharePolicy : base;
  const there = groupPolicy(continuityCfg, otherGroupId);
  if (!there.recordable) return 'none';
  return stricter(here, there.sharePolicy);
}

const PRIORITY = (n, here) => (n.scope === here ? 0 : 1) * 10 + (n.pinned ? 0 : 2) + (n.certainty === 'explicit' ? 0 : 1);

/**
 * 计算某条记忆在某个会话里是否可见。这是唯一的判定函数，所有注入路径都必须走这里。
 * @param {object} note
 * @param {string} convKey   group:<id> / private:<qq>
 * @param {string} personQQ  记忆所属的人
 * @param {'none'|'identity'|'shared'} policy  当前会话的基础策略
 */
export function noteVisibleIn(note, convKey, personQQ, policy) {
  if (!note || typeof note !== 'object') return false;
  const scope = String(note.scope ?? '');
  const vis = String(note.visibility ?? scope);
  // 1) 私聊来源：只在与本人的私聊里可见（即使被错误标成 public 也不放行）。
  if (scope.startsWith('private:')) return convKey === `private:${personQQ}` && scope === convKey;
  // 2) 本会话自己的记录永远可见。
  if (scope === convKey) return true;
  // 3) 其余只有 shared 策略 + visibility=public + 已批准 才可见。
  if (policy !== 'shared') return false;
  if (vis !== 'public') return false;
  if (note.shareStatus !== 'approved') return false;
  return true;
}

/**
 * 生成「当前会话可见的人物视图」。返回结构化对象（给工具）和一段文本（给唤醒提示词）。
 * person 为 people.js 的记录；返回 null 表示不应注入任何内容。
 */
export function buildPersonView(person, convKey, continuityCfg = {}, { maxNotes = 6, now = Date.now() } = {}) {
  if (!person) return null;
  const m = /^(group|private):(\d+)$/.exec(String(convKey));
  if (!m) return null;
  const kind = m[1];
  const hereId = m[2];
  const basePolicy = kind === 'group' ? groupPolicy(continuityCfg, hereId).sharePolicy : normalizePolicy(continuityCfg.sharePolicy, 'identity');
  const hereGroup = kind === 'group' ? person.groups?.[hereId] ?? null : null;

  // 其他群：按两两生效策略过滤；none 档完全不提，recordable=false 的群不出现。
  const others = [];
  for (const [gid, g] of Object.entries(person.groups ?? {})) {
    if (kind === 'group' && gid === hereId) continue;
    const pol = effectivePolicyBetween(continuityCfg, convKey, gid);
    if (pol === 'none') continue;
    const label = groupPolicy(continuityCfg, gid).label;
    others.push({ label: label || null, status: g.status, policy: pol });
  }
  const anyShared = others.some((o) => o.policy === 'shared');
  const view = {
    userId: person.qq,
    sharePolicy: basePolicy,
    acquaintance: basePolicy === 'none' && kind === 'group' && !hereGroup ? 'listed' : person.acquaintance,
    names: {
      currentCard: hereGroup?.card || null,
      nickname: person.nickname || null,
      preferredName: basePolicy !== 'none' ? (person.preferredName?.value ?? null) : null,
    },
    here: hereGroup ? {
      status: hereGroup.status,
      joinedAt: hereGroup.joinedAt ?? null,
      firstSeenAt: hereGroup.firstSeenAt ?? null,
      messageCount: Number(hereGroup.messageCount) || 0,
      cardHistory: (hereGroup.cardHistory ?? []).slice(-3).map((h) => h.value),
    } : null,
    seenInOtherGroups: basePolicy === 'none' ? 0 : others.length,
    otherGroupLabels: basePolicy === 'none' ? [] : others.filter((o) => o.label).map((o) => o.label),
    knownPrivately: kind === 'private' ? !!person.private : false,
    preferences: basePolicy !== 'none' ? { ...(person.preferences ?? {}) } : {},
    notes: [],
  };
  // 本人私聊时允许看到本人的群内信息吗？不：私聊里只看私聊记录 + 共享策略允许的 public 记录。
  const policyForNotes = kind === 'group' ? (anyShared || basePolicy === 'shared' ? 'shared' : basePolicy) : basePolicy;
  const seen = new Set();
  const visible = (person.notes ?? [])
    .filter((n) => noteVisibleIn(n, convKey, person.qq, policyForNotes))
    // 来自 recordable=false / none 群的记录，即使被批准过也不外流。
    .filter((n) => {
      if (n.scope === convKey || !n.scope.startsWith('group:')) return true;
      return effectivePolicyBetween(continuityCfg, convKey, n.scope.slice(6)) === 'shared';
    })
    .sort((a, b) => PRIORITY(a, convKey) - PRIORITY(b, convKey) || (b.updatedAt - a.updatedAt))
    .filter((n) => (seen.has(n.text) ? false : (seen.add(n.text), true)))
    .slice(0, Math.max(0, maxNotes));
  view.notes = visible.map((n) => ({
    id: n.id,
    text: n.text,
    where: n.scope === convKey ? (kind === 'group' ? '本群' : '私聊') : '跨群共享',
    source: n.source,
    certainty: n.certainty,
    pinned: !!n.pinned,
    reportedBy: n.reportedBy ?? null,
  }));
  view.text = renderPersonLine(view, now);
  return view;
}

const ACQ_TEXT = { listed: '只在成员名单里见过', observed: '看过 TA 说话', talked: '直接聊过', familiar: '熟悉' };
const PREF_TEXT = { teasing: '开玩笑', proactiveChat: '被主动搭话', poke: '拍一拍', recallPast: '提起旧事' };

function renderPersonLine(view, now) {
  const bits = [];
  const name = view.names.currentCard || view.names.preferredName || view.names.nickname || '（无名）';
  bits.push(`${name}（QQ ${view.userId}）`);
  if (view.names.preferredName && view.names.preferredName !== name) bits.push(`称呼「${view.names.preferredName}」`);
  bits.push(ACQ_TEXT[view.acquaintance] ?? view.acquaintance);
  if (view.here?.cardHistory?.length > 1) bits.push(`本群曾用名 ${view.here.cardHistory.slice(0, -1).join('/')}`);
  if (view.seenInOtherGroups > 0) {
    bits.push(view.otherGroupLabels.length ? `也在「${view.otherGroupLabels.join('」「')}」见过` : `在另外 ${view.seenInOtherGroups} 个群见过`);
  }
  const avoid = Object.entries(view.preferences).filter(([, v]) => v === 'avoid').map(([k]) => PREF_TEXT[k] ?? k);
  if (avoid.length) bits.push(`不喜欢：${avoid.join('、')}`);
  const notes = view.notes.map((n) => `${n.text}${n.where === '本群' || n.where === '私聊' ? '' : '〔跨群〕'}${n.source === 'hearsay' ? '〔转述〕' : ''}`);
  return `- ${bits.join('；')}${notes.length ? `｜记得：${notes.join('；')}` : ''}`;
}

/**
 * 给唤醒提示词拼「在场人物」小节：只含本轮消息里出现的发言者（按需注入），有字数上限。
 * @param {Array<object>} persons people 记录
 */
export function renderPeopleBlock(persons, convKey, continuityCfg = {}, { maxPeople = 8, maxChars = 1500, now = Date.now() } = {}) {
  const lines = [];
  let total = 0;
  for (const p of persons.slice(0, maxPeople)) {
    const v = buildPersonView(p, convKey, continuityCfg, { now });
    if (!v) continue;
    if (total + v.text.length > maxChars) break;
    lines.push(v.text);
    total += v.text.length;
  }
  if (!lines.length) return '';
  return `【在场人物】（以 QQ 号认人：同名不同号是不同的人；本群记录为准，〔跨群〕条目只在别处公开说过，提起前先看场合）\n${lines.join('\n')}`;
}
