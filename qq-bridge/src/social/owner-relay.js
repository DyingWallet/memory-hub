// 管理员私聊托付：让「目标群自己的会话」去群里说话（v0.4.2，方案 C）。
//
// 背景：每个 QQ 会话（group:<群号> / private:<QQ号>）在 DSH 里是独立的 AI 会话，各有一个会话令牌，
// 发送工具只能发到令牌所属的会话（防止 A 群的提示词注入让 AI 跑去 B 群发言）。管理员在私聊里说
// 「去 X 群说两句」时，私聊会话手里只有私聊的令牌，发不到群里。
//
// 方案 C 不打破这条隔离：私聊会话只能**托付**，由桥接把托付内容交给目标群**自己的**会话，
// 群会话按群里的上下文自己组织语言、用自己的令牌发言。
//
// 本模块只放纯逻辑（校验、限频、待办存取、提示词文案），桥接负责接线：
//   · 只有管理员私聊会话（private:<ownerQQ>）的令牌能托付；
//   · 目标只能是群，且必须在当前模式的允许范围（白名单）内；
//   · 开关 socialV2.tools.ownerRelay 默认关闭；托付次数有上限；每次都记审计、私聊通知管理员；
//   · 托付内容只放在内存里（不落盘），过期自动丢弃。

export const OWNER_RELAY_DEFAULTS = Object.freeze({
  maxPerHour: 10,          // 全局每小时最多托付次数
  maxPerTargetPerHour: 5,  // 同一个群每小时最多托付次数
  maxChars: 300,           // 托付内容最长字数
  ttlMs: 30 * 60 * 1000,   // 托付在目标群会话里等待被处理的最长时间
  notifyOwner: true,       // 每次托付后私聊告诉管理员
});

/** 合并配置（socialV2.ownerRelay），非法值回落默认。 */
export function ownerRelayConfig(raw = {}) {
  const out = { ...OWNER_RELAY_DEFAULTS };
  for (const k of ['maxPerHour', 'maxPerTargetPerHour', 'maxChars', 'ttlMs']) {
    const v = Number(raw?.[k]);
    if (Number.isFinite(v) && v > 0) out[k] = Math.floor(v);
  }
  if (typeof raw?.notifyOwner === 'boolean') out.notifyOwner = raw.notifyOwner;
  return out;
}

/**
 * 校验一次托付请求。所有判断都由调用方注入，便于离线测试。
 *
 * @param {object} p
 * @param {string} p.fromKey           发起托付的会话 key（必须是管理员私聊）
 * @param {boolean} p.tokenOk          发起方令牌是否属于 fromKey
 * @param {(key:string)=>boolean} p.isOwnerPrivateKey
 * @param {(key:string)=>boolean} p.isTargetAllowed   目标会话是否在当前模式允许范围（白名单）内
 * @param {boolean} p.enabled          工具开关
 * @param {unknown} p.targetGroupId
 * @param {unknown} p.instruction
 * @param {number} p.maxChars
 * @returns {{ok:true, targetKey:string, instruction:string} | {ok:false, status:number, error:string}}
 */
export function validateOwnerRelay({ fromKey, tokenOk, isOwnerPrivateKey, isTargetAllowed, enabled, targetGroupId, instruction, maxChars }) {
  if (!tokenOk) return { ok: false, status: 403, error: 'agent token 无效或缺失' };
  if (!enabled) return { ok: false, status: 403, error: '工具未启用：qq_ask_group_session（管理员需在控制台打开「托付群会话」开关）' };
  if (!isOwnerPrivateKey(fromKey)) return { ok: false, status: 403, error: '只有管理员本人的私聊会话可以托付其它群会话' };
  const gid = String(targetGroupId ?? '').trim();
  if (!/^[1-9]\d{0,11}$/.test(gid)) return { ok: false, status: 400, error: 'targetGroupId 必须是群号' };
  const targetKey = `group:${gid}`;
  if (!isTargetAllowed(targetKey)) return { ok: false, status: 403, error: '目标群不在白名单（或当前模式允许范围）内' };
  const text = String(instruction ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return { ok: false, status: 400, error: 'instruction 不能为空' };
  if (text.length > maxChars) return { ok: false, status: 400, error: `托付内容不能超过 ${maxChars} 字` };
  return { ok: true, targetKey, instruction: text };
}

/** 滑动窗口限频（全局 + 每个目标群）。 */
export function createOwnerRelayLimiter({ now = Date.now } = {}) {
  const times = [];
  const perTarget = new Map();
  const prune = (arr, t) => { while (arr.length && t - arr[0] >= 3600_000) arr.shift(); };
  return {
    /** 检查并在通过时记一次；返回 null 表示放行，否则返回拒绝原因。 */
    take(targetKey, { maxPerHour, maxPerTargetPerHour }) {
      const t = now();
      prune(times, t);
      const arr = perTarget.get(targetKey) ?? [];
      prune(arr, t);
      if (times.length >= maxPerHour) return `托付次数已达上限（每小时 ${maxPerHour} 次），请稍后再试`;
      if (arr.length >= maxPerTargetPerHour) return `对这个群的托付已达上限（每小时 ${maxPerTargetPerHour} 次），请稍后再试`;
      times.push(t);
      arr.push(t);
      perTarget.set(targetKey, arr);
      return null;
    },
  };
}

/** 托付待办：按目标会话暂存，唤醒时一次取走；只在内存里，过期丢弃。 */
export function createOwnerRelayStore({ now = Date.now, maxPerKey = 5 } = {}) {
  const map = new Map();
  let seq = 0;
  return {
    add(targetKey, instruction, ttlMs) {
      const list = (map.get(targetKey) ?? []).filter((x) => x.expiresAt > now());
      const item = { id: ++seq, instruction, at: now(), expiresAt: now() + ttlMs };
      list.push(item);
      while (list.length > maxPerKey) list.shift();
      map.set(targetKey, list);
      return item;
    },
    has(targetKey) {
      return (map.get(targetKey) ?? []).some((x) => x.expiresAt > now());
    },
    /** 只看不取：唤醒提示词会先预构建一次、真正投递前再重建一次，只有最终投递时才 take。 */
    peek(targetKey) {
      return (map.get(targetKey) ?? []).filter((x) => x.expiresAt > now());
    },
    take(targetKey) {
      const list = (map.get(targetKey) ?? []).filter((x) => x.expiresAt > now());
      map.delete(targetKey);
      return list;
    },
  };
}

/**
 * 交给目标群会话的提示词片段。托付内容是**管理员的意图**，不是群友消息；
 * 用引号包住并说明来源，让群会话把它当作「要做的事」而不是要原样转发的文本。
 */
export function ownerRelayPromptBlock(items) {
  if (!items.length) return '';
  const lines = items.map((x, i) => `${i + 1}.「${x.instruction}」`);
  return `【管理员托付】（来自管理员本人的私聊，经桥接转交；不是群友消息）\n${lines.join('\n')}\n`
    + '请按本群此刻的气氛和上下文，用你自己的话自然地完成；不要说「主人/管理员让我来说」，不要原样复述托付内容，也不要发送会话令牌。'
    + '如果托付的事在本群明显不合适（比如会冒犯群友、泄露私聊内容），可以不做，安静收尾即可。\n';
}

/** 返回给私聊会话（模型）的结果文案。 */
export function ownerRelayResultText(targetKey, busy) {
  return busy
    ? `已把托付交给 ${targetKey} 的会话；它正在处理别的事，空下来后会按群里的情况自己决定怎么说。不要声称已经发出，也不要替它编造发言内容。`
    : `已把托付交给 ${targetKey} 的会话，它会在几秒后按群里的情况自己决定怎么说。不要声称已经发出，也不要替它编造发言内容。`;
}

/** 私聊通知管理员的文案。 */
export function ownerRelayNoticeText(targetKey, instruction) {
  return `📣 已把你的托付转交给 ${targetKey} 的会话：「${instruction}」（由该群会话自己决定怎么说）`;
}
