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
 * 额度里被卡住。他要的是「我的限制」——所以按身份给 owner 档。
 *
 * 2026-11-04：三档统一成 owner 档（100 张/日 + 冷却、群额度不限）。此前 normal
 * 是 15 张/10 分钟、generic_nsfw 是 3 张/30 分钟。同日晚些时候冷却从 30 秒调到
 * 1 分钟。保留档位结构，以后要分档只改表即可；要单独放开某一档也可以走
 * config.draw.quotaOverride。
 */
export function quotaTierOf({ scene, nsfw, isOwner = false }) {
  if (isOwner || scene === SCENES.PRIVATE_OWNER) return 'owner';
  if (nsfw) return 'generic_nsfw';
  return 'normal';
}

/** 所有档位共用的额度（原 owner 档）。 */
const SHARED_TIER = Object.freeze({
  perUserDaily: 100,
  cooldownMs: 60_000,
  perGroupDaily: Infinity,
});

export const QUOTA_TABLE = {
  owner: { ...SHARED_TIER },
  normal: { ...SHARED_TIER },
  generic_nsfw: { ...SHARED_TIER },
};
