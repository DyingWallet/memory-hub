#!/usr/bin/env node
/**
 * 夜间整理：唤起一个 DSH 会话（preset: `sleep-consolidator`），把当天的记忆交给它，
 * 由它自己用 MCP 记忆工具写回长期库。
 *
 * 设计（见 docs/SLEEP-CONSOLIDATION.md）：
 *   · 整理者是 DSH 里的 agent，与主会话同 workspace、同 AGENTS.md —— 人格一致；
 *   · 脚本只负责「喂上下文 + 等结果 + 记审计」，不碰模型、不写记忆；
 *   · 需要 `sleep-consolidator` preset 已安装并重启过 DSH，否则拒绝执行。
 *
 *   node scripts/sleep-consolidate.mjs --dry-run    # 只打印今天的清单与 prompt
 *   node scripts/sleep-consolidate.mjs              # 真跑（会建/复用一个整理会话）
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadConfig } from '@memsvc/server/config';
// DSH 客户端：这里指向**部署目录**（含 node_modules），不是 memory-hub/qq-bridge 的源码副本。
import { blocksToText, NodeApiClient, unwrap } from '../../qq-bridge/src/dsh-client.js';
import { resolveDshBaseUrl } from '../../qq-bridge/src/lib/dsh-endpoint.mjs';

const PRESET = 'sleep-consolidator';
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const config = loadConfig();
const dataDir = config.dataDir;
const stateFile = join(dataDir, 'sleep', 'session.json');
const logDir = join(dataDir, 'sleep');

function log(line) {
  const stamp = new Date().toISOString();
  const text = `${stamp} ${line}\n`;
  process.stdout.write(text);
  try {
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, `consolidate-${localDate(Date.now())}.log`), text, { flag: 'a' });
  } catch {
    // 日志写不了不影响主流程
  }
}

function localDate(now) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 今天的活记录（含来源场景与可见范围），直接读 JSONL，不依赖 memd 在跑。 */
function collectToday(factsDir, now) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const since = start.getTime();
  const rows = [];
  if (!existsSync(factsDir)) return rows;
  for (const name of readdirSync(factsDir).filter((n) => n.endsWith('.jsonl'))) {
    let text = '';
    try {
      text = readFileSync(join(factsDir, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record.deleted) continue;
      const ts = Date.parse(record.ts ?? '');
      if (!Number.isFinite(ts) || ts < since) continue;
      rows.push(record);
    }
  }
  return rows.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

function renderList(rows) {
  return rows
    .map((row, index) => {
      const audience = Array.isArray(row.audience) ? row.audience.join(',') : String(row.audience ?? '');
      const text = String(row.text ?? '').replace(/\s+/g, ' ').slice(0, 400);
      return `${index + 1}. [scene=${row.scene ?? '-'}][audience=${audience}][privacy=${row.privacy ?? '-'}][kind=${row.kind ?? '-'}] ${text}`;
    })
    .join('\n');
}

function buildPrompt(rows, memoriesDir) {
  return `你在做今天的夜间整理（${localDate(Date.now())}）。

下面是今天写入的记忆（含来源场景与可见范围），共 ${rows.length} 条：

${renderList(rows)}

任务：
1. 判断哪些值得长期保留（承诺、偏好、决定、关于主人的事实、对他人的印象、已发生的事）。
2. 合并重复、更新过时的（用 memory_write 的 supersedes 指向旧 id）、确认作废的用 memory_forget。
3. 用 memory_write 写回；audience 按上面规则判断，每条写 reason。
4. 处理完给一句简短总结：写了哪些、改写了哪些、忘了哪些。

记忆目录：${memoriesDir}（需要细节时用 read 看 index.md）`;
}

/** 等到这一轮 turn/end，收集 assistant 文本。 */
async function promptAndWait(api, sessionId, text, timeoutMs = 15 * 60_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    await api.events.follow(sessionId);
    let output = '';
    const done = new Promise((resolveTurn, rejectTurn) => {
      void (async () => {
        try {
          for await (const envelope of api.events.mux({}, ac.signal)) {
            const frame = envelope?.payload ?? envelope;
            if (frame?.type !== 'session/event' || frame.sessionId !== sessionId) continue;
            const event = frame.event;
            if (event?.type === 'assistant/message') {
              output += blocksToText(event.data?.message);
            } else if (event?.type === 'turn/end') {
              resolveTurn(output);
              return;
            } else if (event?.type === 'error' || event?.type === 'session/error') {
              rejectTurn(new Error(String(event.data?.message ?? 'DSH error')));
              return;
            }
          }
          resolveTurn(output);
        } catch (error) {
          rejectTurn(error);
        }
      })();
    });
    await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text }] });
    return await done;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureSession(api, workspacePath) {
  if (existsSync(stateFile)) {
    try {
      const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
      if (saved?.sessionId) {
        // 复用前确认它还在（DSH 重启后旧会话会失效）。
        try {
          const listed = unwrap(await api.sessions.list({}), 'session/list');
          const ids = (listed?.sessions ?? []).map((item) => item.sessionId);
          if (ids.includes(saved.sessionId)) return saved.sessionId;
        } catch {
          // 列表拿不到就重建
        }
      }
    } catch {
      // 状态文件坏了：重建
    }
  }
  const workspace = unwrap(await api.workspace.create({ path: workspacePath }), 'workspace/create');
  const workspaceId = workspace?.workspace?.workspaceId;
  if (!workspaceId) throw new Error('workspace/create 没有返回 workspaceId');
  const created = unwrap(
    await api.sessions.create({ workspaceId, agentPreset: PRESET }),
    'session/create',
  );
  const sessionId = created?.sessionId;
  if (!sessionId) throw new Error('session/create 没有返回 sessionId');
  try {
    await api.callUnary('session.rename', { sessionId, title: `夜间整理·${localDate(Date.now())}` });
  } catch {
    // 改名失败不影响整理
  }
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, `${JSON.stringify({ sessionId, createdAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  return sessionId;
}

const now = Date.now();
const rows = collectToday(config.factsDir, now);
const prompt = buildPrompt(rows, config.memoriesDir);
log(`today rows=${rows.length}`);

if (dryRun) {
  console.log('--- prompt ---');
  console.log(prompt);
  process.exit(0);
}

if (rows.length === 0) {
  log('nothing to consolidate today');
  process.exit(0);
}

const resolved = await resolveDshBaseUrl(process.env.DSH_WEB_URL ?? '', { timeoutMs: 1500, discover: true });
if (!resolved.reachable) {
  log(`DSH unreachable (${resolved.candidates.join(', ')}); skipping`);
  process.exit(2);
}
log(`DSH ${resolved.url}`);

const api = new NodeApiClient(resolved.url, 20_000, {});
const presets = unwrap(await api.agentPresets.list({}), 'agentPresets/list');
const presetIds = (presets?.presets ?? []).map((item) => item.id);
if (!presetIds.includes(PRESET)) {
  log(`preset "${PRESET}" 未安装（可用：${presetIds.join(', ')}）；先跑 scripts/install-sleep-preset.ps1 并重启 DSH`);
  process.exit(3);
}

const workspacePath = resolve(config.memoriesDir, '..');
try {
  const sessionId = await ensureSession(api, workspacePath);
  log(`session=${sessionId}`);
  const startedAt = Date.now();
  const reply = await promptAndWait(api, sessionId, prompt);
  log(`done ms=${Date.now() - startedAt} chars=${reply.length}`);
  log(`reply: ${reply.replace(/\s+/g, ' ').slice(0, 400)}`);
} catch (error) {
  log(`failed: ${error?.message ?? error}`);
  process.exit(4);
}
