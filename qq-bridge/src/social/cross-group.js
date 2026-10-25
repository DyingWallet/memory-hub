// 受控的跨群信息协作：一个群里的 AI 只能通过这里查询**另一个已授权群**的有限信息。
//
// 原则：
//   · 默认关闭（crossGroup.enabled=false），且链接是**有向**的：A→B 授权不代表 B→A。
//   · 只有显式列出的能力可用，能力只返回统计/成员关系，**永远不返回聊天内容、发言者名字或记忆**。
//     - presence：某个 QQ 号是否是目标群成员（只对人物库里认识的人回答；目标群 recordable=false 时拒绝）
//     - activity：目标群最近 1 小时 / 24 小时的消息条数、活跃人数、最后一条消息距今多久
//   · 两端都必须在白名单 allow.groups 内；私聊会话不能发起跨群查询（owner 用管理通道）。
//   · 跨群**发送**不在这里：二代会话令牌只对自己所在会话有效（/api/send/* 用目标 key 校验令牌），
//     AI 天然无法往别的群发消息；owner 代发走管理通道的 /say 命令。
//   · 每次查询都写审计日志（调用方负责）。

export const CROSS_GROUP_CAPABILITIES = ['presence', 'activity'];

function str(v) { return String(v ?? '').trim(); }

/**
 * 判断 fromKey 所在会话能否对 toGroupId 使用 capability。
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
export function checkCrossGroup(cfg, fromKey, toGroupId, capability) {
  const cg = cfg?.crossGroup ?? {};
  if (cg.enabled !== true) return { ok: false, reason: '跨群协作未启用（crossGroup.enabled=false）' };
  if (!CROSS_GROUP_CAPABILITIES.includes(capability)) return { ok: false, reason: `未知能力：${capability}` };
  const m = /^group:(\d+)$/.exec(str(fromKey));
  if (!m) return { ok: false, reason: '只有群会话可以发起跨群查询' };
  const from = m[1];
  const to = str(toGroupId);
  if (!/^\d+$/.test(to)) return { ok: false, reason: '目标群号无效' };
  if (from === to) return { ok: false, reason: '目标群就是当前群' };
  const groups = (cfg?.allow?.groups ?? []).map(String);
  if (!groups.includes(from) || !groups.includes(to)) return { ok: false, reason: '两端群都必须在白名单 allow.groups 内' };
  if (cfg?.continuity?.groups?.[to]?.recordable === false) return { ok: false, reason: '目标群不允许被记录/查询' };
  const links = Array.isArray(cg.links) ? cg.links : [];
  const link = links.find((l) => str(l?.from) === from && str(l?.to) === to);
  if (!link) return { ok: false, reason: `没有从群 ${from} 到群 ${to} 的授权链接` };
  const allow = Array.isArray(link.allow) ? link.allow.map(String) : [];
  if (!allow.includes(capability)) return { ok: false, reason: `链接未授权能力 ${capability}` };
  return { ok: true };
}

/** presence：只回答「是否成员」，不回答名片/记忆。人物库不认识的人一律 unknown。 */
export function queryPresence(people, toGroupId, userId) {
  const p = people.getPerson(userId);
  if (!p) return { known: false, member: 'unknown' };
  const g = p.groups?.[str(toGroupId)];
  if (!g) return { known: true, member: 'unknown' };
  return { known: true, member: g.status === 'member' ? 'yes' : 'no' };
}

/** activity：统计目标群二代消息流，不返回任何文本或名字。 */
export function queryActivity(targetState, now = Date.now()) {
  const msgs = Array.isArray(targetState?.recentMessages) ? targetState.recentMessages.filter((m) => m && !m.isSelf) : [];
  const hour = msgs.filter((m) => now - (Number(m.time) || 0) < 3600_000);
  const day = msgs.filter((m) => now - (Number(m.time) || 0) < 86_400_000);
  const last = msgs.reduce((t, m) => Math.max(t, Number(m.time) || 0), 0);
  return {
    messagesLastHour: hour.length,
    messagesLast24h: day.length,
    activeSpeakersLastHour: new Set(hour.map((m) => m.userId || m.sender)).size,
    minutesSinceLastMessage: last ? Math.round((now - last) / 60000) : null,
    note: '统计仅基于桥接最近缓存的消息（最多 recentLimit 条），不是完整历史',
  };
}
