#!/usr/bin/env node
/**
 * memory-hub 部署自检：把所有分散的 --check 合成一份报告。
 *
 *   node scripts/doctor.mjs           # 人读的表格
 *   node scripts/doctor.mjs --json    # 机器读（CI / setup-all.ps1 汇总用）
 *
 * 也可以被插件 import（DSH 启动后自动跑一次，见 plugins/dsh-memory-panel）：
 *
 *   const { runDoctor } = await import('../../../scripts/doctor.mjs');
 *   const { ready, checks } = await runDoctor();
 *
 * 退出码：0 = 核心就绪（MCP 块、两个插件、令牌、memd 健康）；1 = 有核心项没就绪。
 * 语义检索、计划任务、模型目录、披露的提示项不拉低退出码。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const profile = process.env.DSH_PROFILE ?? 'desktop';
const profileDir = join(dshHome, 'profiles', profile);
const tokenFile = join(dshHome, 'memory-token');
const endpoint = process.env.MEMD_ENDPOINT ?? 'http://127.0.0.1:8787';

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
};

/**
 * 跑一遍全部检查。纯读（唯一副作用是披露探针会发一次真实请求），不写任何文件。
 * @param {{ deep?: boolean }} options deep=false 时跳过披露探针（只查文件）
 */
export async function runDoctor({ deep = true } = {}) {
  const checks = [];
  const add = (id, label, ok, detail, { critical = true } = {}) => {
    checks.push({ id, label, ok: Boolean(ok), detail: String(detail), critical });
  };

  /* ── 构建产物 ─────────────────────────────────────────────── */
  add('build.server', 'memd 构建产物', existsSync(join(root, 'packages', 'server', 'dist', 'index.js')), join(root, 'packages', 'server', 'dist', 'index.js'));
  add('build.mcp', 'MCP 构建产物', existsSync(join(root, 'packages', 'adapter-dsh', 'dist', 'mcp-server.js')), join(root, 'packages', 'adapter-dsh', 'dist', 'mcp-server.js'));

  /* ── DSH profile：两个插件 + MCP 块 ───────────────────────── */
  const manifestPath = join(profileDir, 'package.json');
  const manifest = readJson(manifestPath);
  if (!manifest) {
    add('profile.manifest', 'DSH profile 可读', false, manifestPath);
  } else {
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
    token = '';
  }
  add('token.root', 'root 令牌', token.length >= 16, token ? `${tokenFile}（${token.length} 字符）` : `${tokenFile} 缺失`);

  /* ── memd 健康 + 语义状态 ─────────────────────────────────── */
  let health = null;
  try {
    const response = await fetch(`${endpoint}/v1/health`, { signal: AbortSignal.timeout(2500) });
    health = await response.json();
    add(
      'memd.health',
      'memd 健康',
      response.ok && health?.ok === true,
      `${endpoint} docs=${health?.index?.docs} facts=${health?.index?.facts} chunks=${health?.index?.chunks}`,
    );
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
  const installedAt = Date.parse(readJson(join(root, 'data', 'setup-stamp.json'))?.at ?? '') || 0;
  for (const plugin of ['dsh-memory', 'dsh-memory-panel']) {
    const marker = readJson(join(root, 'data', 'plugin-load', `${plugin}.json`));
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

  /* ── 上次启动自检（插件加载后自动跑的，见 panel） ─────────── */
  const lastBootCheck = readJson(join(root, 'data', 'doctor-last.json'));
  if (lastBootCheck) {
    const failed = Array.isArray(lastBootCheck.failed) ? lastBootCheck.failed : [];
    const warnCount = Array.isArray(lastBootCheck.warns) ? lastBootCheck.warns.length : 0;
    add(
      'bootcheck.last',
      '上次启动自检',
      lastBootCheck.ready === true && failed.length === 0,
      lastBootCheck.ready === true
        ? `${lastBootCheck.at} 核心就绪${warnCount > 0 ? `（${warnCount} 项提示）` : ''}`
        : `${lastBootCheck.at} 失败：${failed.join(', ')}`,
      { critical: false },
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
      const bridgeConfig = readJson(join(bridgeDir, 'config.json'));
      if (bridgeConfig) {
        groupId = String((bridgeConfig?.allow?.groups ?? [])[0] ?? '');
        if (bridgeConfig?.memory?.disclosure === false) {
          add('disclose.enabled', '披露开关', true, 'config.json 里 memory.disclosure=false（主动关闭）', { critical: false });
        }
      }
      if (!groupId) {
        add('disclose.api', '披露接口', false, '桥接 config.json 里没有 allow.groups');
      } else if (!deep) {
        add('disclose.api', '披露接口', true, `跳过探针（deep=false），群 ${groupId}`, { critical: false });
      } else {
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
      }
    }

    const members = readJson(join(bridgeDir, 'state', 'group-members.json'));
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

    const lastDisclose = readJson(join(bridgeDir, 'state', 'disclose-last.json'));
    add(
      'disclose.last',
      '最近一次披露',
      Boolean(lastDisclose),
      lastDisclose
        ? `${lastDisclose.at} ${lastDisclose.group ?? ''}（提问者 …${lastDisclose.requester_suffix ?? ''}）`
        : '还没发生过（真实触发一次后会记录在这里）',
      { critical: false },
    );
  }

  /* ── 模型目录（语义的前置） ───────────────────────────────── */
  const modelFile = join(root, 'models', 'bge-small-zh-v1.5', 'onnx', 'model_quantized.onnx');
  add(
    'semantic.model',
    'embedding 模型',
    existsSync(modelFile),
    existsSync(modelFile) ? `${(statSync(modelFile).size / 1e6).toFixed(1)} MB` : '未下载（pnpm fetch:model）；只影响语义检索',
    { critical: false },
  );

  /* ── 计划任务心跳（看护是否在跑；任务本身要非沙箱才能查） ── */
  const tick = join(root, 'logs', 'task-last-tick.txt');
  if (existsSync(tick)) {
    const ageMin = (Date.now() - statSync(tick).mtimeMs) / 60000;
    add('tasks.heartbeat', 'memd 看护心跳', ageMin < 5, `${Math.round(ageMin)} 分钟前刷新`, { critical: false });
  } else {
    add('tasks.heartbeat', 'memd 看护心跳', false, '没有心跳文件（未跑过 install-autostart.ps1）', { critical: false });
  }

  /* ── 谁在用 DSH 自带的 node（升级会锁安装目录）────────────── */
  const dshNodePrefix = 'D:\\Software\\dsh\\';
  const runtimeSources = [
    { name: 'memd', file: join(root, 'data', 'runtime.json') },
    { name: 'pet-llm', file: join(root, '..', 'dsh-pet-configurable-llm', 'state', 'runtime.json') },
    { name: 'qq-bridge', file: join(root, '..', 'qq-bridge', 'state', 'runtime.json') },
  ];
  const usingDshNode = [];
  const missingRuntime = [];
  for (const source of runtimeSources) {
    const recorded = readJson(source.file);
    if (!recorded?.node) {
      missingRuntime.push(source.name);
      continue;
    }
    if (String(recorded.node).startsWith(dshNodePrefix)) usingDshNode.push(`${source.name}(pid ${recorded.pid})`);
  }
  add(
    'node.dshLock',
    'DSH 安装目录未被 node 占用',
    usingDshNode.length === 0,
    usingDshNode.length === 0
      ? missingRuntime.length === 0
        ? '没有服务在用 DSH 自带的 node.exe'
        : `没有服务在用 DSH 自带的 node.exe（未记录：${missingRuntime.join(', ')}，重启后会有）`
      : `仍在用 DSH 自带 node：${usingDshNode.join(', ')} → 升级前必须先停这些服务`,
  );

  const criticalFailures = checks.filter((check) => check.critical && !check.ok);
  return { ready: criticalFailures.length === 0, checks };
}

/** 把一次自检结果追加到 logs/doctor-boot.log，并更新 data/doctor-last.json。 */
export function recordBootCheck(result, { at = new Date().toISOString() } = {}) {
  // 只把核心失败算作「失败」；提示项单独记，免得一个预期中的 warn（比如还没触发过披露）
  // 让「上次启动自检」永远黄着。
  const failed = result.checks.filter((check) => !check.ok && check.critical).map((check) => check.id);
  const warns = result.checks.filter((check) => !check.ok && !check.critical).map((check) => check.id);
  const summary = { at, ready: result.ready, failed, warns };
  try {
    mkdirSync(join(root, 'logs'), { recursive: true });
    appendFileSync(join(root, 'logs', 'doctor-boot.log'), `${JSON.stringify(summary)}\n`, 'utf8');
  } catch {
    // 日志写不进去不影响自检本身
  }
  try {
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'doctor-last.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  } catch {
    // 同上
  }
  return summary;
}

/* ── CLI ─────────────────────────────────────────────────── */
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = await runDoctor({ deep: !process.argv.includes('--shallow') });
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const width = Math.max(...result.checks.map((check) => check.label.length)) + 2;
    for (const check of result.checks) {
      const mark = check.ok ? 'OK  ' : check.critical ? 'FAIL' : 'warn';
      console.log(`${mark}  ${check.label.padEnd(width)} ${check.detail}`);
    }
    const warns = result.checks.filter((check) => !check.critical && !check.ok).length;
    console.log(
      `\n${result.ready ? '核心就绪' : `${result.checks.filter((check) => check.critical && !check.ok).length} 项核心检查未通过`}` +
        (warns > 0 ? `，${warns} 项提示` : '') +
        (result.ready ? '\n提示：插件/MCP 改动需要重启 DSH 才生效。' : ''),
    );
  }
  process.exit(result.ready ? 0 : 1);
}
