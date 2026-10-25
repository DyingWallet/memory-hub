// 从 SnowLuma 目录发现每个账号的 OneBot WebSocket 端点和令牌。
//
// SnowLuma 的 OneBot 配置按账号分文件：<SnowLuma>/config/onebot_<QQ号>.json，
// 每个账号有自己的 wsServers[0].{host,port,accessToken}（与 HTTP 的令牌不同）。
// 换账号后令牌和端口都会变，所以每次重连前重新读取。只读，不修改 SnowLuma 的任何文件。

import fs from 'node:fs';
import path from 'node:path';
import { classifyReadError } from '../discovery-errors.mjs';

/** 返回 [{ uin, wsUrl, token, file }]，按 uin 排序。目录不存在返回 []；存在却读不了时抛 DiscoveryUnreadableError。 */
export function discoverWsEndpoints(homeDir) {
  if (!homeDir) return [];
  const dir = path.join(homeDir, 'config');
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { classifyReadError(err, dir); return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const m = /^onebot_(\d+)\.json$/i.exec(e.name);
    if (!m) continue;
    let t;
    try { t = fs.readFileSync(path.join(dir, e.name), 'utf8'); } catch (err) { classifyReadError(err, path.join(dir, e.name)); continue; }
    try {
      if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
      const ws = JSON.parse(t)?.networks?.wsServers?.[0];
      if (!ws) continue;
      // 0.0.0.0 / :: 是监听地址，连接时改用回环
      const host = !ws.host || ws.host === '0.0.0.0' || ws.host === '::' ? '127.0.0.1' : String(ws.host);
      out.push({ uin: m[1], wsUrl: `ws://${host}:${Number(ws.port) || 3001}`, token: String(ws.accessToken ?? ''), file: path.join(dir, e.name) });
    } catch {
      // 单个文件坏了不影响其他账号
    }
  }
  return out.sort((a, b) => a.uin.localeCompare(b.uin));
}
