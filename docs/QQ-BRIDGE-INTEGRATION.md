# qq-bridge 接入 memory-hub（127.0.0.1:8787）——源码侦察报告

> 侦察对象：`D:\deepseek_workspace\qq-bridge\`（v1.0.3，**只读**，本次未修改任何文件）
> 侦察时间：2026-10-23
> 目标：为桥接接入外部记忆服务确定**精确接入点**，给出最小侵入方案。
>
> **行号口径（重要）**：本文所有行号来自 LF 行号计数（`src/bridge.js` 共 **13138** 行，UTF-8、无 BOM、纯 `\n`）。
> 实测 PowerShell 的 `Get-Content` 对这个文件给出 12017 行（编码/换行处理导致的行号漂移），
> **不要用 `Get-Content` 的行号定位**；请用支持 LF 的工具（ripgrep / 编辑器）或全文搜索。
>
> 标注约定：**【确认】** = 已读源码逐行核实；**【推测】** = 基于源码的推断，未运行验证。

---

## 0. 结论速览

| 问题 | 结论 | 置信 |
|---|---|---|
| 入口 | 无 `main` 字段；`npm start` = `node src/bridge.js`；单文件 13138 行，无 TS/打包步骤，直接跑 ESM JS | 【确认】 |
| 唤醒构造 | `buildWakePromptV2Core(key, reason)` @ `src/bridge.js:11074`；拼接式模板在 **11125**；实际投递前在 **9972** 二次重建（11242 构建的那份被丢弃） | 【确认】 |
| 工具注册 | 不在 bridge.js，而在 **`src/mcp-snowluma-safe.js`**：`server.tool(name, desc, zodShape, handler)`；handler 走 `agentApi()` 打桥接 `:3100` | 【确认】 |
| 会话 key | `convKey(kind,id)` = `` `${kind}:${id}` `` @ 1317；`canonicalV2Key` @ 1470 只收 `group:正整数 / private:正整数` | 【确认】 |
| 写入路径 | `POST /api/socialV2/memory-append` @ 7298 → `appendMemoryV2` @ 9584 → `saveSocialV2State` @ 9321 落 `state/social-v2.json` | 【确认】 |
| 配置 | `loadConfig()` @ 688，**手写默认值 + 浅 spread + 少数深合并**，无 JSON Schema/zod 校验；新段插在 1098–1100 之间 | 【确认】 |
| 运行时 | node `v24.21.0`（DSH 自带），`"type":"module"` → 可直接 `import` 一个 `dist/*.mjs` 产物 | 【确认】 |
| 最小侵入 | 1 个新模块 `src/memory/memory-bridge.js` + 唤醒注入（11074/11125/9972）+ 工具注册（mcp 文件 3 处）+ 写入镜像（7311） | 【方案】 |

---

## 1. 入口与模块结构

### 结论

- **没有 `main` 字段**，也没有 `bin`。入口由脚本硬编码：`package.json:12` → `node src/bridge.js`；实际启动器 `start-bridge.ps1:89-90` 用固定 node 路径执行 `src\bridge.js`。
- `"type": "module"`（`package.json:7`）→ `src/*.js` 全部是 **ESM**，扩展名是 `.js` 不是 `.mjs`（只有少数新模块用 `.mjs`，两种混用都合法）。
- **没有构建步骤**：无 `tsconfig*.json`、无 esbuild/rollup/vite/webpack/babel，`node_modules/typescript` 不存在，`scripts/` 里只有打包/发布脚本（`build-release.mjs` 等）。改源码 = 立即生效（重启进程即可）。
- 运行时结构：`bridge.js` 是**单文件巨型闭包**——几乎所有业务函数都嵌在 `async function main()` 里（`bridge.js:1486` 开始，`main().catch(...)` 在 **13135**）。
  这对接入很关键：**新增逻辑要么写成独立模块在文件顶部 import，要么写在 main 闭包内**（闭包内能直接拿 `cfg`、`log`、`getSocialV2State`）。
- 辅助模块在 `src/*.js`、`src/social/`、`src/lib/`、`src/admin/`、`src/core/`；`interface-platform/` 是另一套独立的 OneBot 连接平台，**QQ 桥接主链路不走它**。

### 证据

`qq-bridge/package.json:7,12`：
```json
  "type": "module",
  ...
    "start": "node src/bridge.js",
```

`qq-bridge/src/bridge.js:1-7`：
```js
// QQ ↔ DeepSeek Harness 桥接主程序。
// ...
// 用法：node src/bridge.js （先编辑 ../config.json）
```

`qq-bridge/src/bridge.js:1486-1487`（main 起始）与 `13135-13138`（入口调用）：
```js
async function main() {
  const cfg = loadConfig();
...
main().catch((error) => {
  console.error('[bridge] 启动失败:', error);
  process.exit(1);
});
```

`qq-bridge/start-bridge.ps1:25,89-90`：
```powershell
$nodeExe    = 'D:\Software\dsh\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
...
$proc = Start-Process -FilePath $nodeExe `
    -ArgumentList (Join-Path $root 'src\bridge.js') `
```

模块体量（`Get-ChildItem src`）：`bridge.js` 747,526 B，其余单文件最大是 `mcp-snowluma-safe.js`（90 KB）与 `dsh-client.js`（47 KB）。

---

## 2. 唤醒提示构造（buildWakePromptV2Core）

### 结论

- 函数签名（**同步**函数，嵌在 main 闭包内）：
  ```js
  function buildWakePromptV2Core(key, reason)   // bridge.js:11074
  ```
- 它只被 `buildWakePromptV2(key, reason)`（**11052**）调用一次：
  ```js
  const text = buildWakePromptV2Core(key, reason);   // 11055
  return relays.length ? `${text}\n\n${ownerRelayPromptBlock(relays)}` : text;
  ```
- `buildWakePromptV2` 有两个调用点，**实际投递给模型的只有第二个**：
  1. `sendWakePromptV2` @ **11242** → 结果传给 `deliverPrompt(key, promptText, {wakeReason})`；
  2. `deliverPromptNow` @ **9972** → `if (opts.wakeReason) promptText = buildWakePromptV2(key, opts.wakeReason);`
     **因为所有唤醒都带 `wakeReason`，9972 会无条件覆盖 11242 构建的文本**（11242 那份对投递无效，只在日志/流程里存在）。这是本次侦察最容易被坑的一点。

  【确认】依据：`deliverPrompt`（10019-10029）把 `promptText` 入队，`processPromptQueue`（10031-10042）把它交给 `deliverPromptNow`，而 9966-9978 在 `opts.wakeReason` 为真时重建。

- **输入**（全部来自闭包，无显式参数）：`cfg`、`key`、`reason`、`st = getSocialV2State(key)`（会话记忆/状态）、`roleState = readRoleState()`、`selfDisplayName/selfUserId`、`stickerEntries`、`ext.peopleBlockFor(key, presentIds)`（人物档案）。
  **没有** `scene` 概念——scene 需要我们从 `key` 现算。
- 当前拼接顺序（**11125** 一行拼完）：
  ```
  roleLine(角色) + identityLine(自身身份) + tokenLine(会话令牌) + initialPromptLine(仅 bootstrap)
  + antiAiLine(反AI味) + proactiveLine(积极性) + stickerLine(表情策略)
  + replyLine(首回复节奏) + statusLine(此刻状态) + wakeLine(当前唤醒)
  + memoryLine(轻量记忆：话题/想说/印象) + peopleLine(在场人物)
  + participationLine(参与度) + preSleepLine(沉睡前等待)
  ```
  然后按 `reason` 追加结尾段（bootstrap 11126 / timeout 11129 / replyCheck 11132 / proactiveCheck 11135 / memberJoin 11138 / ownerRelay 11142 / poke 11145 / 默认 11148）。
- **【长期记忆】/【相关记忆】的精确插入点**：`memoryLine` 之后、`peopleLine` 之前，即 11080 与 11083 之间，并在 11125 的拼接串里加一项。理由：memory 属于"关于这段关系/这个群的既有认知"，应紧跟既有【进行中的话题】【对群友的印象】；【在场人物】是"这一轮谁在"，语义上在其后。

### 证据

`qq-bridge/src/bridge.js:11052-11057`：
```js
  function buildWakePromptV2(key, reason) {
    const relays = ownerRelayStore.peek(key);
    if (reason === 'ownerRelay' && !relays.length) reason = '管理员托付已过期，按平常判断即可';
    const text = buildWakePromptV2Core(key, reason);
    return relays.length ? `${text}\n\n${ownerRelayPromptBlock(relays)}` : text;
  }
```

`qq-bridge/src/bridge.js:11074-11084`（签名 + 记忆与人物两段）：
```js
  function buildWakePromptV2Core(key, reason) {
    const roleState = readRoleState();
    const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
    const st = getSocialV2State(key);
    const tokenLine = `【会话令牌】${st.agentToken}（调用二代状态工具时请在参数中带上此令牌）\n\n`;
    const memoryText = formatMemoryV2(st);
    const memoryLine = memoryText ? `${memoryText}\n\n` : '';
    // v0.3.0 在场人物：只注入本轮未读/最近消息里出现的人，并在注入时按共享策略过滤可见范围。
    const presentIds = [...(st.unread || []), ...(st.recentMessages || []).slice(-6)].filter((m) => m && !m.isSelf).map((m) => m.userId).filter(Boolean);
    const peopleText = ext.peopleBlockFor(key, presentIds);
```

`qq-bridge/src/bridge.js:11125`（拼接顺序）：
```js
    const base = roleLine + identityLine + tokenLine + initialPromptLine + antiAiLine + proactiveLine + stickerLine + replyLine + statusLine + wakeLine + memoryLine + peopleLine + participationLine + preSleepLine;
```

`qq-bridge/src/bridge.js:9966-9978`（实际投递点重建）：
```js
    if (opts.wakeReason) {
      if (wakeBlocked()) return skipWake();
      // Build only after session creation: retries may rotate the token, and an
      // offline queue may have received more messages since this wake was queued.
      wakeState = getSocialV2State(key);
      wakeToken = wakeState.agentToken;
      promptText = buildWakePromptV2(key, opts.wakeReason);
```

`qq-bridge/src/bridge.js:11242`（另一处构建，结果会被 9972 覆盖）：
```js
    const promptText = buildWakePromptV2(key, reason);
```

> 另外 `buildWakeReminderPromptV2`（**11151-11159**）是"回合未收尾"的提醒，**不注入任何记忆**；如果希望它也有长期记忆，是第二个可选注入点（不影响主链路）。

---

## 3. 工具注册（模型可用的 qq_* 工具）

### 结论

- **qq_* 工具不是 DSH 原生 tool，而是桥接自己的 MCP server 暴露的 stdio 工具**：
  - 实现：`src/mcp-snowluma-safe.js`（1537 行），`new McpServer({ name: 'snowluma', version: '1.0.3' })`（**296**）。
  - 注册：`server.tool(name, description, zodShape, handler)`。schema 用 **zod**（`z` 从 `zod` import，第 15 行），不是 TypeBox/JSON Schema 手写。
  - handler 不直接实现业务：统一 `await agentApi('/api/socialV2/...', {...})`（**153-170**）打桥接控制台 `http://127.0.0.1:${consolePort}`（默认 3100，**107-110**），带 `x-console-token` + `x-agent-call: 1` + `x-agent-token`（**176-191**）。业务逻辑在 `bridge.js` 的 HTTP 端点里。
- 模型看到的工具名 = `mcp__snowluma__<name>`（DSH MCP 客户端加命名空间前缀）。**preset 白名单不用改**：`plugins/qq-agent-presets/qq-tool-restrict.mjs:165-169` 用的是前缀 `mcp__snowluma__` 放行，新工具自动被允许。
- 注册期开关：`TOOL_CONFIG_FLAGS`（**310-357**）把工具名映射到 `cfg.socialV2.tools.<flag>`；`server.tool` 被就地包装（**358-369**），`flag === false` 时**根本不注册**（省 token，见 298-309 长注释）。新工具必须在这里登记，否则控制台显示关闭也照样出现在模型 schema 里。
- 添加一个工具 = **3 处**：① `TOOL_CONFIG_FLAGS` 加映射；② `server.tool(...)` 定义；③ `bridge.js` 加 HTTP 端点 + `socialV2.tools` 默认值 + `qq_get_prompt` 的 `toolMap`（**5171-5207**，`memory` 项在 **5188**），否则模型在 `qq_get_prompt` 里看不到它的存在。
- **改完必须重启 DSH**（工具清单在 DSH 启动时读取，见 304-305 与 `docs/guides/CONFIGURATION.md:5`），仅重启桥接不够。

### 现成模板（`qq_memory_query`，完整定义）

`qq-bridge/src/mcp-snowluma-safe.js:911-929`：
```js
server.tool(
  'qq_memory_query',
  '查看当前会话的轻量记忆：进行中的话题、你想说但还没说的话、对群友的印象（只读）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).optional().describe('可选：只看某一类记忆')
  },
  async ({ key, token, category }) => {
    try {
      const q = new URLSearchParams({ key });
      if (category) q.set('category', category);
      const data = await agentApi(`/api/socialV2/memory?${q.toString()}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆读取失败：${error?.message ?? error}` }], isError: true };
    }
  }
);
```

写操作模板（带 body）：`qq_memory_append`，**881-909**（`agentApi('/api/socialV2/memory-append', { method: 'POST', body: JSON.stringify({...}), headers: { 'x-agent-token': token } })`）。

### 映射链证据

`qq-bridge/src/mcp-snowluma-safe.js:145-170`：
```js
async function agentApi(path, init = {}) {
  const timeoutMs = init.timeoutMs || 15000;
  ...
  const res = await fetch(`${agentApiBase()}${path}`, { ...rest, headers, signal: AbortSignal.timeout(timeoutMs) });
```

`qq-bridge/src/mcp-snowluma-safe.js:310-327, 358-369`：
```js
const TOOL_CONFIG_FLAGS = {
  ...
  qq_memory_append: 'memory',
  qq_memory_query: 'memory',
  qq_memory_remove: 'memory',
  qq_memory_clear: 'memory',
...
{
  const registerTool = server.tool.bind(server);
  server.tool = (name, ...rest) => {
    const flag = TOOL_CONFIG_FLAGS[name];
    if (flag && cfg.socialV2?.tools?.[flag] === false) {
      disabledTools.push(`${name}(${flag})`);
      return undefined;
    }
    return registerTool(name, ...rest);
  };
}
```

MCP 注册进 DSH（已部署到 `C:\Users\70903\.dsh\profiles\desktop\cordis.patch.yml`，由 `scripts/setup-dsh.mjs:147-171` 维护）：
```js
'mcp-snowluma': { serverName: 'snowluma', script: path.join(REPO_ROOT, 'src', 'mcp-snowluma-safe.js'), toolCallTimeoutMs: 725000 },
```

`qq-bridge/plugins/qq-agent-presets/qq-tool-restrict.mjs:165-169`（前缀白名单，新工具免改）：
```js
const SAFE_PREFIXES = [
  'mcp__snowluma__',
  'mcp__snowluma-host__',
  'mcp__web-search-safe__',
]
```

---

## 4. 会话 key / scene / ownerQQ

### 结论

- **key 格式只有两种**：`group:<群号>`、`private:<QQ号>`。生成函数是一行箭头函数：
  ```js
  const convKey = (kind, id) => `${kind}:${id}`;   // bridge.js:1317
  ```
  入口：`handleIncoming(kind, id, event, cfg)`（**11683**）第一行 `const key = convKey(kind, id);`（**11684**）；
  私聊来源 `event.user_id`（**12842**），群聊来源 `event.group_id`（**12847**）。
  也就是说 **private 的 id 永远是"对方"**（私聊对端 = 发送者），owner 私聊即 `private:<ownerQQ>`。
- 规范化/校验：`canonicalV2Key(key)`（**1470-1476**）只接受 `^(group|private):(\d+)$`，去前导零，非安全整数拒绝；`getSocialV2State`（**9150-9196**）入口强制 canonical，非法 key 抛 400。
- **拿当前群号/QQ 号的现成方式**：拆 key。
  ```js
  const [kind, id] = key.split(':')   // kind ∈ {group, private}，id 是字符串数字
  ```
  闭包里没有独立的 `currentGroupId` 变量——所有函数都只带 `key`。写 scene 映射就在 `buildWakePromptV2Core` / 端点里拆 key（【确认】全部调用点都只传 key）。
- **ownerQQ 判断**：`cfg.ownerQQ`（number，`normalizeOwnerQQ` @ **670-679** 规范化），判定式统一写成
  ``key === `private:${String(cfg.ownerQQ ?? '')}` ``（例：**2977** 的 `modeAllowed`、**9693**、**3144** `ownerKeyOf()`；消息级另有 `String(event.user_id) === String(cfg.ownerQQ ?? '')` @ **11689**）。
- **scene 建议映射**（与 `memory-hub/docs/IMPLEMENTATION.md:439-445` 一致）：`group:<id>` → `qq:group:<id>`；`private:<ownerQQ>` → `qq:owner`；其它 `private:<qq>` → `qq:private:<qq>`。scene 只能由桥接从 key 计算，**不能由模型传入**。

### 证据

`qq-bridge/src/bridge.js:1317`：
```js
const convKey = (kind, id) => `${kind}:${id}`;
```

`qq-bridge/src/bridge.js:1470-1476`：
```js
function canonicalV2Key(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return `${m[1]}:${id}`;
}
```

`qq-bridge/src/bridge.js:11683-11689`：
```js
  async function handleIncoming(kind, id, event, cfg) {
    const key = convKey(kind, id);
    ...
    if (kind === 'private' && ext.adminEnabled()
        && String(event.user_id) === String(cfg.ownerQQ ?? '') && String(id) === String(cfg.ownerQQ ?? '')) {
```

`qq-bridge/src/bridge.js:12842,12847`：
```js
    try { await handleIncoming('private', event.user_id, event, cfg); } catch (error) { ... }
    try { await handleIncoming('group', event.group_id, event, cfg); } catch (error) { ... }
```

`qq-bridge/src/bridge.js:2973-2981`：
```js
  function modeAllowed(key, kind, id, cfg, mode) {
    if (mode === 'closed-agent') {
      // 封闭 agent 模式：仅 owner 私聊
      return key === `private:${String(cfg.ownerQQ ?? '')}`;
    }
```

---

## 5. 写入路径（qq_memory_append 的实现与落盘结构）

### 结论

- 调用链：`qq_memory_append`（MCP，mcp-snowluma-safe.js:881-909）
  → `POST /api/socialV2/memory-append`（bridge.js **7298-7314**）
  → `appendMemoryV2(st, category, content, extra)`（**9584-9651**）
  → `saveSocialV2State()`（**9321-9354**）→ 原子写 `state/social-v2.json`（路径常量 `SOCIAL_V2_FILE` @ **110**）。
- **鉴权三道闸**（每个 v2 端点同款，新端点照抄即可）：`agentTokenOk(key, x-agent-token)`（**7307**，实现 **3622-3626**）→ `v2SessionAllowed(key)`（**7308**，= `isSessionAllowedInCurrentMode`，**3643**）→ `v2ToolEnabled('memory')`（**7309**，**3592-3594**）。注意写法是 `if (header && !ok)`，**完全不带头就跳过**；真正防 confused deputy 的是全局 `x-agent-call` 关卡（**3783-3799**，对 `/api/socialV2/` 前缀在无 token 时一律 403）。
- **social-v2.json 的结构（字段名逐字确认）**：
  ```jsonc
  {
    "paused": false,
    "conversations": {
      "group:10001": {
        "wakeConfig": {...}, "recentMessages": [...], "unread": [...],
        "activeTopics": [ { "text", "lastMentionAt", "participants", "pendingQuestion" } ],
        "pendingThoughts": [ { "text", "createdAt", "expiresAt", "motivation" } ],
        "memberImpressions": { "<群友名字>": { "traits": [..], "interactionCount", "lastSeenAt" } },
        "ownerRules": [...], "agentToken": "...", ...
      }
    }
  }
  ```
  上限：`activeTopics` 20（**9613**）/ 落盘 50（**9343**）；`pendingThoughts` 20（**9629**）/ 落盘 50（**9344**）；`memberImpressions` 50 条按 `lastSeenAt` 淘汰（**9642-9648**）。
- **镜像写的最佳落点：`memory-append` 端点内，`appendMemoryV2(...)` 之后、`sendJson(...)` 之前**，即 **7311 与 7312 之间**。这里同时拥有 `key`（→scene）、`category`、`content`、`extra` 和已落盘的 `st`；**`appendMemoryV2` 本身拿不到 key**，若在 9650 那层镜像就得多改签名。
- 同一文件还有另外三个写端点，是否镜像需产品决策（建议 v1 只镜像 append，写进文档）：
  `memory-update` **7315-7380**、`memory-remove` **7408-7433**、`memory-clear` **7434-7450**。
- 写操作**必须异步、失败只记日志**（`memory-hub/docs/IMPLEMENTATION.md:470-483`）：HTTP 端点里 `void mirrorWrite(...).catch(() => {})`，绝不能让 8787 不可用拖慢/阻断 QQ。

### 证据

`qq-bridge/src/bridge.js:7298-7314`：
```js
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-append') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const content = String(body.content ?? '').trim();
          const extra = body.extra && typeof body.extra === 'object' ? body.extra : {};
          if (!key || !category || !content) { sendJson({ ok: false, error: 'key/category/content 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (category === 'memberImpression' && !String(extra.target || '').trim()) { sendJson({ ok: false, error: 'memberImpression 需要 extra.target 指定群友名字' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_append' }, 403); return; }
          const st = getSocialV2State(key);
          appendMemoryV2(st, category, content, extra);
          sendJson({ ok: true, key, category, content, memory: formatMemoryV2(st) });
          return;
        }
```

`qq-bridge/src/bridge.js:9606-9611`（activeTopics 字段）：
```js
        st.activeTopics.push({
          text: truncateText(text, 200),
          lastMentionAt: Date.now(),
          participants: Array.isArray(extra.participants) ? extra.participants.map((p) => redactKnownTokensOnly(String(p))).slice(0, 10) : [],
          pendingQuestion: redactKnownTokensOnly(String(extra.pendingQuestion || '')).slice(0, 200)
        });
```

`qq-bridge/src/bridge.js:9622-9627`（pendingThoughts 字段）：
```js
        st.pendingThoughts.push({
          text: text.slice(0, 200),
          createdAt: Date.now(),
          expiresAt: Date.now() + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000),
          motivation: redactKnownTokensOnly(String(extra.motivation || 'curiosity')).slice(0, 50)
        });
```

`qq-bridge/src/bridge.js:9637-9641`（memberImpressions 字段）：
```js
      st.memberImpressions[target] = {
        traits,
        interactionCount: (Number(old.interactionCount) || 0) + 1,
        lastSeenAt: Date.now()
      };
```

`qq-bridge/src/bridge.js:9343-9346`（落盘字段）：
```js
          activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-50) : [],
          pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.slice(-50) : [],
          memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {},
          ownerRules: normalizeRules(st.ownerRules),
```

---

## 6. 配置读取（新增 `config.memory` 的落点）

### 结论

- 桥接侧：`loadConfig()` @ **688-1101**，在 `main()` 第一行调用（**1487**），**只加载一次**（无热重载；个别控制台端点会就地改 `cfg` 并写回文件）。
- **没有 schema 校验**：手写默认值对象 `cfg = { ... }`（**692-917**），每个段用 `...(file.xxx ?? {})` 浅合并；只有少数地方做深合并（`cfg.socialV2.tools` **921-961**、`socialV2.voice` **970-985**、`socialV2.sticker` **988-1010**、`continuity.joinEvents` **1070**、`admin.maxElevatedMs` **1096**）。**不做类型/枚举校验**（唯一例外是 `continuity.sharePolicy` 非法值告警并回落，**1071-1074**）。
- 新增段的最省事落点：**`cfg.crossGroup = ...`（1098）之后、`return cfg;`（1100）之前**加一段，照抄 `continuity/admin` 的写法：
  ```js
  cfg.memory = {
    enabled: false,
    endpoint: 'http://127.0.0.1:8787',
    tokenFile: 'state/memory-bridge.token',
    recallK: 3,
    recallMaxChars: 800,
    recallTimeoutMs: 800,
    writeMirror: true,
    ...(file.memory ?? {}),
  };
  if (cfg.memory.enabled && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(String(cfg.memory.endpoint))) {
    log('⚠️ memory.endpoint 必须是本机回环地址，已关闭 memory');
    cfg.memory.enabled = false;
  }
  ```
  （上面这段是**方案**，不是现有代码。）
- 需要同步更新的位置：`config.example.json`（给模板 + 注释）、`docs/guides/CONFIGURATION.md`（新增 `## memory` 一节，现有文档结构见该文件 1-5 行与各 `##` 小节）。
- **MCP 进程是独立进程、独立配置加载**：`src/mcp-snowluma-safe.js:26-40` 每次调用都 `fs.readFileSync(config.json)` 重新读（`getConfig()`），所以 MCP 侧读 `config.memory` **不需要重启**就能生效；桥接侧要重启。
- token 建议放 `state/memory-bridge.token` 文件而不是 config.json（config.json 已有 ACL 但明文 token 仍不理想；`state/console-token` 是同样做法，见 mcp-snowluma-safe.js:111-130）。

### 证据

`qq-bridge/src/bridge.js:688-717`（默认值 + 浅合并风格）：
```js
function loadConfig() {
  const p = path.join(ROOT, 'config.json');
  const file = readJsonSafe(p, null, true);
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error(`配置格式错误：${p}`);
  const cfg = {
    dsh: {
      ...
      ...(file.dsh ?? {})
    },
    snowluma: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '', ...(file.snowluma ?? {}) },
```

`qq-bridge/src/bridge.js:915-921`（外层 spread 会覆盖默认值，故 tools 单独深合并）：
```js
      ...(file.socialV2 ?? {})
    }
  };

  // socialV2.tools 需要与默认值深度合并：旧 config.json 若缺少新增工具开关，
  // 不能因为外层 spread 覆盖而丢失默认开关。
  cfg.socialV2.tools = {
```

`qq-bridge/src/bridge.js:1097-1100`（新段插入位置）：
```js
  // 跨群协作：默认关闭；链接是有向的、按能力授权（见 src/social/cross-group.js）。
  cfg.crossGroup = { enabled: false, links: [], ...(file.crossGroup ?? {}) };

  return cfg;
}
```

`qq-bridge/src/mcp-snowluma-safe.js:26-40`（MCP 侧每次重读 config）：
```js
function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}
const cfg = loadConfig();
function getConfig() { return loadConfig(); }
```

---

## 7. 依赖与运行时

### 结论

- **谁启动桥接**：`Startup\qq-stack.vbs`（登录自启）→ `qq-bridge\qq-stack.vbs`（WScript 隐藏窗口）→ `start-stack.ps1` → 若 3100 未监听则 `powershell -File start-bridge.ps1` → `node src/bridge.js`。
  手动方式：`start-bridge.bat` / `start.bat`（后者带 `:loop` 崩溃重启，`node src/bridge.js`）。
- **哪个 node**：固定绝对路径 `D:\Software\dsh\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`（`start-bridge.ps1:25`）。实测 **v24.21.0**。系统 PATH 里没有 `node`。
  MCP server 也用同一个 node（`scripts/setup-dsh.mjs:148` 用 `process.execPath`；已部署的 `cordis.patch.yml:53` 是同一个绝对路径）。
- **ESM**：`package.json:7` `"type": "module"` → 直接 `import x from './lib/foo.mjs'`（或 `.js`）即可，**不需要**动态 `import()` 兜底。Node 24 自带 `fetch`、`AbortSignal.timeout`、`node:sqlite`。
- **memory-hub 产物的导入方式**：桥接里**不要**引 TS 源码；从 `memory-hub/packages/adapter-qq/dist/memory-client.mjs` 导入编译产物（`IMPLEMENTATION.md:421`）。
  由于 P0 还没开始写，产物此刻**不存在** → 建议桥接侧封装层用「运行时动态 import + 失败即禁用」，让桥接在 memory-hub 未部署时完全不受影响：
  ```js
  // src/memory/memory-bridge.js（新文件，方案）
  let mod = null;
  try { mod = await import(pathToFileURL(path.join(ROOT, '..', 'memory-hub', 'packages', 'adapter-qq', 'dist', 'memory-client.mjs')).href); } catch {}
  ```
  【确认】node 24 支持顶层 await 与动态 import；【推测】具体导出名待 adapter-qq 定稿后对齐。
- **不可用 `src/safe-fetch.js` 访问 8787**：该模块明确禁止环回/私网地址（`safe-fetch.js:1-7` 注释 + 校验逻辑）。memory client 请直接用全局 `fetch` + `AbortSignal.timeout(...)`。
- `engines.node >= 22.13.0`（`package.json:8-10`）；依赖只有 `@snowluma/sdk`、`@deepseek-ai/dsh-host-apiproxy`、`@modelcontextprotocol/sdk`、`zod`、`js-yaml`、`@deepseek-ai/schemastery`。

### 证据

`qq-bridge/qq-stack.vbs:1-4`：
```vb
' qq-stack hidden launcher: starts DSH / SnowLuma / qq-bridge without windows.
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""D:\deepseek_workspace\qq-bridge\start-stack.ps1""", 0, False
```

`qq-bridge/start-stack.ps1:162,183-190`（3100 探测 → 起 start-bridge.ps1）：
```powershell
$bridgeUp = Test-Port 3100
...
$ps = Join-Path $root 'start-bridge.ps1'
...
Start-Process -FilePath 'powershell.exe' -ArgumentList $args -WindowStyle Hidden | Out-Null
```

`qq-bridge/src/safe-fetch.js:1-7`：
```js
// 只读 HTTP(S) 安全抓取工具：供 qq-bridge / MCP 共用。
// 设计目标与 mcp-web-search-safe 一致：
// - 仅 http/https
// - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址
```

实测（本次侦察命令输出）：
```
node v24.21.0
node exists: True
D:\Software\dsh\resources\runtime\primary-runtime\dependencies\node\bin\node.exe
```

---

## 8. 最小侵入接入方案（1 个新模块 + 3 处调用）

> 前提：**只读侦察阶段不改任何文件**。以下为落地时的精确落点；所有行号按 13138 行口径。
> 原则：桥接在 memory-hub 不可用时行为完全不变（静默跳过）；不改 `state/` 结构、不改 `social-v2.json` 格式、不动 ACL。

### 8.1 新模块（唯一新增文件）

`D:\deepseek_workspace\qq-bridge\src\memory\memory-bridge.js`（≈100 行，ESM）

职责（全部在本模块内，桥接只调两个函数）：

| 导出 | 作用 | 关键约束 |
|---|---|---|
| `createMemoryBridge({ cfg, log, root })` | 读 `cfg.memory`；动态 import adapter 产物；读 token 文件；建 scene 映射 | 产物/服务缺失 → `enabled=false`，全 no-op |
| `memory.recallBlock(key, st)` | 用最近 1-2 条 `st.unread/recentMessages` 文本打 `POST /v1/recall`（或 `/v1/search`），渲染 `【长期记忆】…【相关记忆】- …` | 超时 `recallTimeoutMs`（默认 800ms）+ 每 key 5s 缓存；**任何异常返回 `''`**；总长 ≤ `maxChars` |
| `memory.mirrorWrite(key, category, content, extra)` | `POST /v1/write`（mapping 见下） | fire-and-forget，`void ... .catch(log)`，永不 await 到响应路径 |

scene 映射（放进模块，模型不可传）：
```js
function sceneOf(key, ownerQQ) {
  const [kind, id] = key.split(':');
  if (kind === 'group') return `qq:group:${id}`;
  return String(id) === String(ownerQQ ?? '') ? 'qq:owner' : `qq:private:${id}`;
}
```

镜像 body（对齐 `IMPLEMENTATION.md:470-481`，含 `idempotency_key` 防重）：
```js
{ kind: category === 'memberImpression' ? 'qq-impression' : 'qq-topic',
  text: content, audience: [scene], privacy: category === 'memberImpression' ? 'personal' : 'normal',
  source: 'qq', scene, idempotency_key: `${scene}:${category}:${hash(content + (extra.target||''))}` }
```

### 8.2 落点 ①：唤醒注入（改 3 个函数、共 4 行）

| # | 文件:行 | 现状 | 改动 |
|---|---|---|---|
| A1 | `src/bridge.js:25` 之后、98 行之前（import 区） | — | 加 `import { createMemoryBridge } from './memory/memory-bridge.js';` |
| A2 | `src/bridge.js:2840` 附近（`const ext = createBridgeExtensions({` 之后） | ext 已就绪 | 加 `const memory = createMemoryBridge({ cfg, log, root: ROOT });` |
| A3 | `src/bridge.js:11074` | `function buildWakePromptV2Core(key, reason) {` | 改为 `function buildWakePromptV2Core(key, reason, memoryBlock = '') {` |
| A4 | `src/bridge.js:11080` 之后 | `const memoryLine = ...` | 加 `const longMemoryLine = memoryBlock ? `${memoryBlock}\n\n` : '';` |
| A5 | `src/bridge.js:11125` | `... + wakeLine + memoryLine + peopleLine + ...` | 改为 `... + wakeLine + memoryLine + longMemoryLine + peopleLine + ...` |
| A6 | `src/bridge.js:11052` | `function buildWakePromptV2(key, reason) {` | 增第三参数 `memoryBlock = ''`，并把 11055 改为 `buildWakePromptV2Core(key, reason, memoryBlock)` |
| A7 | `src/bridge.js:9972` | `promptText = buildWakePromptV2(key, opts.wakeReason);` | 改为先 `const memoryBlock = await memory.recallBlock(key, wakeState);` 再 `buildWakePromptV2(key, opts.wakeReason, memoryBlock)` |

> **只需改 9972**：11242 那份 prompt 在 9972 会被重建覆盖（见 §2），在那里注入是白做；若希望日志里也带记忆，可在 11242 也传同样的 block（会多一次 HTTP，用 5s 缓存吸收）。
> 若嫌改签名麻烦，备选方案 B：把 `buildWakePromptV2Core`/`buildWakePromptV2` 改成 `async` 并在内部 `await memory.recallBlock(...)`——影响面同样是 11055、9972、11242 三处，但 `deliverPromptNow`/`sendWakePromptV2` 本来都是 async，**无额外波及**。

### 8.3 落点 ②：工具注册（3 个文件位置）

| # | 文件:行 | 改动 |
|---|---|---|
| B1 | `src/bridge.js:792-825`（`socialV2.tools` 默认表）+ **921-961**（深合并默认表，两处都要加） | 加 `memoryRecall: true, memorySearch: true`（或复用 `memory` 开关） |
| B2 | `src/bridge.js:5188`（`qq_get_prompt` 的 `toolMap.memory`） | 值补上 ` / qq_memory_recall`，否则模型不知道有这个工具 |
| B3 | `src/bridge.js:7298` 之前（紧邻 memory-append 端点，**7297** 空行处） | 新增 `POST /api/socialV2/memory-recall`：三道鉴权照抄 7307-7309 → `const scene = ...`（在桥接内算） → `const block = await memory.recallBlock(key, st)` → `sendJson({ ok: true, scene, text: block })`；**不接受模型传 scene/endpoint** |
| B4 | `src/mcp-snowluma-safe.js:310-357` | `TOOL_CONFIG_FLAGS` 加 `qq_memory_recall: 'memoryRecall'`（新 flag 必须同时存在于 bridge.js 默认表，否则 `!== false` 恒真=PASS，但控制台看不到开关） |
| B5 | `src/mcp-snowluma-safe.js:911-929` 之后（紧跟 memory 四个工具） | 照抄 `qq_memory_query` 模板新增 `server.tool('qq_memory_recall', …)`、`qq_memory_search`（后者可直连 `/v1/search`，但更稳的是走桥接 `/api/socialV2/memory-search` 以复用 scene/鉴权） |

**不用改**：`plugins/qq-agent-presets/qq-tool-restrict.mjs`（`mcp__snowluma__` 前缀放行）、`scripts/setup-dsh.mjs`（MCP server 已注册）。
**必须做**：重启桥接（桥接侧）+ **重启 DSH**（MCP 工具清单，`mcp-snowluma-safe.js:304-305`）。

### 8.4 落点 ③：写入镜像（1 处）

| # | 文件:行 | 改动 |
|---|---|---|
| C1 | `src/bridge.js:7311-7312` 之间 | `appendMemoryV2(st, category, content, extra);` 之后加一行 `void memory.mirrorWrite(key, category, content, extra);`（模块内部自己 catch，返回 Promise 不 await） |

可选（建议 v2 再做）：`memory-update`（7379 前后）、`memory-remove`（7430 前后）、`memory-clear`（7447 前后）分别镜像 update/delete/clear；v1 只镜像 append，避免 delete 语义在服务端落地不一致。

### 8.5 配置与文档（同样不改运行时行为）

- `qq-bridge/config.example.json`：加 `memory` 段示例（默认 `enabled: false`）。
- `docs/guides/CONFIGURATION.md`：加 `## memory` 小节（表格列 `enabled/endpoint/tokenFile/recallK/recallMaxChars/recallTimeoutMs/writeMirror`）。
- 实际 `qq-bridge/config.json` 的修改：**需要非沙箱身份**（ACL 已收紧，见 `AGENTS.md` 第五节、`memories/50-knowledge/2026-10-22-qq-bridge-deployed.md`）。本会话是 workspace-write 沙箱，**不要尝试**。

### 8.6 工作量与风险

- 代码：新模块 ≈100 行；`bridge.js` 改动 ≈8 行（3 处）；`mcp-snowluma-safe.js` 改动 ≈40 行（1-2 个工具）。**总改动 < 200 行，无结构重排**。
- 风险清单：
  1. **唤醒延迟**：recall 必须硬超时（≤800ms）且带缓存，否则 DSH 首包会慢；服务不可用时 `AbortSignal.timeout` 抛错 → 返回 `''`。
  2. **隐私**：`memberImpression` 是 `privacy=personal`；群会话的 token 在服务端只能看 shared + 本群（`IMPLEMENTATION.md:555-561` 的隐私测试要覆盖 QQ 群）。
  3. **双重构建**：11242 与 9972 各构建一次 prompt（现存问题）；只在 9972 注入可避免双次 recall。
  4. **token 传递**：`x-agent-token` 是会话级凭据，不要写进 memory-hub 的请求体/日志；memory-hub 的 token 用独立文件。
  5. **重启顺序**：先起 `memd`（8787），再重启桥接，最后重启 DSH；反过来也能跑（桥接静默降级），只是新工具不出现。
  6. **`state/` 不可写**：任何"缓存写盘"都不要放 `state/`（ACL + 只读策略），recall 缓存只放进程内存。

---

## 9. 确认 / 推测 一览

### 源码确认（逐行核对）

- 入口 `package.json:12`、`"type":"module"` 同文件 7 行、无构建链（无 tsconfig、无 typescript 依赖）。
- `bridge.js` 共 13138 行（LF）；`main()` 于 1486 开始、13135 调用；业务函数（11074、9150、9321、9549、9584）均在 main 闭包内。
- `buildWakePromptV2Core(key, reason)` @ 11074；拼接 @ 11125；`buildWakePromptV2` @ 11052；调用点 9972、11242；9972 覆盖 11242。
- 工具由 `mcp-snowluma-safe.js` 用 `server.tool` + zod 注册（296、310-369、881-929）；handler → `agentApi`（145-170）→ 桥接 3100。
- 前缀白名单 `mcp__snowluma__`（qq-tool-restrict.mjs:165-169）；MCP 以 node 绝对路径 + `toolCallTimeoutMs: 725000` 注册（setup-dsh.mjs:150）；已部署 patch（`cordis.patch.yml:48-55`）。
- key 生成 1317、校验 1470、来源 11684/12842/12847；owner 判定 2977/11689。
- 写入链 7298 → 9584 → 9321；字段名 `text/lastMentionAt/participants/pendingQuestion`、`text/createdAt/expiresAt/motivation`、`traits/interactionCount/lastSeenAt`。
- 配置 688-1101、`return cfg` 1100；无 schema；MCP 侧每次重读（26-40）。
- 运行时 node v24.21.0（实测）、`start-bridge.ps1:25/89-90`、`start-stack.ps1:162/183-190`、`qq-stack.vbs`。
- `safe-fetch.js` 禁止环回（1-7）。

### 推测 / 待定（未运行验证）

- memory-hub 的 adapter 产物文件名与导出签名（`packages/adapter-qq/dist/memory-client.mjs`）——来自 `IMPLEMENTATION.md:421`，**代码尚未存在**。
- `/v1/recall` 的返回结构与失败语义——来自 `IMPLEMENTATION.md:347-357` 的接口草案。
- 服务不可用时延迟：假设本机回环 HTTP RTT < 5ms，800ms 超时保守；实测待验证。
- DSH 重启后 MCP 是否热刷新工具清单：源码注释（`mcp-snowluma-safe.js:304-305`）称"启动时读取"，按需重启是安全做法；未实测热加载。
- `qq_get_prompt` 的 `memory` 键只用于展示（`enabledTools` 遍历在 **5211-5213**）；新增 flag 后影响面理论上仅展示。

---

## 10. 一句话给实现者

> 加 `src/memory/memory-bridge.js`；在 `buildWakePromptV2Core` 的 `memoryLine` 之后插入 `longMemoryLine`（11080/11125），并只在 **9972** 传值；在 `mcp-snowluma-safe.js` 照 `qq_memory_query` 模板加 `qq_memory_recall` 并在 `TOOL_CONFIG_FLAGS`（约 324 行）登记；在 `bridge.js:7311` 后 `void memory.mirrorWrite(key, category, content, extra)`。改完重启**桥接 + DSH**。
