// 跨场景披露：群友在私聊里问「群里聊了什么」。
//
// 规则（方案 B，2026-10-25 放宽时间窗）：
//   1. 只在**私聊**里触发；群聊里问「群里聊了什么」没有意义；
//   2. 必须能确定**问的是哪个群**——文本里点名、或者提问者只在一个（机器人所在的）群里；
//      他在多个群里又没点名时，不披露，交给模型问清楚是哪个群；
//   3. 必须校验提问者**是该群成员**（用持久化成员表，见 group-members.js，实时刷新）；
//      退群/非成员一律拒绝——这是唯一的硬边界；
//   4. **不限制时间窗**：当前在群的成员可以看该群全部历史（新成员也包含入群前的，
//      群消息对群内公开，分享历史是接纳的一部分）。只按条数分页，免得撑爆 prompt；
//   5. 披露内容只有该群、只有 chat/note、只有 normal/personal（memd 侧再兜一次）；
//   6. 每次披露限流 + 留痕（memd 审计里带 group 与 requester_hash）。
//
// 这个模块只做纯逻辑 + 注入依赖，方便脱离 QQ 环境测试。

const GROUP_QUERY = /群(聊|里|内|上)?/;
const GROUP_META = /聊了|聊啥|聊什么|聊了些什么|发生了什么|有什么(有意思|好玩|新鲜|特别)|有啥(有意思|好玩|新鲜|特别)|说了什么|讨论了什么|在干嘛|聊的什么/;

/** 「群里聊了什么」这类元问题；命中返回 `{}`，否则 null。 */
export function detectDisclosureIntent(text) {
  const t = String(text ?? '');
  if (!t.trim()) return null;
  if (!GROUP_QUERY.test(t) || !GROUP_META.test(t)) return null;
  // 明确在问私聊里的事，就不算群披露。
  if (/私聊|我跟你|咱俩/.test(t) && !/群/.test(t)) return null;
  return {};
}

/**
 * 决定要披露哪个群。
 * @returns {{kind:'named'|'unique'|'ambiguous'|'none', groupId?:string, candidates?:string[]}}
 */
export function pickGroup({ text, candidates, memberOf }) {
  const t = String(text ?? '');
  const list = (candidates ?? []).map(String);
  const named = list.find((gid) => gid.length >= 5 && t.includes(gid));
  if (named) return { kind: 'named', groupId: named };
  const mine = (memberOf ?? []).map(String).filter((gid) => list.includes(gid));
  if (mine.length === 1) return { kind: 'unique', groupId: mine[0] };
  if (mine.length > 1) return { kind: 'ambiguous', candidates: mine };
  return { kind: 'none' };
}

/** 把 memd 返回的群消息拼成一段可塞进 prompt 的块。 */
export function formatDisclosureBlock({ groupId, items }) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) {
    return `【群消息披露】群 ${groupId} 还没有可披露的消息。`;
  }
  const lines = list
    .slice(0, 20)
    .map((item) => {
      const when = item.updated_at ? new Date(item.updated_at) : null;
      const stamp = when && !Number.isNaN(when.getTime())
        ? `${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
        : '';
      const body = String(item?.render?.text ?? item?.text ?? '').replace(/\s+/g, ' ').slice(0, 300);
      return `- ${stamp} ${body}`.trim();
    });
  return [
    `【群消息披露】群 ${groupId} 的历史消息（提问者已通过成员校验）：`,
    ...lines,
    '披露范围：仅本群、仅普通/个人记忆；敏感记忆与其它群、私聊永不包含。回答时不要编造未列出的内容。',
  ].join('\n');
}

/**
 * 披露编排。依赖全部注入，便于测试：
 *   store             group-members 的持久化成员表
 *   fetchMemberIds    群号 -> 成员 QQ 数组（桥接里是 bot.getGroupMemberList）
 *   fetchDisclose     群号 -> memd 的消息数组（不限时间）
 *   logger
 */
export function createDisclosureService({
  store,
  fetchMemberIds,
  fetchDisclose,
  logger = console,
  cooldownMs = 60_000,
  now = Date.now,
} = {}) {
  const lastAt = new Map(); // senderQQ -> ts

  /**
   * @returns {Promise<{block: string, reason: string, groupId?: string}>}
   *   block 为空串表示「不披露」，reason 说明原因（写日志用）。
   */
  async function run({ text, senderQQ, candidates }) {
    const intent = detectDisclosureIntent(text);
    if (!intent) return { block: '', reason: 'no-intent' };
    const sender = String(senderQQ ?? '').trim();
    if (!/^\d{4,20}$/.test(sender)) return { block: '', reason: 'no-sender' };
    if (now() - (lastAt.get(sender) ?? 0) < cooldownMs) return { block: '', reason: 'cooldown' };
    const list = (candidates ?? []).map(String).filter(Boolean);
    if (list.length === 0) return { block: '', reason: 'no-candidates' };

    // 先看是否点名；没点名就要先知道他到底在哪些群里，才谈得上「唯一」。
    const named = pickGroup({ text, candidates: list, memberOf: [] });
    let groupId;
    let memberOf = [];
    if (named.kind === 'named') {
      groupId = named.groupId;
    } else {
      for (const gid of list) {
        const verdict = await store.verifyMember(gid, sender, fetchMemberIds);
        if (verdict.member) memberOf.push(gid);
      }
      const picked = pickGroup({ text, candidates: list, memberOf });
      if (picked.kind === 'ambiguous') {
        return {
          block: '',
          reason: 'ambiguous',
          candidates: picked.candidates,
        };
      }
      if (picked.kind === 'none') return { block: '', reason: 'not-a-member' };
      groupId = picked.groupId;
    }

    const verdict = await store.verifyMember(groupId, sender, fetchMemberIds);
    if (!verdict.member) {
      return { block: '', reason: verdict.reason ?? 'not-a-member', groupId };
    }

    let items = [];
    try {
      items = await fetchDisclose(groupId);
    } catch (error) {
      return { block: '', reason: `disclose-failed: ${error?.message ?? error}`, groupId };
    }
    lastAt.set(sender, now());
    logger?.info?.(`[disclose] group=${groupId} requester=${sender.slice(-4)} items=${items.length}`);
    return { block: formatDisclosureBlock({ groupId, items }), reason: 'ok', groupId };
  }

  return { run, detectDisclosureIntent };
}
