#!/usr/bin/env node
/**
 * 开关语义检索并落盘（config.json 的 semantic.enabled），幂等、原子写。
 *
 *   node scripts/set-semantic.mjs --on
 *   node scripts/set-semantic.mjs --off
 *   node scripts/set-semantic.mjs --on --alpha 0.6
 *
 * 只改 semantic 段，其它字段原样保留；写前留一份 .bak-<时间戳>。
 */
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configFile = process.env.MEMD_CONFIG ?? join(root, 'config.json');
const args = process.argv.slice(2);

if (!existsSync(configFile)) {
  console.error(`missing ${configFile}（先跑一次 scripts/start.ps1 让它从示例生成）`);
  process.exit(1);
}
const on = args.includes('--on');
const off = args.includes('--off');
if (on === off) {
  console.error('需要且只能给一个：--on 或 --off');
  process.exit(2);
}
const alphaIndex = args.indexOf('--alpha');
const alpha = alphaIndex >= 0 ? Number(args[alphaIndex + 1]) : undefined;
if (alpha !== undefined && (!Number.isFinite(alpha) || alpha < 0 || alpha > 1)) {
  console.error('--alpha 必须是 0–1 的数');
  process.exit(2);
}

const raw = JSON.parse(readFileSync(configFile, 'utf8'));
raw.semantic ??= {};
raw.semantic.enabled = on;
if (alpha !== undefined) raw.semantic.alpha = alpha;

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
copyFileSync(configFile, `${configFile}.bak-${stamp}`);
const tmp = `${configFile}.tmp`;
writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
renameSync(tmp, configFile);

console.log(`semantic.enabled = ${on}${alpha !== undefined ? `, alpha = ${alpha}` : ''} -> ${configFile}`);
if (on) {
  console.log('下一步：重启 memd（或等看护任务拉起），然后 node scripts/embed.mjs 回填向量');
}
