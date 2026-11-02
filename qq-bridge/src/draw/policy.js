// 出图权限判定（纯函数，无 IO，便于单测）
//
// 两层：
//   语义层（agent）决定 character —— 谁在画里
//   硬规则层（这里）只管 character + nsfw + 场景，不解析任何文本
//
// 矩阵：
//                群聊   他人私聊   主人私聊
//   汐 · SFW      ✅      ✅        ✅
//   汐 · NSFW     ❌      ❌        ✅
//   其他 · SFW    ✅      ✅        ✅
//   其他 · NSFW   ✅      ✅        ✅

export const SCENES = {
  GROUP: 'group',
  PRIVATE_OTHER: 'private_other',
  PRIVATE_OWNER: 'private_owner',
};

/** 从会话 key 推出场景。 */
export function sceneOf(key, ownerQQ) {
  if (!key || typeof key !== 'string') return null;
  const [kind, id] = key.split(':');
  if (kind === 'group' && id) return SCENES.GROUP;
  if (kind === 'private' && id) return String(id) === String(ownerQQ) ? SCENES.PRIVATE_OWNER : SCENES.PRIVATE_OTHER;
  return null;
}

/**
 * 判定是否允许出图。
 * @returns {{ok:true} | {ok:false, code:string, tone?:string}}
 */
export function checkDrawPolicy({ scene, character, nsfw }) {
  if (!scene) return { ok: false, code: 'bad_scene' };
  const isXixi = character === 'xixi';
  if (!isXixi && character !== 'generic') return { ok: false, code: 'bad_character' };

  if (isXixi && nsfw && scene !== SCENES.PRIVATE_OWNER) {
    // 拒绝要走人格，不是报错
    return { ok: false, code: 'refuse_xixi_nsfw', tone: 'shy_angry_tsun' };
  }
  return { ok: true };
}

/**
 * 配额档位：不同预设不同额度。
 * owner 用软上限，其余按每人+每群双重限。
 *
 * isOwner 优先于 scene：主人在群里要图时 scene 是 group，会掉进 generic_nsfw 的
 * 3 张/日，被自己的额度卡住。他要的是「我的限制」——所以按身份给 owner 档，
 * 100 张/日 + 30 秒冷却，群额度也不设上限。
 */
export function quotaTierOf({ scene, nsfw, isOwner = false }) {
  if (isOwner || scene === SCENES.PRIVATE_OWNER) return 'owner';
  if (nsfw) return 'generic_nsfw';
  return 'normal';
}

export const QUOTA_TABLE = {
  owner: { perUserDaily: 100, cooldownMs: 30_000, perGroupDaily: Infinity },
  normal: { perUserDaily: 15, cooldownMs: 10 * 60_000, perGroupDaily: 60 },
  generic_nsfw: { perUserDaily: 3, cooldownMs: 30 * 60_000, perGroupDaily: 10 },
};
