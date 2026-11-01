// 出图服务总装（未接入桥接；接入时在 mcp-snowluma-safe.js 里注册一个工具调用它的 draw()）
//
// 流程：策略 → 配额 → 入队 → 执行 → 成功才扣配额
// 原则：拒绝必须在执行之前返回，图片一律不出。
import { checkDrawPolicy, sceneOf, quotaTierOf, QUOTA_TABLE, SCENES } from './policy.js';
import { createQuotaStore, mergeQuotaTable } from './quota.js';
import { createSerialQueue } from './queue.js';
import { createRunner } from './runner.js';
import { loadPresets, allowedPresets } from './presets.js';

export function createDrawService({
  stateDir,
  ownerQQ,
  drawCfg = {},
  log = () => {},
  now = Date.now,
} = {}) {
  const { presets } = loadPresets(drawCfg.presetFile);
  // 配额表：默认取 policy.js 的 QUOTA_TABLE，config.draw.json 的 quotaOverride 可覆盖
  // （测试期放开群额度就靠它；设成 null 即回默认值）。
  const quotaTable = mergeQuotaTable(drawCfg.quotaOverride);
  const quota = createQuotaStore(stateDir, { now, table: quotaTable });
  const queue = createSerialQueue({
    maxDepth: drawCfg.maxQueue ?? 5,
    timeoutMs: drawCfg.timeoutMs ?? 240_000,
  });
  const runner = createRunner({
    scriptPath: drawCfg.scriptPath,
    timeoutMs: drawCfg.timeoutMs ?? 240_000,
  });

  /** 给 agent 的可用预设清单。 */
  function listFor(scene) {
    return allowedPresets(presets, scene);
  }

  /**
   * 处理一次出图请求。
   * @param {{key:string, userId:string, preset:string, extra?:string}} req
   * @returns {Promise<object>} 统一结果对象
   */
  async function draw({ key, userId, preset, extra }) {
    const scene = sceneOf(key, ownerQQ);
    const p = presets[preset];
    if (!p) return { ok: false, code: 'bad_preset', scene };

    // 部分预设只用于本地生成训练素材，不对 QQ 侧开放（qqExposed: false）。
    // 例如 apron 系列固定白底、会顶掉场景要求，QQ 侧改用 scene:nsfw / custom:xixi:nsfw。
    if (p.qqExposed === false) {
      log('draw_preset_hidden', { key, userId, preset });
      return {
        ok: false,
        code: 'preset_not_available',
        scene,
        message: '这个预设不对 QQ 开放，换成 scene:nsfw 或 custom:xixi:nsfw（自由描述，可带场景）',
      };
    }

    const policy = checkDrawPolicy({ scene, character: p.character, nsfw: p.nsfw });
    if (!policy.ok) {
      log('draw_refused', { key, userId, preset, code: policy.code });
      return { ok: false, ...policy, scene };
    }

    const tier = quotaTierOf({ scene, nsfw: p.nsfw });
    const q = quota.check({ key, userId, tier });
    if (!q.ok) {
      log('draw_quota', { key, userId, preset, code: q.code });
      return {
        ok: false,
        code: q.code,
        scene,
        remaining: q.remaining,
        limit: q.limit,
        waitMs: q.waitMs,
        message:
          q.code === 'quota_user'
            ? `今天的 ${QUOTA_TABLE[tier].perUserDaily} 张已经用完了`
            : q.code === 'quota_group'
              ? '这个群今天的额度用完了'
              : `再等 ${Math.ceil((q.waitMs ?? 0) / 1000)} 秒`,
      };
    }

    const enq = queue.push(
      () => runner.run({ preset, extra }),
      { key, userId, preset, tier },
    );
    if (!enq.accepted) {
      log('draw_queue_full', { key, userId, preset });
      return { ok: false, code: 'queue_full', scene, position: 0 };
    }

    const r = await enq.promise;
    if (!r || !r.ok) {
      log('draw_failed', { key, userId, preset, code: r?.code });
      return { ok: false, scene, ...(r ?? { code: 'unknown' }) };
    }

    quota.consume({ key, userId });
    log('draw_ok', { key, userId, preset, file: r.file, seed: r.seed });
    return { ok: true, scene, tier, ...r };
  }

  function stats() {
    return { queue: queue.stats(), health: runner.health(), presets: Object.keys(presets).length };
  }

  return { draw, listFor, stats, clearQueue: () => queue.clear(), _quota: quota };
}

export { SCENES };
