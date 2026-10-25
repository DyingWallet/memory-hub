#!/usr/bin/env node
// 生成 macOS 的无窗口启动 App「QQ Bridge 控制中心.app」（对应 Windows 的 control-center-hidden.vbs）。
//
//   npm run mac-app            # 在仓库根目录生成 / 覆盖 QQ Bridge 控制中心.app
//   node scripts/build-mac-app.mjs --out <目录>
//
// 为什么在本机生成而不是随仓库发布：
//   · 本机用 osacompile 生成的 App 没有「从网络下载」的隔离标记，双击就能打开（下载来的未签名 App 会被 Gatekeeper 拦住）；
//   · App 里的 applet 可执行文件来自 macOS 本身，不随仓库再分发。生成的 .app 已在 .gitignore 里。
//
// App 的行为（AppleScript 常驻小程序，不显示 Dock 图标）：
//   · 打开：在后台启动控制中心（node src/launcher/control-center.mjs），控制中心自己打开浏览器页面；
//   · 再次双击：控制中心已在运行时只重新打开页面（控制中心自带单实例）；
//   · 页面上点「退出控制中心」后，App 发现控制中心不在了也自动退出；
//   · macOS「访问其他 App 的数据」（读 QQ 容器里的 NapCat 配置）会以本 App 的名义询问，允许一次即可。
// 控制中心的输出写到 state/control-center-app.log。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_NAME = 'QQ Bridge 控制中心';
export const BUNDLE_ID = 'io.github.qq-bridge-enhanced.control-center';

/** App 的 AppleScript 源码（纯函数，便于测试）。App 必须放在仓库根目录：用自己的位置找到仓库。 */
export function appleScriptSource() {
  return `-- ${APP_NAME}：无窗口启动 qq-bridge 控制中心（由 scripts/build-mac-app.mjs 生成，不要手改）
on repoDir()
  set appPath to POSIX path of (path to me)
  return do shell script "/usr/bin/dirname " & quoted form of appPath
end repoDir

on centerScript()
  return repoDir() & "/src/launcher/control-center.mjs"
end centerScript

on startCenter()
  set d to repoDir()
  -- 双击启动的 App 没有登录 shell 的 PATH：补上 Homebrew / 常见位置
  set cmd to "cd " & quoted form of d & " && export PATH=/opt/homebrew/bin:/opt/homebrew/opt/node@22/bin:/usr/local/bin:$PATH && command -v node >/dev/null 2>&1 || exit 3; mkdir -p state && nohup node " & quoted form of centerScript() & " >> state/control-center-app.log 2>&1 < /dev/null &"
  try
    do shell script cmd
  on error errMsg number errNum
    if errNum is 3 then
      display dialog "没有找到 Node.js。请先安装 Node.js 22（例如 brew install node@22），再重新打开「${APP_NAME}」。" buttons {"好"} default button 1 with icon stop with title "${APP_NAME}"
    else
      display dialog "启动控制中心失败：" & errMsg buttons {"好"} default button 1 with icon stop with title "${APP_NAME}"
    end if
    quit
  end try
end startCenter

on centerRunning()
  -- 末字符写成 [s]：执行 pgrep 的 sh 命令行里是「mj[s]」，不会被这个正则匹配到自己
  set pat to centerScript()
  set pat to (text 1 thru -2 of pat) & "[s]"
  try
    do shell script "/usr/bin/pgrep -f " & quoted form of pat
    return true
  on error
    return false
  end try
end centerRunning

on run
  startCenter()
end run

-- 已在运行时再次双击：控制中心的第二个实例只会重新打开页面然后退出
on reopen
  startCenter()
end reopen

-- 控制中心退出后（页面上点了「退出控制中心」），本 App 也退出
on idle
  if not centerRunning() then quit
  return 10
end idle
`;
}

function run(cmd, args) { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }

export function buildMacApp({ root = fileURLToPath(new URL('..', import.meta.url)), outDir = root } = {}) {
  if (process.platform !== 'darwin') throw new Error('只能在 macOS 上生成（需要系统自带的 osacompile）');
  const app = path.join(outDir, `${APP_NAME}.app`);
  const src = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-mac-app-')), 'main.applescript');
  fs.writeFileSync(src, appleScriptSource());
  fs.rmSync(app, { recursive: true, force: true });
  run('/usr/bin/osacompile', ['-s', '-o', app, src]); // -s：常驻（stay-open），才能响应 reopen / idle
  const plist = path.join(app, 'Contents', 'Info.plist');
  const set = (key, type, value) => { try { run('/usr/bin/plutil', ['-replace', key, type, value, plist]); } catch { run('/usr/bin/plutil', ['-insert', key, type, value, plist]); } };
  set('LSUIElement', '-bool', 'true'); // 不显示 Dock 图标、没有菜单栏
  set('CFBundleIdentifier', '-string', BUNDLE_ID);
  set('CFBundleName', '-string', APP_NAME);
  // 改了 Info.plist 后重新做本机签名（ad-hoc），macOS 才能稳定识别它（隐私授权按签名记）
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app]);
  return app;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('build-mac-app.mjs')) {
  const i = process.argv.indexOf('--out');
  try {
    const app = buildMacApp({ outDir: i > 0 ? path.resolve(process.argv[i + 1]) : undefined });
    console.log(`已生成：${app}\n双击它即可无窗口启动控制中心；第一次读 NapCat 配置时 macOS 会以「${APP_NAME}」的名义询问「访问其他 App 的数据」，点允许。`);
  } catch (e) {
    console.error(`生成失败：${e?.message ?? e}`);
    process.exit(1);
  }
}
