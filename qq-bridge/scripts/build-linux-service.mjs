#!/usr/bin/env node
// Linux 的无窗口启动（对应 Windows 的 control-center-hidden.vbs、macOS 的「QQ Bridge 控制中心.app」）。
//
//   npm run linux-service              # 生成 systemd 用户服务 + 桌面启动项，并打印下一步命令
//   npm run linux-service -- --enable  # 同上，并执行 systemctl --user daemon-reload / enable --now
//   npm run linux-service -- --print   # 只打印文件内容，不写入
//
// 生成两样东西（都在当前用户目录下，不需要 root；文件不入库）：
//   · ~/.config/systemd/user/qq-bridge-control-center.service —— 后台常驻、崩溃自动重启、登录后自动启动；
//     控制中心以 --no-open 运行（不弹浏览器），输出进 journalctl。不登录也想运行：sudo loginctl enable-linger <用户名>。
//   · ~/.local/share/applications/qq-bridge-control-center.desktop —— 有桌面时双击打开控制中心页面
//     （服务已在运行时只打开页面；没在运行就先启动，同样没有终端窗口）。
// 控制中心只监听 127.0.0.1：服务器上从别的电脑访问，用 ssh -L 3099:127.0.0.1:3099 <服务器> 转发后再打开页面。
// 只启动控制中心本身 —— 桥接、接口平台、QQ 后端仍然都在页面上由你点击启动。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVICE_NAME = 'qq-bridge-control-center';

/** systemd 单元里的值要转义：反斜杠与空格、% 按 systemd 规则处理。 */
function sdQuote(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

/** systemd 用户服务单元（纯函数，便于测试）。 */
// 生成的是 Linux 的文件：路径一律按 POSIX 拼（path.posix），在 Windows 上跑测试也不会变成反斜杠
const px = path.posix;

export function serviceUnit({ root, node = process.execPath, pathEnv = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' } = {}) {
  const entry = px.join(root, 'src', 'launcher', 'control-center.mjs');
  return `# qq-bridge 控制中心（由 scripts/build-linux-service.mjs 生成，不要手改；重新生成会覆盖）
[Unit]
Description=qq-bridge 控制中心（本机网页 127.0.0.1:3099，管理桥接 / 接口平台 / QQ 后端）
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${sdQuote(root)}
ExecStart=${sdQuote(node)} ${sdQuote(entry)} --no-open
Environment=${sdQuote(`PATH=${px.dirname(node)}:${pathEnv}`)}
Restart=on-failure
RestartSec=5
# 停止服务 = 页面上的「退出控制中心」：先停桥接、接口平台和它启动的 QQ 后端
KillSignal=SIGTERM
# 只先通知控制中心本身（它会按顺序停掉子进程），超时后才强制结束剩下的
KillMode=mixed
TimeoutStopSec=30

[Install]
WantedBy=default.target
`;
}

/** 桌面启动项：再次运行控制中心 —— 已在运行时它只打开页面（自带单实例），没在运行就启动。 */
export function desktopEntry({ root, node = process.execPath } = {}) {
  const entry = px.join(root, 'src', 'launcher', 'control-center.mjs');
  const q = (s) => `"${String(s).replace(/(["`$\\])/g, '\\$1')}"`;
  return `[Desktop Entry]
Type=Application
Name=QQ Bridge 控制中心
Comment=打开 qq-bridge 控制中心（没有终端窗口）
Exec=${q(node)} ${q(entry)}
Path=${root}
Terminal=false
Categories=Network;Utility;
`;
}

export function buildLinuxService({ root = fileURLToPath(new URL('..', import.meta.url)), home = os.homedir(), node = process.execPath, write = true } = {}) {
  root = String(root).replace(/\/+$/, '') || '/'; // 去掉末尾的斜杠（按字符串处理：Linux 路径，不用 path.resolve 以免 Windows 上加盘符）
  const unitPath = path.join(home, '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);
  const desktopPath = path.join(home, '.local', 'share', 'applications', `${SERVICE_NAME}.desktop`);
  const unit = serviceUnit({ root, node });
  const desktop = desktopEntry({ root, node });
  if (write) {
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.writeFileSync(unitPath, unit);
    fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
    fs.writeFileSync(desktopPath, desktop, { mode: 0o755 });
  }
  return { unitPath, desktopPath, unit, desktop };
}

if (process.argv[1]?.endsWith('build-linux-service.mjs')) {
  if (process.platform !== 'linux') {
    console.error('这个脚本只用于 Linux（Windows 用 control-center-hidden.vbs，macOS 用 npm run mac-app）');
    process.exit(1);
  }
  const print = process.argv.includes('--print');
  const r = buildLinuxService({ write: !print });
  if (print) {
    console.log(`# ${r.unitPath}\n${r.unit}\n# ${r.desktopPath}\n${r.desktop}`);
    process.exit(0);
  }
  console.log(`已生成：\n  ${r.unitPath}\n  ${r.desktopPath}`);
  if (process.argv.includes('--enable')) {
    try {
      execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
      execFileSync('systemctl', ['--user', 'enable', '--now', `${SERVICE_NAME}.service`], { stdio: 'inherit' });
      console.log(`已启用并启动。页面：http://127.0.0.1:3099/（令牌在 state/control-center-token）\n查看日志：journalctl --user -u ${SERVICE_NAME} -f`);
    } catch (e) {
      console.error(`systemctl 执行失败：${e?.message ?? e}\n（没有 systemd 的系统：直接运行 npm run control-center，或用桌面启动项）`);
      process.exit(1);
    }
  } else {
    console.log(`下一步（启用并立即启动，以后登录自动运行）：\n  systemctl --user daemon-reload && systemctl --user enable --now ${SERVICE_NAME}.service\n不登录也想运行：sudo loginctl enable-linger $USER\n查看日志：journalctl --user -u ${SERVICE_NAME} -f`);
  }
}
