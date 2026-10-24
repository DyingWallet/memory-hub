#!/usr/bin/env node
/**
 * memory-hub 部署自检：把所有分散的 --check 合成一份报告，只读、不改任何东西。
 *
 *   node scripts/doctor.mjs           # 人读的表格
 *   node scripts/doctor.mjs --json    # 机器读（CI / setup-all.ps1 汇总用）
 *
 * 退出码：0 = 核心就绪（MCP 块、两个插件、令牌、memd 健康）；1 = 有核心项没就绪。
 * 语义检索、计划任务、模型目录只作为「提示项」，不拉低退出码。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const profile = process.env.DSH_PROFILE ?? 'desktop';
const profileDir = join(dshHome, 'profiles', profile);
const tokenFile = join(dshHome, 'memory-token');
const json = process.argv.includes('--json');

const checks = [];
function add(id, label, ok, detail, { critical = true } = {}) {
  checks.push({ id, label, ok, detail, critical });
}

/* ── 构建产物 ─────────────────────────────────────────────── */
const serverEntry = join(root, 'packages', 'server', 'dist', 'index.js');
const mcpEntry = join(root, 'packages', 'adapter-dsh', 'dist', 'mcp-server.js');
add('build.server', 'memd 构建产物', existsSync(serverEntry), serverEntry);
add('build.mcp', 'MCP 构建产物', existsSync(mcpEntry), mcpEntry);

/* ── DSH profile：两个插件 + MCP 块 ───────────────────────── */
const manifestPath = join(profileDir, 'package.json');
let manifest = null;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch {
  add('profile.manifest', 'DSH profile 可读', false, manifestPath);
}
if (manifest) {
  const bundles = manifest?.dsh?.profile?.bundles ?? [];
  const deps = manifest?.dependencies ?? {};
  for (const plugin of ['dsh-memory', 'dsh-memory-panel']) {
    const linked = existsSync(join(profileDir, 'node_modules', plugin));
    add(
      `plugin.${plugin}`,
      `插件 ${plugin}`,
      Boolean(deps[plugin]) && bundles.includes(plugin) && linked,
      `dep=${Boolean(deps[plugin])} bundle=${bundles.includes(plugin)} linked=${linked}`,
    );
  }
  const patchFile = join(profileDir, 'cordis.patch.yml');
  const patch = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : '';
  add('mcp.block', 'MCP 注册块', patch.includes('memory-hub MCP BEGIN'), patchFile);
}

/* ── 令牌 ─────────────────────────────────────────────────── */
let token = '';
try {
  token = readFileSync(tokenFile, 'utf8').trim();
} catch {
  // 没令牌
}
add('token.root', 'root 令牌', token.length >= 16, token ? `${tokenFile}（${token.length} 字符）` : `${tokenFile} 缺失`);

/* ── memd 健康 + 语义状态 ─────────────────────────────────── */
const endpoint = process.env.MEMD_ENDPOINT ?? 'http://127.0.0.1:8787';
let health = null;
try {
  const response = await fetch(`${endpoint}/v1/health`, { signal: AbortSignal.timeout(2500) });
  health = await response.json();
  add('memd.health', 'memd 健康', response.ok && health?.ok === true, `${endpoint} docs=${health?.index?.docs} facts=${health?.index?.facts} chunks=${health?.index?.chunks}`);
} catch (error) {
  add('memd.health', 'memd 健康', false, `${endpoint} 不可达：${error?.message ?? error}`);
}

if (health && token) {
  try {
    const response = await fetch(`${endpoint}/v1/config-state`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (response.ok) {
      const state = await response.json();
      const semantic = state.semantic ?? {};
      const detail = semantic.enabled
        ? semantic.ready
          ? `已启用，${semantic.vectors} 个向量（${semantic.dim} 维）`
          : `已启用但不可用：${semantic.reason ?? 'unknown'}`
        : '关闭（纯 FTS）';
      add('semantic', '语义检索', semantic.enabled ? Boolean(semantic.ready) : true, detail, { critical: false });
    } else {
      add('semantic', '语义检索', true, `config-state HTTP ${response.status}（令牌可能不是 root）`, { critical: false });
    }
  } catch (error) {
    add('semantic', '语义检索', true, `读取失败：${error?.message ?? error}`, { critical: false });
  }
}

/* ── 插件是否真的被加载（重启后验证） ─────────────────────── */
const stampFile = join(root, 'data', 'setup-stamp.json');
let installedAt = 0;
try {
  installedAt = Date.parse(JSON.parse(readFileSync(stampFile, 'utf8').replace(/^\uFEFF/, '')).at);
} catch {
  installedAt = 0;
}
for (const plugin of ['dsh-memory', 'dsh-memory-panel']) {
  const markerFile = join(root, 'data', 'plugin-load', `${plugin}.json`);
  let marker = null;
  try {
    marker = JSON.parse(readFileSync(markerFile, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    marker = null;
  }
  if (!marker) {
    add(`loaded.${plugin}`, `插件 ${plugin} 已加载`, false, '没有加载标记：从未在 DSH 里加载过，或插件未启用');
    continue;
  }
  const loadedAt = Date.parse(marker.at);
  const afterInstall = installedAt === 0 || loadedAt >= installedAt;
  add(
    `loaded.${plugin}`,
    `插件 ${plugin} 已加载`,
    afterInstall,
    afterInstall
      ? `加载于 ${marker.at}（pid ${marker.pid}）`
      : `上次加载 ${marker.at}，早于本次安装（${new Date(installedAt).toISOString()}）→ 需要重启 DSH`,
  );
}

/* ── 跨场景披露（QQ 桥接；没装桥接就跳过） ─────────────────── */
const bridgeDir = resolve(root, '..', 'qq-bridge');
if (existsSync(join(bridgeDir, 'src', 'bridge.js'))) {
  const discloseTokenFile = join(bridgeDir, 'state', 'memory-disclose.token');
  let discloseToken = '';
  try {
    discloseToken = readFileSync(discloseTokenFile, 'utf8').trim();
  } catch {
    discloseToken = '';
  }
  add(
    'disclose.token',
    '披露令牌',
    discloseToken.length >= 16,
    discloseToken
      ? `${discloseTokenFile}（${discloseToken.length} 字符）`
      : `${discloseTokenFile} 缺失（跑 issue-qq-tokens.mjs 后复制到桥接 state/）`,
  );

  if (discloseToken) {
    let groupId = '';
    try {
      const bridgeConfig = JSON.parse(readFileSync(join(bridgeDir, 'config.json'), 'utf8'));
      groupId = String((bridgeConfig?.allow?.groups ?? [])[0] ?? '');
      if (bridgeConfig?.memory?.disclosure === false) {
        add('disclose.enabled', '披露开关', true, 'config.json 里 memory.disclosure=false（主动关闭）', { critical: false });
      }
    } catch {
      groupId = '';
    }
    if (groupId) {
      try {
        const response = await fetch(`${endpoint}/v1/disclose`, {
          method: 'POST',
          headers: { authorization: `Bearer ${discloseToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ requester: '10000', group: `qq:group:${groupId}`, since_hours: 24, k: 5 }),
          signal: AbortSignal.timeout(4000),
        });
        if (response.ok) {
          const body = await response.json();
          add('disclose.api', '披露接口', true, `/v1/disclose 群 ${groupId} 返回 ${body.count} 条`);
        } else {
          add('disclose.api', '披露接口', false, `/v1/disclose HTTP ${response.status}`);
        }
      } catch (error) {
        add('disclose.api', '披露接口', false, `${endpoint} 不可达：${error?.message ?? error}`);
      }
    } else {
      add('disclose.api', '披露接口', false, '桥接 config.json 里没有 allow.groups');
    }
  }

  const membersFile = join(bridgeDir, 'state', 'group-members.json');
  try {
    const members = JSON.parse(readFileSync(membersFile, 'utf8'));
    const groups = Object.entries(members?.groups ?? {});
    const newest = groups.reduce((max, [, value]) => Math.max(max, Number(value?.updatedAt ?? 0)), 0);
    const ageHours = newest > 0 ? (Date.now() - newest) / 3600000 : Infinity;
    add(
      'disclose.members',
      '群成员表',
      groups.length > 0 && ageHours < 48,
      groups.length > 0
        ? `${groups.map(([gid, value]) => `${gid}:${value.ids?.length ?? 0}人`).join(' ')}；${ageHours.toFixed(1)} 小时前更新`
        : '还没有成员表（等群消息/事件或每日对账建立）',
      { critical: false },
    );
  } catch {
    add('disclose.members', '群成员表', false, '还没有成员表（等群消息/事件或每日对账建立）', { critical: false });
  }

  try {
    const last = JSON.parse(readFileSync(join(bridgeDir, 'state', 'disclose-last.json'), 'utf8'));
    add(
      'disclose.last',
      '最近一次披露',
      true,
      `${last.at} ${last.group ?? ''}（提问者 …${last.requester_suffix ?? ''}）`,
      { critical: false },
    );
  } catch {
    add('disclose.last', '最近一次披露', false, '还没发生过（真实触发一次后会记录在这里）', { critical: false });
  }
}

/* ── 模型目录（语义的前置） ───────────────────────────────── */
const modelFile = join(root, 'models', 'bge-small-zh-v1.5', 'onnx', 'model_quantized.onnx');
if (existsSync(modelFile)) {
  add('semantic.model', 'embedding 模型', true, `${(statSync(modelFile).size / 1e6).toFixed(1)} MB`, { critical: false });
} else {
  add('semantic.model', 'embedding 模型', false, '未下载（pnpm fetch:model）；只影响语义检索', { critical: false });
}

/* ── 计划任务心跳（看护是否在跑；任务本身要非沙箱才能查） ── */
const tick = join(root, 'logs', 'task-last-tick.txt');
if (existsSync(tick)) {
  const ageMin = (Date.now() - statSync(tick).mtimeMs) / 60000;
  add('tasks.heartbeat', 'memd 看护心跳', ageMin < 5, `${Math.round(ageMin)} 分钟前刷新`, { critical: false });
} else {
  add('tasks.heartbeat', 'memd 看护心跳', false, '没有心跳文件（未跑过 install-autostart.ps1）', { critical: false });
}

/* ── 输出 ─────────────────────────────────────────────────── */
const criticalFailures = checks.filter((check) => check.critical && !check.ok);
if (json) {
  console.log(JSON.stringify({ ready: criticalFailures.length === 0, checks }, null, 2));
} else {
  const width = Math.max(...checks.map((check) => check.label.length)) + 2;
  for (const check of checks) {
    const mark = check.ok ? 'OK  ' : check.critical ? 'FAIL' : 'warn';
    console.log(`${mark}  ${check.label.padEnd(width)} ${check.detail}`);
  }
  const warns = checks.filter((check) => !check.critical && !check.ok).length;
  console.log(
    `\n${criticalFailures.length === 0 ? '核心就绪' : `${criticalFailures.length} 项核心检查未通过`}` +
      (warns > 0 ? `，${warns} 项提示` : '') +
      (criticalFailures.length === 0 ? '\n提示：插件/MCP 改动需要重启 DSH 才生效。' : ''),
  );
}
process.exit(criticalFailures.length === 0 ? 0 : 1);
