#!/usr/bin/env node
// 接口平台入口：node src/index.mjs [--data-dir <目录>] [--port <端口>]
//
// 可以单独运行，也可以由 qq-bridge 的控制中心作为子进程启动（日志以 JSON 行写到 stdout，控制中心按字段筛选）。
// 控制中心只经管理接口与平台通信；它的管理令牌经环境变量 INTERFACE_PLATFORM_ADMIN_TOKEN 交给平台。
// 退出时断开所有上游链路和兼容客户端；不会启停任何外部进程（包括 SnowLuma）。
// 退出码：0 正常退出；3 启动失败（配置错误、端口被占用 —— 重启也没用，控制中心不会自动重启）；其他 = 异常崩溃。

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlatform } from './core/platform.mjs';
import { createServer } from './api/server.mjs';
import { loadConfig, defaultDataDir } from './core/config.mjs';

export async function startPlatform({ dataDir = defaultDataDir(), port = null, stdoutLogs = true, installSignalHandlers = true, exitOnShutdown = true, WebSocketImpl } = {}) {
  const cfg = loadConfig(dataDir);
  if (port !== null) cfg.port = port;
  const platform = createPlatform({ dataDir, config: cfg, stdoutLogs, ...(WebSocketImpl ? { WebSocketImpl } : {}) });
  let stopping = false;
  const api = createServer(platform, { onShutdown: (why) => void shutdown(why) });
  async function shutdown(reason) {
    if (stopping) return;
    stopping = true;
    platform.log.info('core', `正在退出（${reason}）`);
    platform.stop();
    await api.close();
    if (exitOnShutdown) process.exit(0);
  }
  try {
    await api.listen();
  } catch (e) {
    if (e?.code === 'EADDRINUSE') throw new Error(`端口 ${cfg.port} 被占用：可能已有接口平台在运行，或在 ${path.join(dataDir, 'platform.json')} 里改 "port"`);
    throw e;
  }
  platform.log.info('core', `接口平台已启动：http://${cfg.host}:${api.port}/（数据目录 ${dataDir}）`);
  platform.log.info('core', `OneBot 兼容入口：ws://${cfg.host}:${api.port}/onebot/v11/ws ，http://${cfg.host}:${api.port}/onebot/v11`);
  platform.start();
  if (installSignalHandlers) {
    process.on('SIGINT', () => void shutdown('Ctrl+C'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGHUP', () => void shutdown('窗口关闭'));
  }
  return { platform, api, port: api.port, shutdown };
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataDir = argValue('--data-dir') ? path.resolve(argValue('--data-dir')) : defaultDataDir();
  const port = argValue('--port') !== null ? Number(argValue('--port')) : null;
  startPlatform({ dataDir, port }).catch((e) => {
    process.stderr.write(`[接口平台] 启动失败：${e?.message ?? e}\n`);
    process.exit(3);
  });
}
