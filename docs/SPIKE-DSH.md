# DSH 插件 API 侦察报告（SPIKE-DSH）

- 侦察对象：本机安装的 DeepSeek Harness Desktop `0.2.1-rc.2`（`dshBuildCommit: 332895e0f7c9d4dbfb29729f5eb367fa263ff986`，`dshBuildDirty: false`）
- 生效 profile：`desktop`（`DSH_PROFILE=desktop`，`DSH_PROFILE_DIR=C:\Users\70903\.dsh\profiles\desktop`）
- 安装位置：`D:\Software\dsh\`
- 侦察日期：2026-10-23
- 约束：只读源码；未修改 DSH 安装；未改 `C:\Users\70903\.dsh` 下任何配置；未重启 Desktop / Host；未安装任何包。

## 0. 证据口径与源码位置

### 0.1 先说明一个路径事实

任务给的 checkout 路径是 `D:\Software\dsh\resources\app.asar\dsh\`，但本机这个路径**不存在**：

```text
Get-ChildItem "D:\Software\dsh\resources\app.asar\dsh"
→ 找不到路径
```

原因是 `app.asar` 是一个单文件归档（`182,794,869` 字节），不是已经解包的目录。安装里只有 `resources\app.asar.unpacked\` 这一小部分原生模块被解包，`@deepseek-ai/dsh-*` 的 JS/TS 全在 asar 内。

为了做行号级证据，我用 asar 头部解析把需要的包**只读地**解到工作区：

```text
D:\deepseek_workspace\_tmp\dsh-asar-src\
```

- 解包脚本：`D:\deepseek_workspace\_tmp\asar-src-extract.mjs`
- 解包范围：`node_modules/@deepseek-ai/*` 的 `src/`、`lib/`、`lib/types/`、`README*`、`package.json`、bundle 的 `cordis.patch.yml` / `presets/*.patch.yml`，以及 Desktop 根的 `lib/main.js`
- 原始逻辑位置写作：`app.asar!dsh/node_modules/@deepseek-ai/...`

下文路径简写：

| 简写 | 实际路径 |
|---|---|
| `$SRC` | `D:\deepseek_workspace\_tmp\dsh-asar-src` |
| `$DSH` | `C:\Users\70903\.dsh` |
| `$PROFILE` | `C:\Users\70903\.dsh\profiles\desktop` |

**行号以 `$SRC` 副本为准**；副本内容来自本机 asar，未做任何修改。README 的行号同样可用，因为 README 也是原样解出的。

### 0.2 结论标记

- **【确认】** 源码/配置里直接读到，附路径+行号。
- **【实测】** 本机实际执行命令或读取配置观察到。
- **【推测】** 由源码行为推导，未在本机端到端验证；文中会说明推测依据。

---

## 1. 插件形态与安装

### 1.1 结论

1. **没有“插件目录扫描”这回事。** DSH 不会自动读取 `$DSH_HOME/plugins/` 或任何目录里的包。一个插件要生效，必须有**组合后的 Loader 行**（entry），行来自 profile 的 `dsh.profile.bundles` 各 bundle 的 patch 层 + profile 的 `cordis.patch.yml` + home patch + `--patch` overlay。`$DSH_HOME/plugins/` 只是本机放本地包源码的**习惯位置**，不是 DSH 的发现约定。**【确认】**

2. **插件的两种形态：**
   - **Host 插件**：一个 ESM 模块，导出 `name` / `inject` / `Config` / `apply(ctx)`（Cordis 插件约定）。**【确认】**
   - **Bundle**：一个 npm 包，`package.json` 里声明 `dsh.bundle.patch` 指向一个或多个 patch 文件；它被打进 `dsh.profile.bundles` 后，它的 patch 层才参与组合。**【确认】**
   - **Client 插件（浏览器半侧）**：同一个包在 `package.json` 里再声明 `dsh.client`（`platform: "web"`），并通过 `exports["./client"]` 导出 `lib/client.js`。**【确认】**

3. **本地目录插件注册进 desktop profile 的现实路径**（本机已有先例）：
   - 在 `$PROFILE/package.json` 的 `dependencies` 里写 `"my-plugin": "link:C:/绝对/路径"`（或 `file:`）；
   - 执行 `pnpm install`（或通过插件管理器/CLI 安装）；
   - 把包名加入 `$PROFILE/package.json` 的 `dsh.profile.bundles`；
   - 重启 Desktop（配置 patch 可 HMR，模块根默认不 HMR；见 1.5）。
   本机的 `qq-mode-console`、`qq-agent-presets` 就是 `link:` 进 profile 的，`node_modules/qq-mode-console` 是指向 `C:\Users\70903\.dsh\plugins\qq-mode-console` 的 Junction。**【实测】**

4. **CLI 对 desktop 的拒绝要分两半看：**
   - **启动 / dump**：`dsh --profile desktop` 永远拒绝，Desktop 自带的 CLI 也一样。**【确认+实测】**
   - **插件管理**：npm 发行的 `dsh` CLI **拒绝**；Desktop 自带的 `runtime\cli\bin\dsh.cmd`（`dsh-desktop-host/lib/cli.js`）给 `runCli()` 传了 `manageDesktopProfile: true`，**放行** `dsh plugin --profile desktop ...`。**【确认】**
   - 本机 `dsh` 命令不在 PATH 上（`where dsh` 为空），但 Desktop 安装内自带 `D:\Software\dsh\resources\runtime\cli\bin\dsh.cmd`。**【实测】**

5. **安装与回滚的写入点**：
   - 安装：`package.json`（dependencies + `dsh.profile.bundles`）、`pnpm-lock.yaml`、`node_modules/`（`link:` 时是 junction）、`.plugin-manager/logs/`。
   - 回滚：`dsh plugin ... remove` 会跑 `pnpm remove` 并从 `bundles` 移除；**兼容性拒绝**时自动恢复安装前的 `package.json` + `pnpm-lock.yaml`（插件管理器的 `installBundle` 路径在失败/取消时也恢复，CLI 原始 pnpm 路径只保证前者）；致命恢复时 `sanitizeProfile()` 会把 `cordis.patch.yml` 改名为 `.bak-<timestamp>` 并恢复 bundle 列表。**【确认】**

### 1.2 加载链路（从磁盘到 Loader 行）

Desktop Host 启动时不是走 CLI profile 发现，而是直接加载已初始化的 profile 目录：

```js
// $SRC/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js:219-232
async function main() {
  const runtimeDir = process.argv[2];
  const projectDir = process.argv[3];
  ...
  const installAnchor = join(runtimeDir, "node_modules", "@deepseek-ai", "dsh", "package.json");
  const profile = loadProfileDirectory("dsh", projectDir, installAnchor);
  reportSkippedBundles("dsh", profile);
  const application = runProfile({
    ...
    resolvedProfile: { profile, installAnchor },
```

`loadProfileDirectory()` 的算法：

```js
// $SRC/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:1015-1050
function loadProfileDirectory(binName, dir, installAnchor, options = {}) {
  const bundles = dropRetiredBundles(dir, readProfileManifest(binName, dir)).dsh?.profile?.bundles ?? [];
  ...
  for (const packageName of bundles) try {
    const packageDir = resolveBundleDir(binName, packageName, installAnchor, dir);
    const bundleManifest = readProfileManifest(binName, packageDir);
    const bundle = bundleManifest.dsh?.bundle;
    if (bundle === void 0) throw new Error(`${binName}: profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle in its package.json`);
    ...
    const patchPaths = bundlePatchPaths(packageDir, bundle);
    const patches = patchPaths.flatMap((patchPath) => loadOverlayPatches(binName, patchPath));
    layers.push({ packageName, packageDir, patchPaths, patches });
  } catch (error) {
    skippedBundles.push({ packageName, reason: String(error) });
  }
  const patchPath = join(dir, PROFILE_PATCH_FILENAME);
  const patches = options.userLayer !== false && existsSync(patchPath) ? loadOverlayPatches(binName, patchPath) : [];
  ...
}
```

要点：

- bundle 从 **DSH 安装目录** 和 **profile 自己的 `node_modules`** 两处解析（`resolveBundleDir` 先 installAnchor 后 profile）。**【确认】**（`$SRC/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:995-1002`）
- 没有 `dsh.bundle` 的包会被跳过并记入 `skippedBundles`，不会让启动失败。**【确认】**
- 各 bundle patch 层按 `bundles` 顺序先应用，最后才是 profile 的 `cordis.patch.yml`。**【确认】**（app-boot README.zh.md:50-61）

patch 里的行可以写绝对路径 / 相对 patch 文件的路径 / 包名：

```js
// $SRC/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:3970-3978
/** Convert inserted filesystem paths to file URLs, anchoring relative paths beside the patch; keep assertion names literal. */
function anchorInsertedPluginNames(patches, file) {
  const base = dirname(resolve(file));
  const visit = (entry) => {
    if (typeof entry.name === "string" && (isAbsolute(entry.name) || entry.name.startsWith("./") || entry.name.startsWith("../")))
      entry.name = pathToFileURL(resolve(base, entry.name)).href;
    if (entry.group && Array.isArray(entry.config)) entry.config.forEach(visit);
  };
  for (const patch of patches) patch.insert?.forEach(visit);
  return patches;
}
```

这是“免 npm 安装、直接用本地文件”的源码依据；但**目录**（而不是具体 `.js` 文件）的 ESM import 语义并不可靠，而且 client bundle / peer 解析都依赖包身份。**【推测】** 对本地目录插件，仍推荐 `link:` 安装，不要依赖裸路径行。

### 1.3 包形态：package.json 字段

公开清单类型由一个纯类型包定义：

```json
// $SRC/node_modules/@deepseek-ai/dsh-package-manifest/README.zh.md:34-43
{
  "name": "example-dsh-plugin",
  "version": "1.0.0",
  "engines": { "node": ">=24", "dsh": "0.1.5-alpha.1" },
  "dsh": {
    "manifestVersion": 1,
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web" }
  }
}
```

- `dsh.bundle.patch` 是**一个路径或有序路径数组**，相对包根，按顺序作为同一 bundle 层应用。**【确认】**
- `dsh.client` 的合法字段（源码校验）：`platform`（必填 string，只有 `"web"` 会被扫描）、`inject`（string[]）、`external`（string[]）、`immediately`（boolean）。**【确认】**（`$SRC/.../dsh-client-modules/lib/index.js:64-73`）
- `engines.dsh` / DSH peer 版本会被启动前检查；不兼容的 bundle 会被跳过或拒绝，除非写 `compatibility.json` 精确版本豁免。**【确认】**（app-boot README.zh.md:52-56）

一个“最小 Host 插件”的模块形状（本机 `dsh-time-context` 的真实导出）：

```js
// $SRC/node_modules/@deepseek-ai/dsh-time-context/lib/index.js:249
export { Config, apply, inject, name };
```

`apply(ctx)` 是入口；`inject` 声明依赖服务；`Config` 是 schemastery 配置 schema；`name` 用于诊断。

### 1.4 cordis.patch.yml 行结构

`cordis.patch.yml` 是一个 YAML **patch 列表**（不是完整的 Cordis 树）。支持的语义：

- `- id: <row-id>` + `config:`：替换该行**整个** config（不是深合并）。
- `- id: <row-id>` + `disabled: true`：禁用该行。
- `- insert: [ { id, name, config }, ... ]`：插入新行。
- `!!js` 表达式在启动时求值。
- 空文件 / 只有注释会**启动失败**；要禁用该层请写 `[]`。
  **【确认】**（`$SRC/node_modules/@deepseek-ai/dsh-app-boot/README.zh.md:61`）

一个真实的本机 patch（MCP 行与本地插件行）：

```yaml
# $PROFILE/cordis.patch.yml:47-56
- insert:
    - id: mcp-snowluma
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: snowluma
        transport: stdio
        command: 'D:\Software\dsh\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
        args:
          - 'D:\deepseek_workspace\qq-bridge\src\mcp-snowluma-safe.js'
        toolCallTimeoutMs: 725000
```

```yaml
# $PROFILE/cordis.patch.yml:75-77
- id: qq-mode
  name: qq-mode-console
  config: {}
```

注意：**行的 `id` 同时是 Settings 的命名空间 id**。本机 `qq-mode-console` 的注释明确记录了这个约束（`$DSH/plugins/qq-mode-console/cordis.patch.yml` 顶部注释）。**【实测】**

### 1.5 本地目录插件怎么进 desktop profile

本机已有完整先例：

```json
// $PROFILE/package.json
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "qq-mode-console": "link:C:/Users/70903/.dsh/plugins/qq-mode-console",
    "qq-agent-presets": "link:C:/Users/70903/.dsh/plugins/qq-agent-presets"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "qq-mode-console",
        "qq-agent-presets"
      ]
    }
  }
}
```

```text
# 实测
Get-Item "$PROFILE\node_modules\qq-mode-console"
→ LinkType: Junction  Target: C:\Users\70903\.dsh\plugins\qq-mode-console
```

`qq-mode-console` 自己的包清单声明了 bundle：

```json
// C:\Users\70903\.dsh\plugins\qq-mode-console\package.json
{
  "name": "qq-mode-console",
  "version": "1.0.3",
  "type": "module",
  "main": "./lib/index.js",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

所以“本地目录插件”是三步：

1. 包根有 `package.json` + `dsh.bundle.patch` + 构建后的入口（`main` 或 `exports`）。
2. `$PROFILE/package.json` 里加 `link:` 依赖，并执行 `pnpm install`（或让 CLI/插件管理器安装）。
3. 包名进 `dsh.profile.bundles`，必要时在 `cordis.patch.yml` 里按 id 覆盖/插入行。

**为什么不能只改 `cordis.patch.yml` 就完事：** 如果 `name` 是包名，Loader 需要通过 profile 的模块解析找到它；没有 `link:` / `node_modules` 就没有这个包。直接用绝对路径行在源码上可行（1.2），但 client bundle、peer 依赖、包元信息都不完整，属于**不推荐**路径。**【推测】**

### 1.6 安装 / 回滚命令与写入点

#### 安装

推荐（Desktop 自带的 CLI，允许 desktop）：

```bat
D:\Software\dsh\resources\runtime\cli\bin\dsh.cmd plugin --profile desktop add link:D:\path\to\my-plugin
```

> 操作前先**完全退出 Desktop**。CLI 的 `requireDesktopProfile()` 在 profile 未初始化时会提示“Open DeepSeek Harness Desktop once ... then fully quit it before running dsh plugin --profile desktop”（`$SRC/node_modules/@deepseek-ai/dsh/lib/plugin-BiveYA7h.js:10-12`）；运行中的 Desktop 还会持有 HMR 与模块解析状态，重启后才会用新包。

它会：

1. 取 `$PROFILE/package.json.lock` 写锁；
2. 在 profile 目录里跑 pnpm（Desktop 自带 pnpm）；
3. pnpm 成功后 `reconcile()`：
   - 新依赖如果声明了 `dsh.bundle`，自动 `bundles.push(name)` 并写回 `package.json`；
   - 没声明 `dsh.bundle` 的只作为普通依赖，并打印警告；
4. 失败时：兼容性拒绝会恢复 `package.json` + `pnpm-lock.yaml` 并按恢复后的锁文件重修；普通 pnpm 失败只报告日志，可能留下已下载文件。

源码证据：

```js
// $SRC/node_modules/@deepseek-ai/dsh-plugin-manager/lib/types/operations.js:95-123
async function reconcile(before, dir, anchor, options) {
  const after = readProfileManifest('dsh', dir);
  const dependencies = Object.keys(after.dependencies ?? {});
  ...
  for (const name of dependencies) {
    if (beforeDeps.has(name)) continue;
    const metadata = bundleManifest(name, dir, anchor);
    if (metadata?.dsh?.bundle === undefined) {
      options.onOutput?.(`dsh: warning: ${name} declares no dsh.bundle — installed as a plain dependency, not a profile layer\n`, 'stderr');
      continue;
    }
    ...
    if (!bundles.includes(name)) bundles.push(name);
  }
  ...
  after.dsh = { ...after.dsh, profile: { ...after.dsh?.profile, bundles } };
  await saveManifest(dir, after);
}
```

```js
// $SRC/node_modules/@deepseek-ai/dsh-plugin-manager/lib/types/operations.js:317-338
const before = readProfileManifest('dsh', dir);
const savedFiles = ['package.json', 'pnpm-lock.yaml'].map(name => ({ path: join(dir, name), text: optionalFile(join(dir, name)) }));
...
const restore = async () => {
  for (const file of savedFiles) {
    if (file.text === undefined) await rm(file.path, { force: true });
    else await writeFileAtomic(file.path, file.text, { mode: 0o600 });
  }
};
```

```js
// $SRC/node_modules/@deepseek-ai/dsh-plugin-manager/lib/types/operations.js:558-560
else if (options.activateNewBundles !== false) {
  await reconcile(before, dir, context.installAnchor, options);
}
```

**Desktop UI 的“添加插件”走 `pluginManager.installBundle`**（与 CLI 共享 `reconcile` / `saveManifest` 写点），接受包名、Git 地址、压缩包、本地绝对路径（`$SRC/.../dsh-client-ui-plugin-manager/README.zh.md:57`）。所以不写 CLI 也可以从 UI 安装本地目录。

#### 回滚

- **卸载包**：`dsh plugin --profile desktop remove <pkg>` → pnpm remove + 从 `bundles` 移除。**【确认】**
- **只停用、不卸载**：在 `cordis.patch.yml` 里写 `- id: <row-id>\n  disabled: true`（bundle 行也可以按 id 禁用）。**【确认】**
- **失败回滚**：兼容性拒绝时，pnpm 运行前的 `package.json` + `pnpm-lock.yaml` 快照会自动恢复（见上）；插件管理器的 `installBundle` 在失败/取消时也恢复，CLI 原始 pnpm 路径不保证普通失败。**【确认】**
- **致命启动恢复**：`sanitizeProfile()` 把 `cordis.patch.yml` 改名 `.bak-<UnixMs>`（冲突加 `-1`），并把 `dsh.profile.bundles` 恢复为调用方给的 bundle 列表；已安装包和其他字段保留。Desktop 在原生致命错误恢复中调用它。**【确认】**

```js
// $SRC/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:1242-1256
function sanitizeProfile(binName, profileDir, bundles) {
  const manifest = existsSync(join(profileDir, "package.json")) ? readProfileManifest(binName, profileDir) : void 0;
  const patchPath = join(profileDir, PROFILE_PATCH_FILENAME);
  const backupBase = `${patchPath}.bak-${Date.now()}`;
  let backupPath = backupBase;
  let ordinal = 0;
  while (existsSync(backupPath)) backupPath = `${backupBase}-${++ordinal}`;
  try { renameSync(patchPath, backupPath); } ...
  if (manifest !== void 0) writeProfileBundles(profileDir, manifest, bundles);
  return backupPath;
}
```

本机 `$PROFILE` 里已经有两个手工备份，说明这条恢复约定在实际使用：

```text
$PROFILE/cordis.patch.yml.bak-2026-10-21T17-49-32-435Z
$PROFILE/cordis.patch.yml.before-qq
```

### 1.7 CLI 到底拒绝什么

启动/dump 一律拒绝：

```js
// $SRC/node_modules/@deepseek-ai/dsh/lib/bin.js:35-37
function rejectElectronProfile(program, profile) {
  if (profile.toLowerCase() === "desktop") program.error("error: profile \"desktop\" is managed exclusively by the Electron application");
}
```

这个函数在 boot action 里**无条件**调用（`bin.js:112`），所以 `dsh --profile desktop` 永远失败。实测：

```text
> D:\Software\dsh\resources\runtime\cli\bin\dsh.cmd --profile desktop
error: profile "desktop" is managed exclusively by the Electron application
exit=1
```

插件管理则看 `manageDesktopProfile`：

```js
// $SRC/node_modules/@deepseek-ai/dsh/lib/bin.js:115-119
if (first === "plugin") {
  ...
  if (!manageDesktopProfile) rejectElectronProfile(plugin, options.profile);
```

npm 发行的 CLI 默认 `manageDesktopProfile = false`（`bin.js:101`），所以拒绝。Desktop 自带的入口显式打开：

```js
// $SRC/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js:94-107
async function runDesktopCli(runtimeDir, supportDir) {
  installOfficeEngineResolution(runtimeDir);
  await runCli({
    manageDesktopProfile: true,
    packageManager: { ... },
  });
}
```

而 `runtime\cli\bin\dsh.cmd` 正是跑这个 `cli.js`：

```bat
@echo off
setlocal DisableDelayedExpansion
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\..\..\DeepSeek Harness.exe" --expose-internals "%~dp0..\..\..\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*
exit /b %errorlevel%
```

**本机实测的一个重要细节**：Desktop CLI 对 `plugin --profile desktop version-exemptions` **没有**打印“managed exclusively”，说明 guard 已放行；但本次会话是 workspace-write 沙箱，写 `$PROFILE\package.json.lock` 被拒绝：

```text
> dsh.cmd plugin --profile desktop version-exemptions
dsh: Error: EPERM: operation not permitted, open 'C:\Users\70903\.dsh\profiles\desktop\package.json.lock'
exit=1
```

这个 EPERM 是**沙箱**导致的，不是 DSH 的拒绝逻辑。因此本报告无法端到端验证 desktop 插件写操作；需要非沙箱身份或 Desktop UI 才会真正落地。**【实测+推断】**

---

## 2. 会话启动注入

### 2.1 结论

**有注入钩子，而且不止一个。** 但 DSH 没有叫 `prompt/build` 或“system-reminder API”的东西；它是一个**事件 + 消息模型**：

1. **`agent/pre-step`（waterfall）— 最接近“第一轮模型调用前”的钩子。**
   - 签名（源码生成的 API 目录）：
     ```ts
     'agent/pre-step'(
       this: Scoped<Agent>,
       payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal },
       next: () => Promise<PreStepDecision>
     ): Promise<PreStepDecision>
     ```
   - `PreStepDecision`：
     ```ts
     export type PreStepDecision =
       | { kind: 'reject' }
       | { kind: 'enter'; messages: UserMessage[]; startsRequestSeries?: true }
     ```
   - 它在 **system prompt 组装之后、请求派生之前**运行；可以替换“进入这一步”的消息批次。首轮用 `turn === 1 && step === 1` 判断。**【确认】**
2. **`ctx.systemPrompt.section(...)` — 系统提示词段。** 每个模型步骤组装时都在，适合放静态/全局 bootstrap；`text` 可以是函数，按组装求值。**【确认】**
3. **`ctx.systemPrompt.context(...)` — 运行时上下文快照。** 会被 agent-loop 自动投影成一条 user 消息（“Current runtime context. This snapshot supersedes earlier runtime-context snapshots.”），适合放每步可更新的动态事实。**【确认】** 通过 `agent.ctx` 做 per-agent 注册是 scoped layers 的既有语义，但本机未实测。**【推测】**
4. **`system-prompt/assemble`（waterfall）— 专家级。** 可以改整个 assembly（sections/contexts/tools/variables），权限最大、风险也最大。**【确认】**
5. **`session/created`（emit，同步）— 会话发布时的 veto/初始化。** 可以同步抛错回滚会话创建，但**不能直接追加消息**；要追加消息请用 `agent/pre-step` 或 `agent.followup/inject/steer`。**【确认】**
6. **`agent/created`（serial）— 每个 agent 的初始化。** 在创建解析前按顺序 await，适合初始化状态；**推测**也可以在这里按会话注册 `agent.ctx.systemPrompt.context(...)`（未实测）；不能在监听器里 await `agent.whenIdle()`。**【确认事件 + 推测用法】**

**不存在的事件**（已搜索确认）：

- `prompt/build`：0 命中。
- `agent/turn/start`：0 命中（只有持久日志事件 `turn/start`，不是 Cordis 事件）。
- `session/start`：0 命中。
- 专门的 `system-reminder` API：0 命中；`system-reminder` 只是插件自己拼的字面文本，`dsh-agent-instructions`、`dsh-tool-skill` 和聊天渲染器各自使用。

### 2.2 Server 端事件清单（源码 API 目录）

以下是 `dsh-tool-cordis` 生成的事件目录里列出的全部事件（按 `name [mode]`），可作为“可用 server 端事件名”的权威清单：

```text
agent-loop/config-start-failed [emit]      agent-preset/selected [emit]
agent/assistant-stream [emit]              agent/created [serial]
agent/disposed [emit]                      agent/error [emit]
agent/inbox/claimed [emit]                 agent/inbox/discarded [emit]
agent/inbox/inserted [emit]                agent/pre-step [waterfall]
agent/request [waterfall]                  agent/request-error [waterfall]
agent/status [emit]                        agent/turn-stopping [serial]
api-session/activity [emit]                api-session/added [emit]
api-session/error [emit]                   api-session/removed [emit]
api-session/status [emit]                  app-boot/config-reload [emit]
approval/request [waterfall]               authorization/settled [emit]
commands/change [emit]                     compaction/summary-error [waterfall]
connection/request [waterfall]             cordis/dynamic-package [emit]
cordis/dynamic-retract [emit]              cordis/inspect-query [emit]
cordis/inspect-query-resolved [emit]       cordis/request-run [emit]
cordis/request-run-resolved [emit]         credentials/record-updated [emit]
credentials/reference-updated [emit]       deepseek-account/model-sign-in-required [emit]
deepseek-account/session-expired [emit]    deepseek-account/signed-out [emit]
domain/changed [emit]                      feedback/committed [parallel]
fs/edit-intent [waterfall]                 fs/observed [emit]
fs/write-intent [waterfall]                goal/activation-changed [emit]
goal/changed [emit]                        hmr/change [emit]
hmr/reload [emit]                          llm/adapters-updated [emit]
llm/stream [waterfall]                     permission-presets/catalog-changed [emit]
plugin-manager/changed [emit]              plugin-manager/install-log [emit]
plugin-manager/install-state [emit]        plugin-market/changed [emit]
schedule/changed [emit]                    session-telemetry/record [waterfall]
session/created [emit]                     session/disposed [emit]
session/event [emit]                       session/flush [parallel]
settings/document-updated [emit]           skills/change [emit]
subagent/end [emit]                        subagent/provider-added [emit]
subagent/provider-removed [emit]           subagent/start [emit]
system-prompt/assemble [waterfall]         system-prompt/change [emit]
tools/change [emit]                        tools/execute [waterfall]
tools/post-execute [waterfall]             tools/pre-execute [waterfall]
tools/ptc-dispatch-log [waterfall]         tools/result [emit]
user-questions/request [waterfall]         webserver/index-inject [emit]
workflow/agent-end [emit]                  workflow/agent-start [emit]
workflow/end [emit]                        workflow/log [emit]
workflow/phase [emit]                      workflow/start [emit]
workspace/session-activity [waterfall]     workspace/session-stop [parallel]
```

（来源：`$SRC/node_modules/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js`；例如 `agent/pre-step` 在 4004-4009，`session/created` 在 4364-4369，`system-prompt/assemble` 在 4444-4449。）

### 2.3 `agent/pre-step` 的关键 payload 与执行位置

```ts
// api-catalog.js:4004-4009
name: 'agent/pre-step',
mode: 'waterfall',
signature: '\'agent/pre-step\'(this: Scoped<Agent>, payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>',
summary: 'Reject a proposed step or replace the messages that enter it.',
description: 'Reject a proposed step or replace the messages that enter it. Calling `next()` preserves the current messages.',
```

执行顺序（agent-loop）：

```js
// $SRC/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js:902-927
async preStep(target, position) {
  const signal = this.phase.abort.signal;
  const claimed = this.inbox.claim(target, position.turn);
  const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal));
  signal.throwIfAborted();
  const decision = await this.dispatch.waterfall("agent/pre-step", {
    messages: claimed,
    ...position,
    signal
  }, () => {
    const sections = renderContextSections(assembly);
    const context = this.runtimeContext.project(joinContextSections(sections), sections);
    return Promise.resolve({
      kind: "enter",
      messages: context === void 0 ? claimed : [...claimed, context]
    });
  });
  ...
}
```

关键含义：

- **pre-step 在 system prompt 组装之后**。在 pre-step 里注册新的 `systemPrompt.section` **不会**影响当前这次请求，只会影响下一步。
- 默认 fallback 已经把 `systemPrompt.context` 投影成一条 user 消息追加在 claimed 消息之后。
- 监听器可以 `{ prepend: true }` 抢先执行；`dsh-time-context` 用 `{ prepend: true }`（`lib/index.js:246`），`dsh-agent-instructions` 不抢先，它在 `next()` 之后把基线插到已领取消息之后。

### 2.4 最小可用示例（首轮注入 `<system-reminder>`）

下面是一个完整的 host 插件模块（不会自动安装，只是示例）：

```js
// memory-bootstrap.js
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'memory-bootstrap'
// 需要 tools 服务只是为了确保它和其他基础服务一起就绪；不需要可删掉
export const inject = ['tools']

export function apply(ctx) {
  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision

    // 只在“第一轮第一步”注入；子会话可再按 agent.session.header 判断
    if (turn !== 1 || step !== 1) return decision

    const text = [
      '<system-reminder>',
      '记忆服务已启用。开始任务前，先调用 memory_search 检索相关记忆；',
      '如果用户提到新的长期偏好或事实，调用 memory_write 记录。',
      '</system-reminder>',
    ].join('\n')

    return {
      ...decision,
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text }],
          source: {
            kind: 'memory-bootstrap',
            form: 'snapshot',
            sections: [{ name: 'memory-bootstrap', text }],
          },
        }),
      ],
    }
  }, { prepend: true })
}
```

这个模式逐字来自两个真实插件：

```js
// $SRC/node_modules/@deepseek-ai/dsh-time-context/lib/index.js:215-246
ctx.on("agent/pre-step", async ({ agent, turn, step, signal }, next) => {
  const decision = await next();
  if (decision.kind === "reject" || signal.aborted) return decision;
  ...
  return {
    ...decision,
    messages: [...decision.messages, createUserMessage({
      content: [{ type: "text", text }],
      source: { kind: name, form: "snapshot", sections: [{ name, text }] }
    })]
  };
}, { prepend: true });
```

```js
// $SRC/node_modules/@deepseek-ai/dsh-agent-instructions/lib/index.js:1406-1424
ctx.on("agent/pre-step", async ({ agent, messages, step, signal }, next) => {
  const decision = await next();
  await waitForProjections(agent);
  const pending = agent.inbox.nextStep.filter(isAgentInstructionsMessage);
  const desired = await compose(agent, signal, messages, pending);
  signal.throwIfAborted();
  if (decision.kind === "reject" || step === 1 && decision.messages.length === 0) {
    syncInbox(agent, messages, desired);
    return decision;
  }
  for (const message of pending) agent.inbox.remove(message.id);
  if (desired === void 0 || decision.messages.some((message) => sameContextPayload(message, desired))) return decision;
  const lastClaimedIndex = decision.messages.findLastIndex((message) => messages.includes(message));
  const entered = decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired);
  return { ...decision, messages: entered };
});
```

**注意**：

- `<system-reminder>` 没有特殊语义，只是 **插件自己拼的文本**；模型看到的是 **user 角色消息**，不是 system 消息。如果你要“真正的系统提示”，用 `systemPrompt.section`。
- 注入的消息是**持久历史**的一部分（可回放、可压缩、会占 token），不是每轮隐藏重发。想“每步更新”应使用 `systemPrompt.context`（快照会被原位替换）。
- 恢复会话时，`turn/step` 从当前会话继续，不一定是 1；要“每个会话只一次”，需在会话投影或日志里查已有 bootstrap 消息（`agent-instructions` 就是这么做的）。

### 2.5 系统提示词 / 运行时上下文 API

```js
// $SRC/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js:245-313
section(section) {
  if (!Number.isFinite(section.order)) throw new TypeError(`prompt section "${section.name}" order must be a finite number`);
  return this.layers.effect(this.ctx, (layer) => layer.sections.insert(section.name, section), { label: "systemPrompt.section()" });
}
...
context(context) {
  if (!Number.isFinite(context.order)) throw new TypeError(`prompt context "${context.name}" order must be a finite number`);
  return this.layers.effect(this.ctx, (layer) => layer.contexts.insert(context.name, context), { label: "systemPrompt.context()" });
}
...
variable(name, provider) {
  if (!VARIABLE_NAME.test(name)) throw new Error(`invalid prompt variable name "${name}" ...`);
  return this.layers.effect(this.ctx, (layer) => layer.variables.insert(name, provider), { label: "systemPrompt.variable()" });
}
```

类型（`api-catalog.js` 的生成声明，与 `dsh-system-prompt` 公开类型一致；`AssembleContext` 在 4779，`PromptContext` 在 6479，`PromptSection` 在 6495）：

```ts
export interface PromptSection {
  readonly name: string;
  readonly order: number;
  readonly text: string | ((context: AssembleContext) => string);
  readonly interpolate?: boolean;
  readonly complete?: boolean;
}
export interface PromptContext {
  readonly name: string;
  readonly order: number;
  readonly text: string | ((context: AssembleContext) => string);
  readonly interpolate?: boolean;
  readonly required?: boolean;
}
export interface AssembleContext {
  scope?: ScopeKey;
  signal?: AbortSignal;
}
```

关键限制：`AssembleContext` **不包含 session**。所以：

- 全局 `section/context` 只能是“所有会话共享”的文本（或全局状态）；
- **per-session** 的动态内容，要在 `agent/created` 里通过 `agent.ctx.systemPrompt.context(...)` 注册到 agent scope（闭包捕获 session），或者在 `agent/pre-step` 里自己拼消息。**【推测】** 这是由 scoped layers 的设计推导的，未在本机跑通。

`SECTION_ORDERS` 的真实值（可用于选 `order`）：

```js
// $SRC/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js:10-42
HARNESS_IDENTITY: -1e3,
DEPLOYMENT_PERSONA_PREFIX: 0,
PLAN_POLICY: 500,
TEAM_POLICY: 600,
PTC_ONLY: 800,
FILE_REFERENCE: 900,
TOOL_BASH: 1e3,
TOOL_PWSH: 1010,
...
MCP_SERVERS: 3100,
TOOLS_SDK: 5e3,
...
STRUCTURED_OUTPUT: 9900,
HARNESS_SOURCE: 1e4,
WEB_SURFACE: 10100,
DEPLOYMENT_PERSONA_SUFFIX: 10200
```

### 2.6 其他“会话开始”相关事件

```ts
// api-catalog.js:4364-4369
'session/created'(this: Scoped<Session>, session: Session): void
// 同步 throw 会 veto 创建；返回 Promise 的 rejection 只记录、不能回滚

// api-catalog.js:4380-4385
'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void
// 提交后的 append feed；可看到 turn/start、user/message、step/end 等持久事件

// api-catalog.js:3956-3961
'agent/created'(this: Scoped<Agent>, payload: { agent: Agent; source: SessionStartSource; signal?: AbortSignal }): undefined | Promise<undefined>
// 创建解析前按序 await；AgentLoop 会等监听器结束后才处理排队输入
```

`agent.followup/steer/inject` 也能投递 user 消息（`dsh-agent/README.zh.md:143`），但从 `agent/created` 投递与首轮排队输入的先后关系没有实测，**首选仍是 pre-step**。**【推测】**

---

## 3. 设置页 / 客户端插件 API

### 3.1 结论

1. **客户端插件不是“随便一段前端代码”**：它必须是同一个 npm 包的浏览器半侧，`package.json` 声明 `dsh.client`（`platform: "web"`），`exports["./client"]` 指向**已构建**的 `lib/client.js`。Host 扫描已启用 Loader 行的包清单，把每个 bundle 通过 `/plugins` 提供给浏览器。**【确认】**

2. **设置页/面板有两套 UI 位置：**
   - **Settings 模态框页面**：注册进 `settings.section`（一个 list slot，一页一个条目），导航由 shell 投影。**【确认】**
   - **侧栏 Plugins 页的插件配置**：注册进 `plugins.item`（官方插件卡片）、`plugins.bundle.config`（按包名）、`plugins.row.config`（按 `<包名>#<行 id>`）。后者会给该行增加一个“配置”控件，打开自己的页面。**【确认】**
   - 还有 `settings.general.item`（单行偏好）、`settings.plugins.tab`（内置插件分区标签页）、`settings.onboarding`（引导步骤）。**【确认】**

3. **注册 API 是 slot API**：
   ```ts
   ctx.slots.inject('settings.section', () => ctx.slots.register(
     { name: 'settings.section', id: 'my-entry', order: 100, label: 'My entry' },
     () => React.createElement('div', null, 'hello'),
   ))
   ```
   **【确认】**（`$SRC/.../dsh-cordis-client-runner/lib/client.js:5342`）

4. **Schema 驱动：数据层支持，渲染层没有现成通用表单。**
   - Host 的 `settings.describe()` 会给每个**有 Config 且至少一个 volatile 字段**的活动条目返回 `{ ns, schema: <JSON Schema>, autoGenerate, revision, value, base, user, ... }`，其中 `schema` 只保留 volatile 字段。**【确认】**
   - `autoGenerate` 默认 `true`，但 README 明确说：**目前没有已发布的客户端使用它**。官方设置页是手写 React 组件，用 `ctx.configForms.get(entryId)` 读写。**【确认】**
   - 所以“JSON Schema → 表单”的自动渲染**在框架数据层存在，在产品 UI 里没有**。要设置页，得自己写客户端组件。**【确认】**

5. **Host 侧 settings 服务**：
   - 命名空间 = Loader 行的 `id`；schema = 插件模块导出的 `Config`（schemastery）；只有带 `volatile` 标记的字段可编辑。
   - 写 API：`ctx.settings.update(ns, patch, revision)` / `replace` / `mutate`；读：`describe`；呈现策略：`configure({ auto: false }, ctx.fiber)`。**【确认】**

6. **构建/加载约束**：
   - 必须是预构建的 `lib/client.js`；Host 不编译前端。源码开发用 `pnpm run dev:web`（宿主 + 重建 watcher）才有自动替换。**【确认】**
   - bundle 是自定义的懒加载 CJS 包装（`window.__ModuleLoader__.load({ id, factory(require) })`），不是普通 ESM；共享模块走平台种子表，基座之外的请求必须在 `dsh.client.external` 里逐项声明。**【确认】**

### 3.2 客户端包清单与加载

```json
// $SRC/node_modules/@deepseek-ai/dsh-client-ui-settings-web-search/package.json:29-38
"dsh": {
  "client": {
    "inject": [
      "@deepseek-ai/dsh-client-locale",
      "@deepseek-ai/dsh-client-ui-settings",
      "@deepseek-ai/dsh-client-ui-plugin-manager",
      "@deepseek-ai/dsh-api-remotes"
    ],
    "platform": "web"
  }
}
```

```json
"exports": {
  ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
  "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
  ...
}
```

Host 侧扫描与解析：

```js
// $SRC/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js:730-746
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const dsh = pkg.dsh;
const decl = parseDshClient(packageName, dsh !== null && typeof dsh === "object" ? dsh.client : void 0);
if (decl === void 0 || decl.platform !== "web") return null;
const clientRel = clientExportOf(packageName, pkg.exports);
if (clientRel === void 0) throw new Error(`client-modules: ${packageName} declares dsh.client but exports no "./client" bundle`);
const resolved = {
  packageName,
  meta: {
    clientPath: join(dirname(pkgPath), clientRel),
    ...decl.inject !== void 0 ? { inject: decl.inject } : {},
    external: decl.external ?? [],
    immediately: decl.immediately === true
  }
};
```

浏览器 bundle 的开头（每个官方插件都是这样）：

```js
// $SRC/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js:1-4
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-client-ui-theme",
  factory: (require) => {
```

构建要求：

- `dsh-client-modules` README.zh.md:55：**宿主提供的是已构建客户端 bundle**，启动前 `pnpm run build` 必须产出每个 `lib/client.js`；缺失会明确失败。
- `dsh-client-hmr` README.zh.md:32：`pnpm run dev:web` 同时启动宿主与重建 watcher；重建后的插件自动替换进浏览器。
- 没有 `dev:web` 时，改客户端代码必须重新构建 + 刷新页面；**不存在运行时编译**。

### 3.3 设置页注册（三个真实 seat）

#### A. Settings 模态框页：`settings.section`

```ts
ctx.slots.inject('settings.section', () => ctx.slots.register(
  { name: 'settings.section', id: 'my-entry', order: 100, label: 'My entry' },
  () => React.createElement('div', null, 'hello'),
))
```

该 slot 的注册选项与 owner props：

```text
$SRC/.../dsh-cordis-client-runner/lib/client.js:5292-5343
key: settings.section
kind: list
scope: root
summary: One settings page per list entry.
registerOptions: id (required) / order / label
ownerProps: { close: () => void }
declaredBy: "an entry in 'sidebar.settings' (client-ui-settings-general)"
occupants: agent-presets, account, general, models, plugins
```

#### B. 插件自己的配置页：`plugins.row.config` / `plugins.bundle.config`

```tsx
// $SRC/node_modules/@deepseek-ai/dsh-client-ui-plugin-manager/README.zh.md:75-81
ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
  name: 'plugins.row.config',
  key: '@acme/dsh-sidebar#sidebar',
  locale: 'acmeSidebar',
}, ({ t, view }) => view === 'summary' ? t('summary') : <SidebarForm t={t} />))
```

- `key` 是 `<包名>#<行 id>`；页面只为**开启的** bundle 出现。
- `plugins.bundle.config` 用包名做 key，页面显示在 bundle 详情里。
- 页面用 `view: 'page'` 渲染，自己负责保存控件；只有保存才写入。

**【确认】**（`$SRC/.../dsh-client-ui-plugin-manager/README.zh.md:73-83`）

#### C. 单行偏好：`settings.general.item`

```text
$SRC/.../dsh-cordis-client-runner/lib/client.js:4969-4971
summary: "One preference row inside the General section — the additive seat for a single setting that needs no page of its own (a whole page is `settings.section`)"
Options: `id` (row key), `order` (row position). The section column only stacks rows...
```

### 3.4 Host 侧 settings 数据面

`settings.describe()` 的真实返回结构：

```js
// $SRC/node_modules/@deepseek-ai/dsh-settings/lib/index.js:413-451
describe(options) {
  const descriptors = this.ownerContext.configEditor.configuration().flatMap(({ entry, inherited, override }) => {
    const schema = this.schema(entry);
    ...
    const form = volatileForm(schema);
    if (form === void 0) return [];
    ...
    const autoGenerate = this.presentations.get(entry.fiber)?.auto ?? true;
    ...
    return [{
      autoGenerate,
      ns: entry.options.id,
      schema: form.toJSON(),   // <-- JSON Schema 只含 volatile 字段
      revision,
      applies: "live",
      value,
      base,
      user,
      ...(options?.redactSecrets ? { secrets: redacted.secrets } : {})
    }];
  });
  ...
}
```

写入 API：

```js
// $SRC/node_modules/@deepseek-ai/dsh-settings/lib/index.js:470-488
async update(ns, patch, expectedRevision) { ... }
async replace(ns, section, expectedRevision) { ... }
async mutate(ns, ops, expectedRevision) { ... }
```

“命名空间从行 id 推导”的规则由 `configEditor.configuration()` 的 `entry.options.id` 提供；本机 `qq-mode-console` 的源码注释也记录了这个事实（`$DSH/plugins/qq-mode-console/lib/index.js` 顶部）。**【确认+实测】**

`volatile` 必须在 Config 字段上标记，否则 `volatileForm()` 返回空，设置页不可见：

```js
// 本机 qq-mode-console 的写法（真实可运行）
export const Config = z.object({
  mode: z.union([...]).default('reserved2').extra('volatile', true),
  ownerQQ: z.string().description('...').extra('volatile', true),
});
```

### 3.5 现成 API 一览（客户端）

| API | 作用 | 证据 |
|---|---|---|
| `ctx.slots.inject(name, fn)` | 等 slot 声明出现后再注册 | client-runner 5342 |
| `ctx.slots.register({name,id,order,label}, Component)` | 注册 UI 条目 | 同上 |
| `ctx.configForms.get(entryId)` | 某个 Host 条目的共享表单（value/base/user/revision/writable + set/unset/mutate） | `dsh-client-ui-settings/README.zh.md:32-40` |
| `ctx.configForms.whileServed(namespaces, register)` | 只在 Host 服务某命名空间时挂载页面 | 同上 40 |
| `ctx.settingsSchema` | 重建 schema、校验草稿、编辑嵌套值 | `dsh-client-ui-settings/README.zh.md:72` |
| `ctx.configForms.describe()` | 跨命名空间目录 / hasDocument | 同上 44 |
| `ctx.locale.register(NS, dict)` | 页面文案 | web-search client 实例 |

### 3.6 明确不存在的东西（搜索记录）

- **没有通用 JSON-Schema 表单渲染器**。搜索 `autoGenerate|settingsSchema` 于所有 `dsh-client-ui-*` / `dsh-client-*` 的 `lib/client.js`：只有 `dsh-client-ui-settings`、`dsh-client-ui-settings-models`、`dsh-client-ui-permission-presets` 命中；没有任何组件读取 `autoGenerate` 并渲染表单。`dsh-settings/README.zh.md:39` 原文：“目前没有已发布的客户端这样做”。
- **没有 `ctx.settings.register()`**。搜索 `dsh-settings/lib/index.js` 的方法：只有 `configure/prepareDocument/describe/update/replace/mutate/schema`；没有 `register`。0.1.x 的 `settings.register` 在 0.2.x 已移除。**【确认】**
- **没有运行时前端构建**。`dsh-client-modules/README.zh.md:55` 要求预构建 `lib/client.js`。
- **没有 `settings.yaml` 的运行时写入路径**（除一次性旧版导入）：`dsh-settings/README.zh.md:35` 说旧的 `settings.yaml` 只在启动时导入一次，然后改名 `.imported`。新写入都进 profile patch。**【确认】**

---

## 4. MCP 接入

### 4.1 结论

1. **DSH 的 MCP 接入方式就是 `@deepseek-ai/dsh-mcp-client` 插件行**，不是独立的 `mcp.json`。每台服务器一行；字段在 `config` 下。
2. **stdio 必填字段**：`serverName`、`transport: stdio`、`command`；可选 `args`、`env`、`cwd`、`toolCallTimeoutMs`、`maxInstructionBytes`、`failOnStartupError`、`reconnect.*`。**【确认】**
3. **工具名**：`mcp__<serverName>__<rawName>`，例如 `mcp__github__create_issue`；同一 `serverName` 在同一作用域重复会在加载时失败。**【确认】**
4. **`initialize` 返回的 `instructions` 会进入系统提示词**：以 `### MCP server: <serverName>` 段落加入 `systemPrompt.section`，section 名 `mcp:<server>`，order `MCP_SERVERS`（3100），默认上限 32,768 字节。这是方案 B 的核心依据。**【确认】**
5. **插件可以自带 MCP server**：多种方式——
   - 在插件自己的 `cordis.patch.yml` 里插入一条 `@deepseek-ai/dsh-mcp-client` 行，指向插件包内的 server 脚本（路径要绝对，或通过 `!!js` 计算）；
   - 插件 host 半侧直接 `ctx.plugin(McpClient, config)`，或者用 `createMcpToolDefinition(ctx, options)` 把 MCP 工具适配进 `ctx.tools`。
   **【确认 API + 推测组合方式】**
6. **限制**：MCP prompts 模板不支持；资源通过 `dsh-mcp-resources` 按需读取；指令超限会让连接失败；server 断开后工具有重连预算。**【确认】**

### 4.2 配置结构（stdio / streamable-http）

```yaml
# $SRC/node_modules/@deepseek-ai/dsh-mcp-client/README.zh.md:34-53
- id: mcp-github
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: github
    transport: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-github']
    env:
      GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN

- id: mcp-web
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: web
    transport: streamable-http
    url: http://localhost:3000/mcp
    headers:
      Authorization: !!js '`Bearer ${process.env.MCP_TOKEN}`'
```

源码 schema：

```js
// $SRC/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js:780-800
const Config = z.union([
  z.object({
    transport: z.const("stdio"),
    serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
    command: z.string().required(),
    args: z.array(String).default([]),
    env: z.dict(String).default({}),
    cwd: z.string().default(""),
    toolCallTimeoutMs: z.number().default(6e4),
    failOnStartupError: z.boolean().default(false),
    maxInstructionBytes: z.number().step(1).min(1).default(DEFAULT_MAX_INSTRUCTION_BYTES),
    reconnect: Reconnect
  }),
  z.object({
    transport: z.const("streamable-http"),
    serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
    url: z.string().required(),
    headers: z.dict(String).default({}),
    ...
  })
]);
```

`env` 会合并到**清洗过的父环境**上：删除匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 的变量和所有 `DSH_*`，再覆盖配置项。**【确认】**（README.zh.md:137）

### 4.3 initialize.instructions → 系统提示词（方案 B 的关键）

```js
// $SRC/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js:654-656
const serverText = generation.getInstructions()?.trimEnd() ?? "";
instructions = serverText ? `### MCP server: ${config.serverName}\n\n${serverText}` : "";
if (Buffer.byteLength(instructions) > maxInstructionBytes) throw new Error(`${label}: server instructions exceed maxInstructionBytes (${maxInstructionBytes})`);
```

```js
// $SRC/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js:731-742
function registerServerContext(ctx, server, connection) {
  ctx.inject(["mcpResources"], (inner) => {
    inner.mcpResources.register(server, connection.resources);
  });
  ctx.inject(["systemPrompt"], (inner) => {
    inner.systemPrompt.section({
      name: `mcp:${server}`,
      order: inner.systemPrompt.getSectionOrder("MCP_SERVERS"),
      interpolate: false,
      text: () => connection.instructions()
    });
  });
}
```

结论：

- 只要 MCP server 在 `initialize` 结果里返回非空 `instructions`，它就会成为系统提示词的一段，**在第一次模型调用前就已经在 prompt 里**（连接在插件激活时 await）。
- 文本是字面值（`interpolate: false`），花括号不会被当变量。
- 上限 32KB；超了连接直接失败（`failOnStartupError` 决定插件是否激活失败）。
- 这段文本**不是** `<system-reminder>` user 消息，而是 system prompt 的一部分；对 KV cache 前缀有影响。

### 4.4 MCP 工具如何进入 `ctx.tools`

```js
// $SRC/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js:153
for (const [publicName, definition] of definitions) disposers.set(publicName, ctx.tools.register(definition));
```

```js
// $SRC/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js:748-756
* MCP client bridge plugin: connects to an external MCP server and registers its
* tools on `ctx.tools` under server-qualified public names
* (`mcp__<serverName>__<rawName>`). Each plugin instance connects to one MCP
* server; load multiple instances in `cordis.yml` for multiple servers.
```

### 4.5 本机真实配置（已存在）

```yaml
# $PROFILE/cordis.patch.yml:47-73
- insert:
    - id: mcp-snowluma
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: snowluma
        transport: stdio
        command: 'D:\Software\dsh\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
        args:
          - 'D:\deepseek_workspace\qq-bridge\src\mcp-snowluma-safe.js'
        toolCallTimeoutMs: 725000
```

这段由 `qq-bridge/scripts/setup-dsh.mjs` 维护，脚本会先备份再整体替换管理块：

```js
// D:\deepseek_workspace\qq-bridge\scripts\setup-dsh.mjs:144-171
const MANAGED_MCP_IDS = ['mcp-snowluma', 'mcp-snowluma-host', 'mcp-web-search-safe'];
function mcpEntries() {
  const node = process.execPath;
  const servers = {
    'mcp-snowluma': { serverName: 'snowluma', script: path.join(REPO_ROOT, 'src', 'mcp-snowluma-safe.js'), toolCallTimeoutMs: 725000 },
    ...
  };
  let out = '# === qq-bridge MCP BEGIN ===\n';
  ...
  for (const [id, s] of Object.entries(servers)) {
    out += `- insert:\n`;
    out += `    - id: ${id}\n`;
    out += `      name: '@deepseek-ai/dsh-mcp-client'\n`;
    ...
  }
  out += '# === qq-bridge MCP END ===\n';
```

这证明：**在这台机器上增加一个 MCP server 的最短路径，就是往这个管理块里加一个 server 条目**（或复制同样的 managed-block 模式），不需要碰 DSH 安装。

### 4.6 插件自带 MCP server 的具体做法

**做法 1：bundle patch 插入 mcp-client 行**

```yaml
# 插件包内的 cordis.patch.yml
- insert:
    - id: mcp-memory
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: memory
        transport: stdio
        command: 'D:\Software\dsh\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
        args:
          - 'D:\absolute\path\to\memory-mcp.js'
```

缺点：`args` **不会**像 `entry.name` 那样被 `anchorInsertedPluginNames` 转成 file URL；相对路径是相对进程 cwd（profile 目录），不可靠。要用绝对路径，或在 `!!js` 里算。**【确认（代码）+ 推测（路径行为）】**

**做法 2：host 半侧程序化挂载**

```js
import * as McpClient from '@deepseek-ai/dsh-mcp-client'

export function apply(ctx) {
  ctx.plugin(McpClient, {
    serverName: 'memory',
    transport: 'stdio',
    command: process.execPath,
    args: [new URL('./memory-mcp.js', import.meta.url).pathname],
  })
}
```

`dsh-mcp-client` 导出 `{ Config, apply, createMcpToolDefinition, inject, name }`，所以可以作为 Cordis 插件对象被 `ctx.plugin()` 挂载。**【确认导出；组合方式推测】**

**做法 3：不用 MCP 传输，直接把工具适配进 `ctx.tools`**

`createMcpToolDefinition(ctx, options)` 是公开导出，给“已经有一个 MCP 风格工具定义、但不想走 stdio/HTTP”的提供方使用。**【确认】**

---

## 5. 工具注册

### 5.1 结论

- 服务：`ctx.tools`（`ToolRuntime`）。
- 注册：`ctx.tools.register(defineTool({ ... }))`，返回 disposer；schema 会自动进入系统提示词组装。
- 模型可见的三要素：`name`、`description`、`parameters`（JSON Schema）。
- 执行前参数会按 `parameters` 校验；无效输入变成普通错误结果，不抛到轮次外。
- `output` 必填：`{ schema, render }`；`render` 把规范值变成模型可见内容块。
- `execute(args, exec)` 里必须观察 `exec.signal`（协作式取消）。
- 工具名 `run_code` 是 PTC 模式保留名，不能注册/遮蔽。

**【确认】**（`dsh-tools/README.zh.md:30-95`、`lib/index.js:838-871`、`lib/index.js:2974-2983`）

### 5.2 最小工具（README 原文示例）

```ts
// $SRC/node_modules/@deepseek-ai/dsh-tools/README.zh.md:38-62
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

declare const ctx: Context

ctx.tools.register(defineTool({
  name: 'read_file',
  description: 'Read a file from disk.',
  parameters: {
    path: { type: 'string', required: true, description: 'Absolute file path' },
    offset: { type: 'number' },
    limit: { type: 'number' },
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  async execute(args, exec) {
    return readFile(args.path, { encoding: 'utf8', signal: exec.signal })
  },
}))
```

### 5.3 源码确认的注册与校验

```js
// $SRC/node_modules/@deepseek-ai/dsh-tools/lib/index.js:838-871
function defineTool(options) {
  ...
  const parameters = parameterSchemaSpecToJsonSchema(options.parameters);
  const outputSchema = valueSchemaSpecToJsonSchema(options.output.schema);
  const validate = (args) => validateJsonSchemaValue(parameters, args, "");
  const tool = {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render(args, value) { return userRender(args, value); },
      ...
    },
    ...
    async execute(args, exec) {
      const violations = validate(args);
      if (violations.length > 0) throw new ToolArgsError(violations);
      return userExecute(args, exec);
    }
  };
  ...
}
```

```js
// $SRC/node_modules/@deepseek-ai/dsh-tools/lib/index.js:2974-2983
register(definition) {
  const name = definition.name;
  const output = definition.output;
  if (output === void 0 || typeof output !== "object" || typeof output.render !== "function" || ...)
    throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
  assertSupportedJsonSchema(output.schema);
  ...
  if (name === "run_code") throw new Error(`tool name "${RUN_CODE_NAME}" is reserved ...`);
  return this.layers.effect(this.ctx, (layer) => layer.tools.insert(name, definition), { label: "tools.register()" });
}
```

### 5.4 工具流水线事件（可用于权限/审计）

- `tools/pre-execute`（waterfall）：allow / deny / cancel / ask。**【确认】**
- `tools/execute`（waterfall）：包装分发（超时、重试、指标）。
- `tools/post-execute`（waterfall）：替换内容/值、附加上下文。
- `tools/result`（emit）：只读最终结果，适合审计/记忆写入。

签名示例：

```ts
'tools/pre-execute'(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>
PreToolDecision = { kind: 'allow' } | { kind: 'deny'; reason: string; info?: ToolErrorInfo } | { kind: 'cancel' } | { kind: 'ask'; reason?: string }
```

（`api-catalog.js:4484-4500`、`PreToolDecision` 在 6420 附近）

---

## 6. 已有相关样例（checkout 内真实插件）

### 6.1 `dsh-time-context`：`agent/pre-step` 注入的最小完整实现

- 包路径：`$SRC/node_modules/@deepseek-ai/dsh-time-context`
- 关键文件：`lib/index.js`
- 为什么相关：它只做一件事——在合适的步数把一条带 source 的 `UserMessage` 追加进进入步骤的批次；这就是“会话注入”的最小范式。

```js
// $SRC/node_modules/@deepseek-ai/dsh-time-context/lib/index.js:215-246
ctx.on("agent/pre-step", async ({ agent, turn, step, signal }, next) => {
  const decision = await next();
  if (decision.kind === "reject" || signal.aborted) return decision;
  ...
  return {
    ...decision,
    messages: [...decision.messages, createUserMessage({
      content: [{ type: "text", text }],
      source: { kind: name, form: "snapshot", sections: [{ name, text }] }
    })]
  };
}, { prepend: true });
```

依赖/导出：

```js
import { createUserMessage } from "@deepseek-ai/dsh-llm";
...
export { Config, apply, inject, name };   // lib/index.js:249
```

### 6.2 `dsh-mcp-client`：MCP server + 工具注册 + 指令注入

- 包路径：`$SRC/node_modules/@deepseek-ai/dsh-mcp-client`
- 关键文件：`lib/index.js`、`README.zh.md`
- 为什么相关：它同时覆盖了本任务最关心的三件事——外部 server 配置、工具注册、`initialize.instructions` 进系统提示词。

```js
// 工具注册（lib/index.js:153）
for (const [publicName, definition] of definitions) disposers.set(publicName, ctx.tools.register(definition));
```

```js
// 指令注入（lib/index.js:735-742）
ctx.inject(["systemPrompt"], (inner) => {
  inner.systemPrompt.section({
    name: `mcp:${server}`,
    order: inner.systemPrompt.getSectionOrder("MCP_SERVERS"),
    interpolate: false,
    text: () => connection.instructions()
  });
});
```

### 6.3 `dsh-client-ui-settings-web-search`：真实设置页（host 空壳 + client 页面）

- 包路径：`$SRC/node_modules/@deepseek-ai/dsh-client-ui-settings-web-search`
- 关键文件：`package.json`、`lib/index.js`、`lib/client.js`
- 为什么相关：它展示了一个“只负责 UI 的插件”应该怎么拆：host 半侧是空 `apply`，浏览器半侧注册页面，配置通过 `ctx.configForms` 读写。

```js
// lib/index.js（完整 host 半侧）
/** Host plugin body — no host-side behavior for this surface plugin. */
function apply() {}
export { apply };
```

```js
// lib/client.js:510-518
ctx.effect(() => ctx.configForms.whileServed([WEB_SEARCH_NS], () => ctx.slots.inject("plugins.item", () => ctx.slots.register({
  name: "plugins.item",
  id: "web-search",
  order: 20,
  label: () => t("title"),
  locale: NS,
  inject: () => card.inject()
}, WebSearchCard))), "ui-settings-web-search: page");
```

```json
// package.json:29-38
"dsh": {
  "client": {
    "inject": [ ... ],
    "platform": "web"
  }
}
```

### 6.4 本机额外样例（不在 checkout，但更有说服力）

- `C:\Users\70903\.dsh\plugins\qq-mode-console`：本地 `link:` 包 + `dsh.bundle.patch` + 带 `volatile` 的 `Config`；证明“本地目录插件 + 设置命名空间”在本机可运行。
- `C:\Users\70903\.dsh\plugins\qq-agent-presets`：一个包声明多个 `presets/*.patch.yml`，演示 bundle patch 数组写法。
- `D:\deepseek_workspace\qq-bridge\scripts\setup-dsh.mjs`：现成的“备份 + 管理块替换”写入器，是 B 方案最现实的落地点。

---

## 7. 推荐接入方案

### 7.1 三方案对照

| | A. 插件自动注入 bootstrap | B. MCP `initialize.instructions` + AGENTS.md | C. 只写 AGENTS.md 规则 |
|---|---|---|---|
| 首次模型调用前可见 | ✅ `agent/pre-step` 首轮注入，或 `systemPrompt.section` | ✅ 连接后即进 system prompt | ✅ base 的 `agent-instructions` 在首轮 pre-step 注入 |
| 动态/按会话 | ✅ 可以按 `agent.session` 变化 | ⚠️ 服务器级，所有会话共享；重连才更新 | ❌ 静态文件 |
| 需要改 `~/.dsh` | ✅ 要装包 + 加 bundle/行 | ✅ 只加一条 mcp-client 行 | ❌ 不用 |
| 需要重启 | ✅ 通常要（模块根默认不 HMR） | ⚠️ 配置 HMR 可热加载；新进程通常要重启 | ❌ 不用 |
| 需要写前端 | 可选（要设置页才写） | ❌ 不用 | ❌ 不用 |
| 风险/成本 | 中高：包兼容、构建、安装、回滚 | 低：一行配置 + 一个 server 脚本 | 零 |
| 本会话可执行 | ❌ 沙箱不能写 `$DSH` | ❌ 同上 | ✅ 只改工作区 AGENTS.md |

### 7.2 本机条件下哪条可行

**结论：B 作为主方案，C 作为保底，A 放到第二阶段。**

- **C 现在就能用。** `dsh-base` 已经启用了 `dsh-agent-instructions`，预算 65,536 字节（`$SRC/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:303-306`）。它在首轮 `agent/pre-step` 注入 `<system-reminder>` 基线；其真实实现见 2.4 的第二段代码引用（`dsh-agent-instructions/lib/index.js:1406-1424`）。工作区已有 `D:\deepseek_workspace\AGENTS.md`，只要写规则就会生效。零 DSH 改动、零重启。
- **B 是“第一次模型调用前”最划算的真实注入。** `dsh-mcp-client` 已经在本机运行（本会话工具列表里能看到 `mcp__snowluma__*`、`mcp__web-search-safe__*`，`$PROFILE/cordis.patch.yml` 里的三条 mcp-client 行就是配置），`initialize.instructions` 会进系统提示词（4.3 源码确认），工具会以 `mcp__memory__*` 出现。只需要往 `qq-bridge/scripts/setup-dsh.mjs` 的管理块里加一个 server，或复制同样的块。它不需要前端、不需要插件包、不需要 `dsh plugin add`。
- **A 技术上完全可行，但本会话不可执行。** 本会话是 workspace-write 沙箱，写 `$PROFILE`（`C:\Users\70903\.dsh\...`）会被拒绝；实测 Desktop CLI 在拿 profile 写锁时就 EPERM。而且任务本身要求不改 `~/.dsh`。A 还需要本地包构建/安装与一次重启，风险高于 B。等 B 验证了“记忆内容确实有用”之后，再考虑 A 做 per-session 动态注入和设置页。

### 7.3 B 的落地步骤（建议下一步执行，不在本 spike 内）

1. 在 `memory-hub` 里加一个 stdio MCP server（例如 `src/mcp-server.mjs`）：
   - `initialize` 返回 `instructions`：一段 ≤ 32KB 的 bootstrap（记忆在哪、何时检索、何时写入、如何引用）；
   - 暴露工具：`memory_search`、`memory_get`、`memory_write`（名字会成为 `mcp__memory__*`）；
   - 可选：提供 resources，交给 `dsh-mcp-resources`。
2. 在 `qq-bridge/scripts/setup-dsh.mjs` 的 `MANAGED_MCP_IDS` / `servers` 里加 `mcp-memory`（或写一个同样的 managed-block 脚本）。生成的 YAML 形如：

   ```yaml
   - insert:
       - id: mcp-memory
         name: '@deepseek-ai/dsh-mcp-client'
         config:
           serverName: memory
           transport: stdio
           command: 'D:\Software\dsh\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
           args:
             - 'D:\deepseek_workspace\memory-hub\src\mcp-server.mjs'
           toolCallTimeoutMs: 120000
   ```

3. 用**非沙箱**身份运行该脚本（它已经自带备份，见 `setup-dsh.mjs:74` `backupBeforeOverwrite`），然后重启 Desktop（或依赖 HMR 重组配置；MCP server 是新进程，最稳妥是重启）。
4. 验证：
   - 模型工具列表出现 `mcp__memory__memory_search` 等；
   - 系统提示词里出现 `### MCP server: memory` 段（可在会话请求头/日志或让模型复述 instructions 验证）。
5. 同时在 `D:\deepseek_workspace\AGENTS.md` 写 3-5 条“记忆使用规则”（C），保证 MCP 没起来时仍有最低限度的行为约束。

### 7.4 B 的回滚

- 从 `setup-dsh.mjs` 的 `servers` 里删掉 `mcp-memory`，重跑脚本；管理块会整体替换。
- 或手工删除 `- insert:` 块；若只想临时停用，保留 insert，并在它**之后**再加一条 `- id: mcp-memory` + `disabled: true`（后应用的 patch 覆盖前一条）。
- 任何失败都可从 `$PROFILE/cordis.patch.yml.bak-*` 恢复；脚本本身也会在覆盖前备份。
- 不需要卸载任何包，不需要动 DSH 安装。

### 7.5 A 的预留设计（等 B 验证后）

如果以后要做 A，推荐的最小形态：

```js
// memory-bootstrap 插件（host-only，先不做设置页）
export const name = 'memory-bootstrap'
export const inject = ['tools', 'systemPrompt']

export function apply(ctx) {
  ctx.on('agent/created', async ({ agent }) => {
    // 可选：把 per-session 的记忆快照注册成 runtime context
    agent.ctx.systemPrompt.context({
      name: 'memory:bootstrap',
      order: 120, // 与 working-directory/sandbox 同级，靠前
      text: () => renderMemoryBootstrap(agent.session.header.cwd),
    })
  })
}
```

或者首轮注入 `<system-reminder>`：

```js
ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
  const d = await next()
  if (d.kind === 'reject' || turn !== 1 || step !== 1) return d
  return { ...d, messages: [...d.messages, createUserMessage({ ... }) ] }
}, { prepend: true })
```

**注意**：如果 A 要设置页，必须再加 `dsh.client` 浏览器半侧和 `lib/client.js` 构建产物；纯 host 插件不会在 UI 里出现可编辑卡片（见 3.4/3.6）。

---

## 8. 搜索记录（用于证明“不存在”）

| 想确认的东西 | 搜索词 | 结果 |
|---|---|---|
| `prompt/build` 事件 | `prompt/build` | 0 命中 |
| `agent/turn/start` 事件 | `agent/turn/start` | 0 命中 |
| `session/start` 事件 | `'session/start'` / `"session/start"` | 0 命中 |
| 专门 system-reminder API | `system-reminder` | 仅 3 个文件：`dsh-agent-instructions`、`dsh-tool-skill`、`dsh-client-ui-chat`（渲染） |
| `ctx.settings.register` | `dsh-settings/lib/index.js` 方法表 | 只有 configure/describe/update/replace/mutate；无 register |
| 通用 schema 表单渲染器 | `autoGenerate` / `settingsSchema` 于所有 client `lib/client.js` | 3 个包命中，无通用渲染组件；README 明确“没有已发布客户端这样做” |
| 插件目录自动发现 | `$DSH_HOME/plugins` / `plugins` 读取 | 无任何包读取该目录；本机是 `link:` 手动注册 |
| MCP prompts 模板 | `prompts/list` / prompts | README 明确“不支持” |
| `settings.yaml` 运行时写入 | `settings.yaml` | 只有一次性旧版导入（`dsh-settings` README:35） |

命令示例（在 `$SRC` 下）：

```powershell
Select-String -Path "$SRC\node_modules\@deepseek-ai\*\lib\*.js" -Pattern "prompt/build" -List
Select-String -Path "$SRC\node_modules\@deepseek-ai\*\lib\*.js" -Pattern "agent/turn/start" -List
Select-String -Path "$SRC\node_modules\@deepseek-ai\dsh-settings\lib\index.js" -Pattern "register\("
```

---

## 9. 推测与未验证清单（明确标注）

1. **【推测】** Desktop profile 的 HMR 在运行中确实启用：`dsh-base` 的 `hmr` 行只在没有 `profileContext` 时禁用（`dsh-base/cordis.patch.yml:28-32`），Desktop 的 `runProfile` 会 `provide("profileContext", ...)`（`$SRC/.../dsh/lib/profile-boot-C14i-8IN.js:302-304`）。但我没有实际改文件观察热重载。
2. **【推测】** 通过 patch 的裸绝对路径 `name` 注册一个本地目录插件可以工作；源码只保证了路径→file URL，目录/包解析和 client bundle 仍需要包身份。未实测。
3. **【推测】** `agent/created` 里注册 `agent.ctx.systemPrompt.context(...)` 可以做到 per-session 动态上下文；这是从 scoped layers 和 agent-scoped 注册语义推导的，未跑通。
4. **【推测】** `plugins.row.config` 对第三方包同样生效；文档和 slot 目录确认了机制，但没有第三方包实例。
5. **【确认（代码路径）/ 未实测（端到端）】** MCP server 返回 `instructions` 后，模型在第一轮就能看到：`apply()` 在激活时 await `connection.ready`，section 的 `text` 函数在组装时读取已连上的 instructions；但我没有在本机接一个测试 server 观察完整 prompt。
6. **【实测限制】** 因 workspace-write 沙箱，`dsh plugin --profile desktop ...` 在取 profile 写锁时 EPERM；desktop 插件的安装/卸载未端到端验证。这个 EPERM 不应被解读为 DSH 拒绝 desktop。

---

## 10. 一页速查（给实现者）

```text
Host 插件入口：export { name, inject, Config, apply }
Bundling：package.json → dsh.bundle.patch → cordis.patch.yml（insert/id/disabled/config）
本地包：profile package.json 里 link:<abs dir> + pnpm install + bundles 列表
首轮注入：ctx.on('agent/pre-step', async ({agent,turn,step,signal}, next) => ...)
           → turn===1 && step===1 → 返回 { ...decision, messages:[...decision.messages, createUserMessage({...})] }
系统提示：ctx.systemPrompt.section({ name, order, text }) / .context({...})
事件：session/created, agent/created, agent/pre-step, agent/request, agent/turn-stopping,
      system-prompt/assemble, tools/pre-execute, tools/result ...
设置页：client 半侧 dsh.client{platform:'web'} + exports["./client"] → lib/client.js
        ctx.slots.inject('settings.section' | 'plugins.row.config', () => ctx.slots.register(...))
设置数据：ctx.configForms.get(entryId)（client）/ ctx.settings.describe|update|replace|mutate（host）
MCP：- id: mcp-x
     name: '@deepseek-ai/dsh-mcp-client'
     config: { serverName, transport: stdio, command, args, env, toolCallTimeoutMs }
     initialize.instructions → systemPrompt section `mcp:<server>`（order 3100，≤32KB）
工具：ctx.tools.register(defineTool({ name, description, parameters, output:{schema,render}, execute }))
```

---

## 11. 最终建议（TL;DR）

**推荐 B（MCP `initialize.instructions`）+ C（`AGENTS.md` 规则）先落地，A 暂缓。**

理由只有三条：

1. **B 已经具备全部运行条件**：本机 `dsh-mcp-client` 正在跑，`initialize.instructions` 会被注入系统提示词（源码 4.3），工具会以 `mcp__memory__*` 出现；只需在现有的 `setup-dsh.mjs` 管理块里加一个 server，不需要插件包、前端构建或 `dsh plugin add`。
2. **C 是零成本保底**：`dsh-base` 已启用 `dsh-agent-instructions`（64KB），`AGENTS.md` 在首轮 `agent/pre-step` 自动注入；MCP 没起来时，规则仍在。
3. **A 不是不可行，而是当前权限与成本不划算**：本会话是 workspace-write 沙箱，写 `$PROFILE` 会被拒绝（实测 CLI 取锁 EPERM）；A 还要构建/安装本地包并重启 Desktop。等 B 验证“记忆内容确实有用”后，再用 A 做 per-session 动态注入与设置页。
