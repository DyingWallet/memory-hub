// 预设表的桥接侧视图（只读缓存 + 校验）
import { readFileSync } from 'node:fs';

const PRESET_FILE = 'D:\\deepseek_workspace\\qq-bridge\\tools\\draw\\draw_presets.json';

export function loadPresets(file = PRESET_FILE) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const presets = raw?.presets ?? {};
  const names = Object.keys(presets);
  if (!names.length) throw new Error('预设表为空');
  for (const [k, v] of Object.entries(presets)) {
    if (!['xixi', 'generic'].includes(v.character)) throw new Error(`预设 ${k} 的 character 非法：${v.character}`);
    if (typeof v.nsfw !== 'boolean') throw new Error(`预设 ${k} 缺少 nsfw 标记`);
  }
  return { presets, names, model: raw.model };
}

/** 给 agent 看的清单：只列名称、标签、角色、尺度。 */
export function describePresets(presets) {
  return Object.entries(presets).map(([name, p]) => ({
    name,
    label: p.label ?? name,
    character: p.character,
    nsfw: Boolean(p.nsfw),
    qqExposed: p.qqExposed !== false,
  }));
}

/** 场景允许的预设（群聊不出现 nsfw 的汐；qqExposed:false 的只留给本地训练素材生成）。 */
export function allowedPresets(presets, scene) {
  return describePresets(presets).filter((p) => {
    if (p.qqExposed === false) return false;
    if (p.character === 'xixi' && p.nsfw && scene !== 'private_owner') return false;
    return true;
  });
}
