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
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { loadConfig } from '@memsvc/server/config';
// DSH 客户端：用**仓库内嵌**的 qq-bridge 副本（`memory-hub/qq-bridge/`），
// 不再指向部署目录——第三方只 clone memory-hub 也能跑整理。
// 它的外部依赖（js-yaml / @deepseek-ai/dsh-host-apiproxy）已在 memory-hub/package.json 声明。
import { blocksToText, NodeApiClient, unwrap } from '../qq-bridge/src/dsh-client.js';
import { resolveDshBaseUrl } from '../qq-bridge/src/lib/dsh-endpoint.mjs';

const PRESET = 'sleep-consolidator';
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const config = loadConfig();
const dataDir = config.dataDir;
const logDir = join(dataDir, 'sleep');

/**
 * 四个周期共用一套脚本：
 *   daily   —— 当天记忆 → 值得长期留的事实（默认）
 *   weekly / monthly / yearly —— 读该周期的决策文档 + 长期记忆，提炼「主线」与跨文档因果
 * 每个周期有独立的整理会话（state 文件分开），上下文不互相污染。
 */
const PERIOD_DAYS = { daily: 1, weekly: 7, monthly: 31, yearly: 366 };
const periodArg = args.find((a) => a.startsWith('--period='));
const period = periodArg ? periodArg.slice('--period='.length) : 'daily';
if (!(period in PERIOD_DAYS)) {
  console.error(`unknown --period: ${period} (daily | weekly | monthly | yearly)`);
  process.exit(1);
}
const isSynthesis = period !== 'daily';
const stateFile = join(dataDir, 'sleep', `session-${period}.json`);

function log(line) {
  const stamp = new Date().toISOString();
  const text = `${stamp} [${period}] ${line}\n`;
  process.stdout.write(text);
  try {
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, `consolidate-${period}-${localDate(Date.now())}.log`), text, { flag: 'a' });
  } catch {
    // 日志写不了不影响主流程
  }
}

function localDate(now) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 某个时间点之后的活记录（含来源场景与可见范围），直接读 JSONL，不依赖 memd 在跑。 */
function collectRange(factsDir, sinceMs) {
  const rows = [];
  if (!existsSync(factsDir)) return rows;

  // 删除是「同一 id 后来追加一行 deleted:true」，而这一行的时间是删除那一刻，
  // 跟原文不在同一天。所以墓碑必须先把全库扫一遍，再拿今天的记录去比；
  // 只在遍历时跳过墓碑行，会让「今天写、今天或被删」的原文继续留在清单里。
  const records = [];
  const tombstoned = new Set();
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
      if (record.deleted === true) {
        if (record.id) tombstoned.add(record.id);
        continue;
      }
      records.push(record);
    }
  }

  for (const record of records) {
    if (tombstoned.has(record.id)) continue;
    const ts = Date.parse(record.ts ?? '');
    if (!Number.isFinite(ts) || ts < sinceMs) continue;
    rows.push(record);
  }
  // 排序用原始发送时间：补录的未读 ts 是同一入库时刻，按 ts 排会把整批压成一点。
  return rows.sort((a, b) => Date.parse(a.sent_at ?? a.ts) - Date.parse(b.sent_at ?? b.ts));
}

/** 今天的活记录。 */
function collectToday(factsDir, now) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return collectRange(factsDir, start.getTime());
}

function renderList(rows) {
  let lastClock = '';
  return rows
    .map((row, index) => {
      // 时刻优先用原始发送时间：桥接补录的未读一批全落在同一分钟，
      // 拿入库时刻显示等于没有信息。同一分钟只在首条标一次，省 token。
      const parsed = Date.parse(row.sent_at ?? row.ts ?? '');
      const clock = Number.isFinite(parsed)
        ? `${String(new Date(parsed).getHours()).padStart(2, '0')}:${String(new Date(parsed).getMinutes()).padStart(2, '0')}`
        : '';
      const stamp = clock && clock !== lastClock ? `[${clock}] ` : '';
      if (clock) lastClock = clock;
      const audience = Array.isArray(row.audience) ? row.audience.join(',') : String(row.audience ?? '');
      const text = String(row.text ?? '').replace(/\s+/g, ' ').slice(0, 400);
      return `${index + 1}. ${stamp}[scene=${row.scene ?? '-'}][audience=${audience}][privacy=${row.privacy ?? '-'}][kind=${row.kind ?? '-'}] ${text}`;
    })
    .join('\n');
}

/** root 令牌在 ~/.dsh/memory-token；取不到就退化成「不带长期记忆参照」。 */
function readRootToken() {
  try {
    return readFileSync(join(homedir(), '.dsh', 'memory-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

/** 最近写入的长期记忆：给整理者做查重参照。memd 不可达时返回空数组，不阻塞整理。 */
async function recentLongMemories(token) {
  if (!token) return [];
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/v1/recent`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      // 只要长期层：短期聊天每秒在写，按 updated_at 倒序取 10 条永远是短期，
      // 过滤完只剩一两条，查重参照等于没有。
      body: JSON.stringify({ k: 10, scene: 'main', stage: 'long' }),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return [];
    const data = await response.json();
    return (data?.results ?? []).filter((item) => item.stage !== 'short').slice(0, 10);
  } catch {
    return [];
  }
}

/** 近 5 条决策记录：标题 + 正文开头，够判断「这件事已经定过了」。 */
function recentDecisions(memoriesDir, limit = 5) {  const dir = join(memoriesDir, '40-decisions');
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((name) => name.endsWith('.md')).sort().slice(-limit);
  const out = [];
  for (const name of files) {
    try {
      const raw = readFileSync(join(dir, name), 'utf8');
      const title = (raw.match(/^#\s+(.+)$/m) ?? [])[1]?.trim() ?? name;
      const body = raw
        .replace(/^---[\s\S]*?---/, '')
        .replace(/^#.*$/gm, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
      out.push({ title, body });
    } catch {
      // 单个文件读不了就跳过
    }
  }
  return out;
}

/**
 * 最近长期记忆的渲染：`- [10-27] [decision] 正文`。
 * 时间戳的位置与当日清单一致（方括号在前、标签在后），日期相同只标一次。
 */
function renderLongRefs(items) {
  let lastDay = '';
  return items
    .map((item) => {
      const parsed = Date.parse(item.updated_at ?? '');
      const day = Number.isFinite(parsed)
        ? `${String(new Date(parsed).getMonth() + 1).padStart(2, '0')}-${String(new Date(parsed).getDate()).padStart(2, '0')}`
        : '';
      const stamp = day && day !== lastDay ? `[${day}] ` : '';
      if (day) lastDay = day;
      const text = String(item.render?.text ?? item.title ?? '').replace(/\s+/g, ' ').slice(0, 120);
      return `- ${stamp}[${item.kind}] ${text}`;
    })
    .join('\n');
}

/** 某个时间点之后新建的决策文档（文件名开头就是日期）。 */
function decisionsInRange(memoriesDir, sinceMs) {
  const dir = join(memoriesDir, '40-decisions');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.md')).sort()) {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(name);
    if (!match) continue;
    const day = Date.parse(`${match[1]}T00:00:00`);
    if (!Number.isFinite(day) || day < sinceMs) continue;
    try {
      const raw = readFileSync(join(dir, name), 'utf8');
      const title = (raw.match(/^#\s+(.+)$/m) ?? [])[1]?.trim() ?? name;
      const body = raw
        .replace(/^---[\s\S]*?---/, '')
        .replace(/^#.*$/gm, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300);
      out.push({ title, body, file: name, day: match[1] });
    } catch {
      // 单个文件读不了就跳过
    }
  }
  return out;
}

/** 周 / 月 / 年的综合提炼：读该周期的决策文档 + 长期记忆，写「主线」。 */
function buildPeriodPrompt(rows, docs, range) {
  const label = { weekly: '本周', monthly: '本月', yearly: '本年' }[period];
  const unit = { weekly: '这周', monthly: '这个月', yearly: '这一年' }[period];
  const docBlock =
    docs.length > 0
      ? docs.map((doc) => `- ${doc.day} ${doc.title}（${doc.file}）：${doc.body}`).join('\n')
      : '（这段时间没有新的决策文档）';
  return `你在做${label}的综合提炼（${range.from} ~ ${range.to}）。

【${label}的决策文档】（${docs.length} 份）
${docBlock}

【${label}写下的长期记忆】（${rows.length} 条）
${renderList(rows)}

任务：
1. 提炼${unit}的**主线**：架构、项目、生活各有什么变化，一句话能讲清的那种。
2. 找出**跨文档的因果**：哪次决定导致了后面哪次调整，谁推翻了谁。
3. 只写 1–3 条**综合判断**（kind 用 knowledge，tags 里带「${period}」「主线」），
   不要重复已有的单条记忆——它们在库里已经有了，这里要的是它们串起来的意思。
4. 每条 memory_write 都带 \`source: "sleep"\`。
5. 给一句简短总结：这${unit.slice(1)}的主线是什么。`;
}

function buildPrompt(rows, memoriesDir, refs) {
  const longBlock =
    refs.longMemories.length > 0
      ? `\n【最近写入的长期记忆】（先对照它们：重复的别重写、过时的用 supersedes 改）\n${renderLongRefs(refs.longMemories)}\n`
      : '';
  const decisionBlock =
    refs.decisions.length > 0
      ? `\n【最近的决定】（这些已经定了，别当成待办再整理一遍）\n${refs.decisions
          .map((item) => `- ${item.title}：${item.body}`)
          .join('\n')}\n`
      : '';
  return `你在做今天的夜间整理（${localDate(Date.now())}）。

下面是今天写入的记忆（含来源场景与可见范围），共 ${rows.length} 条：

${renderList(rows)}
${longBlock}${decisionBlock}
任务：
1. 判断哪些值得长期保留（承诺、偏好、决定、关于主人的事实、对他人的印象、已发生的事）。
2. **工程决策、方案定稿这类已经写进 docs/ 或 memories/40-decisions/ 的，不要重复记正文**——
   只在记忆里留一条「某天定了什么」的索引（一句话 + 指向哪份文档），方便以后召回时知道去哪查。
3. 合并重复、更新过时的（用 memory_write 的 supersedes 指向旧 id）、确认作废的用 memory_forget。
4. 用 memory_write 写回；audience 按上面规则判断，每条写 reason。
5. **每一条 memory_write 都要带 \`source: "sleep"\`**——这是来源标记，写错了能按它整批撤回。
6. 今天有几条值得留就写几条，不要凑数，也不必压缩到某个数量。
7. 处理完给一句简短总结：写了哪些、改写了哪些、忘了哪些。

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
              // blocksToText 要的是 ContentBlock[]（message.content），不是 message 本身。
              output += blocksToText(event.data?.message?.content);
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

/** DSH 的归档状态存在 `~/.dsh/storages/workspace.json` 的 `global.archivedSessionIds`。
 *  归档会话照样在 `session/list` 里，prompt 也照样接受，只有 turn 会立刻空完成——
 *  所以光看 list 判断不出来，必须查这张表。读不到时返回 null，调用方退回 list 判断。 */
function archivedSessionIdSet() {
  try {
    const file = join(homedir(), '.dsh', 'storages', 'workspace.json');
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const ids = parsed?.global?.archivedSessionIds;
    return Array.isArray(ids) ? new Set(ids) : null;
  } catch {
    return null;
  }
}

async function ensureConsolidationSession(api, workspacePath) {
  if (existsSync(stateFile)) {
    try {
      const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
      if (saved?.sessionId) {
        // 复用前确认它还在（DSH 重启后旧会话会失效）。
        try {
          const listed = unwrap(await api.sessions.list({}), 'session/list');
          // DSH 的 `session/list` 返回 `{ items }`；读 `sessions` 会得到空集合，于是每次
          // 都判定旧整理会话「不存在」而新建一个，历史上下文永远续不上。
          const ids = (listed?.items ?? listed?.sessions ?? []).map((item) => item.sessionId);
          // 归档会话也在 items 里，必须再查归档表，否则复用只会拿到一个空完成的 turn。
          const archived = archivedSessionIdSet();
          if (archived?.has(saved.sessionId)) {
            log(`整理会话 ${saved.sessionId} 已被 DSH 归档，重建（复用只会拿到空完成的 turn）`);
          } else if (ids.includes(saved.sessionId)) {
            return saved.sessionId;
          }
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
let rows;
let prompt;
if (isSynthesis) {
  const since = now - PERIOD_DAYS[period] * 86_400_000;
  // 综合提炼只看长期：短期聊天对「主线」没有贡献，只会把上下文撑爆。
  rows = collectRange(config.factsDir, since).filter((row) => row.stage !== 'short');
  const docs = decisionsInRange(config.memoriesDir, since);
  prompt = buildPeriodPrompt(rows, docs, { from: localDate(since), to: localDate(now) });
  log(`${period} rows=${rows.length} docs=${docs.length}`);
} else {
  rows = collectToday(config.factsDir, now);
  // 整理者需要两样参照，否则判断不了「这条是不是已经记过」：
  //   1. 最近写入的长期记忆（/v1/recent，比 /v1/search 稳——没有可靠的实体抽取就别硬搜）
  //   2. 最近的决定（40-decisions 最近 5 条，避免把已定的事当待办再整理一遍）
  const refs = {
    longMemories: await recentLongMemories(readRootToken()),
    decisions: recentDecisions(config.memoriesDir),
  };
  prompt = buildPrompt(rows, config.memoriesDir, refs);
  log(`today rows=${rows.length} longRefs=${refs.longMemories.length} decisions=${refs.decisions.length}`);
}

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
let sessionId;
try {
  sessionId = await ensureConsolidationSession(api, workspacePath);
  log(`session=${sessionId}`);
  const startedAt = Date.now();
  const reply = await promptAndWait(api, sessionId, prompt);
  log(`done ms=${Date.now() - startedAt} chars=${reply.length}`);
  log(`reply: ${reply.replace(/\s+/g, ' ').slice(0, 400)}`);
} catch (error) {
  log(`failed: ${error?.message ?? error}`);
  // 脚本放弃等结果了，但 DSH 里的那个 turn 还在跑、还会继续写记忆。
  // 不停掉它，下一次重试就会再整理一遍——2026-10-27 实测库里因此多了一整套重复条目。
  if (sessionId) {
    try {
      await api.stopSessionWork(sessionId);
      log(`已停止会话 ${sessionId} 的在途回合`);
    } catch (stopError) {
      log(`停止会话失败: ${stopError?.message ?? stopError}`);
    }
  }
  process.exit(4);
}
