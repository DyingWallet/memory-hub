#!/usr/bin/env node
/**
 * 真实 DSH 会话的 e2e：验证 `dsh-memory` 插件确实把主会话的消息上报进了 memd。
 *
 * 这是 TODO 第 9 条里「仍靠手动清单」的那一段。手动清单是：
 * 起会话 → 看 ingest 落库 → 看 review 提示。前两步这里自动做。
 *
 * 做法：建一个 `minimal` 会话（不能用 `pet-chat`，插件会跳过它）→ 发一条带随机
 * 标记的消息 → 轮询 memd 的短期记忆，看标记有没有出现。
 *
 * 会真的调用一次模型，所以**不进 `pnpm test`**；单独跑：
 *
 *   node scripts/e2e-dsh-session.mjs
 *   node scripts/e2e-dsh-session.mjs --preset standard
 *
 * 退出码：0 = 通过，1 = 失败（DSH 不可达、建会话失败、或 30 秒内没等到 ingest）。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NodeApiClient, unwrap } from '../../qq-bridge/src/dsh-client.js';
import { resolveDshBaseUrl } from '../../qq-bridge/src/lib/dsh-endpoint.mjs';

const args = process.argv.slice(2);
const presetIndex = args.indexOf('--preset');
const PRESET = presetIndex >= 0 ? args[presetIndex + 1] : 'minimal';
const WORKSPACE = 'D:/deepseek_workspace';
const MEMD = 'http://127.0.0.1:8787';
const TOKEN_FILE = process.env.MEMD_TOKEN_FILE ?? join(homedir(), '.dsh', 'memory-token');
const WAIT_MS = 30_000;
const POLL_MS = 1500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function step(text) {
  console.log(text);
}

function fail(text, error) {
  console.error(`FAIL: ${text}${error ? ` — ${error}` : ''}`);
  process.exit(1);
}

async function searchMemd(query) {
  let token = '';
  try {
    token = readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    fail(`读不到 memd 令牌：${TOKEN_FILE}`);
  }
  const response = await fetch(`${MEMD}/v1/search`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, k: 5, scene: 'main' }),
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) fail(`memd search HTTP ${response.status}`);
  const data = await response.json();
  return Array.isArray(data.results) ? data.results : [];
}

async function main() {
  // 1. 找 DSH（桌面版每次重启换端口）：先信 DSH_WEB_URL，不通再动态发现。
  //    沙箱里 tasklist 被禁，动态发现会拿不到端口，所以环境变量这条路不能省。
  const configured = String(process.env.DSH_WEB_URL ?? '').trim();
  let endpoint = { reachable: false, url: '', candidates: [] };
  for (const candidate of configured ? [configured, ''] : ['']) {
    endpoint = await resolveDshBaseUrl(candidate, { discover: true, timeoutMs: 600 });
    if (endpoint.reachable) break;
  }
  if (!endpoint.reachable) fail(`DSH 不可达（候选：${(endpoint.candidates ?? []).join(', ')}）`);
  step(`[1/4] DSH ${endpoint.url}${endpoint.discovered ? '（自动发现）' : ''}`);

  // 2. 建会话
  const api = new NodeApiClient(endpoint.url);
  await api.ensureAuth();
  const workspace = unwrap(await api.workspace.create({ path: WORKSPACE }), 'workspace/create');
  const workspaceId = workspace?.workspace?.workspaceId;
  if (!workspaceId) fail('workspace/create 没有返回 workspaceId');

  const created = unwrap(await api.sessions.create({ workspaceId, agentPreset: PRESET }), 'session/create');
  const sessionId = created?.sessionId;
  if (!sessionId) fail('session/create 没有返回 sessionId');
  step(`[2/4] session=${sessionId}（preset ${PRESET}）`);

  if (PRESET === 'pet-chat') {
    fail('pet-chat 会话会被 dsh-memory 插件主动跳过（由 pet-brain 自己上报），换一个 preset');
  }

  // 3. 发一条带随机标记的消息。不看模型回复——只验证用户消息有没有被上报。
  const marker = `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  step(`[3/4] 发送标记 ${marker}`);
  try {
    unwrap(
      await api.sessions.prompt({
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: `这是一个自动化测试标记，请只回复「收到」。标记：${marker}` }],
      }),
      'session/prompt',
    );
  } catch (error) {
    // 插件在 agent/pre-step 就上报，模型这一轮失败不影响 ingest。
    step(`      （prompt 返回错误，继续等 ingest：${error?.message ?? error}）`);
  }

  // 4. 轮询 memd
  const deadline = Date.now() + WAIT_MS;
  let found = null;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const hits = await searchMemd(marker);
    found = hits.find((hit) => String(hit?.render?.text ?? '').includes(marker));
    if (found) break;
    process.stdout.write('.');
  }
  if (!found) fail(`${WAIT_MS / 1000} 秒内没在 memd 里找到标记 ${marker}`);

  step('');
  step(`[4/4] 命中 ${found.id}`);
  step(`      stage=${found.stage ?? '?'} subject=${found.subject ?? '?'}`);
  step('');
  step(`PASS: 真实 DSH 会话（${PRESET}）的消息已由 dsh-memory 插件上报进 memd`);
  step(`      会话 ${sessionId} 保留着，可以在 DSH 里打开审计`);
}

main().catch((error) => {
  console.error(`FAIL: ${error?.stack ?? error}`);
  process.exit(1);
});
