// 群成员事件：把 SnowLuma 推送的 OneBot v11 notice 规整成内部事件，更新人物库，
// 并生成给二代会话的「事件提示」。
//
// 载荷形状（已对照 SnowLuma 1.14.22 源码 packages/onebot/src/event-converter/to-notice.ts 核实）：
//   group_increase  { group_id, user_id, operator_id, sub_type: approve|invite, time, self_id }
//   group_decrease  { group_id, user_id, operator_id, sub_type: leave|kick|kick_me|disband }
//   group_card      { group_id, user_id, card_new, card_old }   ← SnowLuma 由「下一条消息的名片变化」派生，
//                                                                 不是 QQ 实时推送；冷缓存时不会发
//   group_recall    { group_id, user_id, operator_id, message_id }
// ID 全部是 number；无法解析的 UID 会变成 0（这里一律丢弃）。
// SnowLuma 不重放离线期间的事件，断线期间的入群/退群会**丢失** —— 由 reconcileGroup 的
// 成员名单对账兜底（只记录，不唤醒）。
// 同一事件可能重复投递（部分推送 seq=0 时 SnowLuma 的去重会放行）—— 由 people.js 的指纹 +
// 逻辑去重处理。

import { normalizeGroupId, normalizeQQ, cleanDisplayName } from './people.js';

/** 规整一条 notice；不是我们关心的类型返回 null。 */
export function normalizeMemberNotice(event) {
  if (!event || event.post_type !== 'notice') return null;
  const type = String(event.notice_type ?? '');
  const groupId = normalizeGroupId(event.group_id);
  const userId = normalizeQQ(event.user_id);
  const base = {
    groupId,
    userId,
    operatorId: normalizeQQ(event.operator_id),
    subType: String(event.sub_type ?? ''),
    time: Number.isFinite(Number(event.time)) ? Number(event.time) : null,
    selfId: event.self_id != null ? String(event.self_id) : null,
  };
  if (!groupId || !userId) return null;
  if (type === 'group_increase') return { kind: 'join', ...base };
  if (type === 'group_decrease') return { kind: 'leave', ...base };
  if (type === 'group_card') return { kind: 'card', ...base, cardNew: String(event.card_new ?? ''), cardOld: String(event.card_old ?? '') };
  if (type === 'group_recall') return { kind: 'recall', ...base, messageId: event.message_id != null ? String(event.message_id) : null };
  return null;
}

const CATEGORY_TEXT = {
  stranger: '第一次见到的人',
  knownElsewhere: '在别处认识的人',
  returning: '以前在本群、退群后又回来的人',
  alreadyMember: '记录里本来就在本群的人',
};

/**
 * 处理一条已规整的成员事件。
 * @param {object} ev       normalizeMemberNotice 的结果
 * @param {object} deps
 * @param {object} deps.people          people.js 实例
 * @param {object} deps.continuity      config.continuity
 * @param {(groupId:string)=>boolean} deps.groupAllowed   群是否在白名单内
 * @param {(groupId:string,userId:string)=>Promise<{card?:string,nickname?:string}|null>} [deps.fetchMember]
 * @param {(m:string)=>void} [deps.log]
 * @returns {Promise<{handled:boolean, wake:boolean, wakeReason?:string, streamText?:string, result?:object}>}
 */
export async function processMemberEvent(ev, { people, continuity = {}, groupAllowed, fetchMember = null, log = () => {} }) {
  if (!ev) return { handled: false, wake: false };
  if (!groupAllowed(ev.groupId)) return { handled: false, wake: false };
  // 自己进群/被踢：不当成「有人入群」，只记一笔。
  if (ev.selfId && ev.userId === ev.selfId) {
    log(`群 ${ev.groupId} 的成员事件涉及机器人自身（${ev.kind}/${ev.subType}），只记录不唤醒`);
    return { handled: true, wake: false };
  }
  const recordable = continuity.groups?.[ev.groupId]?.recordable !== false;
  const joinCfg = continuity.joinEvents ?? {};
  if (ev.kind === 'join') {
    let info = null;
    if (fetchMember) {
      try {
        info = await fetchMember(ev.groupId, ev.userId);
        // 名片/昵称来自群友：清理换行与控制字符后才能进事件文本（防止伪造「系统」行）。
        if (info) info = { card: cleanDisplayName(info.card), nickname: cleanDisplayName(info.nickname) };
      } catch (error) { log(`查询新成员资料失败（${ev.groupId}/${ev.userId}）：${error?.message ?? error}；按无名片处理`); }
    }
    if (!recordable) {
      return { handled: true, wake: joinCfg.wake !== false, wakeReason: 'memberJoin', streamText: `[入群] QQ ${ev.userId}${info?.card || info?.nickname ? `（${info.card || info.nickname}）` : ''} 加入了本群` };
    }
    const r = people.observeJoin({ groupId: ev.groupId, userId: ev.userId, card: info?.card ?? '', nickname: info?.nickname ?? '', time: ev.time, subType: ev.subType, operatorId: ev.operatorId });
    if (!r || r.category === 'duplicate') return { handled: true, wake: false, result: r };
    const name = info?.card || info?.nickname || '';
    const how = ev.subType === 'invite' && ev.operatorId ? `（由 QQ ${ev.operatorId} 邀请）` : '';
    const streamText = `[入群] ${name ? `${name}（QQ ${ev.userId}）` : `QQ ${ev.userId}`} 加入了本群${how}：${CATEGORY_TEXT[r.category] ?? r.category}`;
    const wakeOn = Array.isArray(joinCfg.wakeOn) ? joinCfg.wakeOn : ['stranger', 'knownElsewhere', 'returning'];
    return { handled: true, wake: joinCfg.wake !== false && wakeOn.includes(r.category), wakeReason: `memberJoin:${r.category}`, streamText, result: r };
  }
  if (ev.kind === 'leave') {
    if (!recordable) return { handled: true, wake: false };
    const r = people.observeLeave({ groupId: ev.groupId, userId: ev.userId, time: ev.time, subType: ev.subType, operatorId: ev.operatorId });
    if (!r || r.category === 'duplicate') return { handled: true, wake: false, result: r };
    const how = ev.subType === 'kick' ? '被移出了本群' : ev.subType === 'disband' ? '（群已解散）' : '退出了本群';
    const streamText = `[退群] ${r.card ? `${r.card}（QQ ${ev.userId}）` : `QQ ${ev.userId}`} ${how}`;
    // 退群默认只记录、不唤醒（不追问原因）；可配置 continuity.leaveEvents.wake=true。
    return { handled: true, wake: continuity.leaveEvents?.wake === true, wakeReason: 'memberLeave', streamText, result: r };
  }
  if (ev.kind === 'card') {
    if (!recordable) return { handled: true, wake: false };
    const r = people.observeCardChange({ groupId: ev.groupId, userId: ev.userId, cardNew: ev.cardNew, cardOld: ev.cardOld });
    if (!r) return { handled: true, wake: false };
    return { handled: true, wake: false, streamText: `[改名片] QQ ${ev.userId}：${r.from || '（空）'} → ${r.to || '（空）'}`, result: r };
  }
  if (ev.kind === 'recall') {
    // 撤回：只记录，默认不回应、不复述（不把被撤回的内容写进任何地方）。
    return { handled: true, wake: false };
  }
  return { handled: false, wake: false };
}

/** 给唤醒提示词用的入群说明（只描述行为规则，具体人物资料由在场人物小节提供）。 */
export function joinWakeInstruction(category) {
  const common = '不需要每次都欢迎；看群里此刻在聊什么、你的人设和与对方的熟悉程度，自然决定要不要开口。不要复述别的群里的聊天内容，〔跨群〕记录也只在合适时轻轻带过。';
  if (category === 'knownElsewhere') return `一位你在别处认识的人加入了本群。你可以认出 TA、用已知的称呼打个招呼，也可以先不点破；${common}`;
  if (category === 'returning') return `一位以前在本群的人回来了。可以说句「回来啦」之类的，但不要追问 TA 为什么离开；${common}`;
  if (category === 'stranger') return `一位新朋友加入了本群，你之前不认识 TA。可以像普通群友那样简单打个招呼或先观察；${common}`;
  return common;
}
