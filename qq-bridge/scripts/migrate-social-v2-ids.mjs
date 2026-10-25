#!/usr/bin/env node
/**
 * 给 social-v2 的轻量记忆条目补身份（id / rev），并写上 schemaVersion: 2。
 *
 *   node scripts\migrate-social-v2-ids.mjs            # 预览（不写盘）
 *   node scripts\migrate-social-v2-ids.mjs --apply    # 真写（先备份）
 *
 * 幂等：已经有 id 的条目一个字段都不动；重复跑不会重新生成 id
 * （id 变了等于换了身份，memd 里那条就再也对不上了）。
 *
 * 只动 social-v2.json，**不碰 memd**：迁移后的旧条目在对账里仍然是 legacy，
 * 要变成 present 需要显式 `reconcile-memory.mjs --fix missing` 或人工接管。
 */
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const stateDir = resolve(process.env.BRIDGE_STATE_DIR || join(ROOT, 'state'));
const file = join(stateDir, 'social-v2.json');
const apply = process.argv.includes('--apply');

if (!existsSync(file)) {
  console.error(`social-v2.json not found: ${file}`);
  process.exit(1);
}

const newId = () => randomBytes(4).toString('hex');
const raw = readFileSync(file, 'utf8');
const social = JSON.parse(raw);
const stats = { topics: 0, thoughts: 0, impressions: 0, already: 0, schemaVersion: social.schemaVersion ?? null };

for (const [convKey, conv] of Object.entries(social.conversations ?? {})) {
  if (!conv || typeof conv !== 'object') continue;
  for (const list of [conv.activeTopics, conv.pendingThoughts]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      if (item.id) {
        stats.already += 1;
        if (!(Number(item.rev) > 0)) item.rev = 1;
        continue;
      }
      item.id = newId();
      item.rev = 1;
      // eslint-disable-next-line no-unused-expressions
      list === conv.activeTopics ? (stats.topics += 1) : (stats.thoughts += 1);
    }
  }
  const impressions = conv.memberImpressions;
  if (impressions && typeof impressions === 'object') {
    for (const [target, entry] of Object.entries(impressions)) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.id) {
        stats.already += 1;
        if (!(Number(entry.rev) > 0)) entry.rev = 1;
        continue;
      }
      entry.id = `m:${target}`;
      entry.rev = 1;
      stats.impressions += 1;
    }
  }
}

stats.schemaVersion = 2;
social.schemaVersion = 2;

console.log(`文件：${file}`);
console.log(`补 id：activeTopic ${stats.topics} / pendingThought ${stats.thoughts} / memberImpression ${stats.impressions}`);
console.log(`已有 id（跳过）：${stats.already}`);
console.log(`schemaVersion → 2`);

if (!apply) {
  console.log('\n预览模式，未写盘。确认后加 --apply。');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = `${file}.bak-ids-${stamp}`;
copyFileSync(file, backup);
const tmp = `${file}.tmp`;
writeFileSync(tmp, `${JSON.stringify(social, null, 2)}\n`, 'utf8');
renameSync(tmp, file);
console.log(`\n已写盘。备份：${backup}`);
