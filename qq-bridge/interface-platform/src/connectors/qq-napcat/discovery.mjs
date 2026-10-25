// 从 NapCat 目录发现每个账号的 OneBot WebSocket 端点和令牌。
//
// NapCat（v4.18.38 源码核对）的 OneBot 配置按账号分文件：<配置目录>/onebot11_<QQ号>.json（用 JSON5 解析，可能带注释），
// 端点在 network.websocketServers[]：{ enable, host, port, token, ... }，只取第一个 enable 为 true 的。
// 配置目录因安装方式而异，这里接受「config 目录本身」或「它的上一级」。只读，不修改 NapCat 的任何文件。

import fs from 'node:fs';
import path from 'node:path';
import { classifyReadError } from '../discovery-errors.mjs';

/** 宽松解析：去掉字符串外的 // 与 /* *\/ 注释、去掉对象/数组末尾多余的逗号，再按 JSON 解析。 */
export function parseLooseJson(text) {
  let t = String(text);
  if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
  try { return JSON.parse(t); } catch {}
  let out = '';
  let inStr = false;
  let quote = '';
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += t[i + 1] ?? ''; i += 1; } else if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; out += '"'; continue; }
    if (c === '/' && t[i + 1] === '/') { while (i < t.length && t[i] !== '\n') i += 1; out += '\n'; continue; }
    if (c === '/' && t[i + 1] === '*') { i += 2; while (i < t.length && !(t[i] === '*' && t[i + 1] === '/')) i += 1; i += 1; continue; }
    out += c;
  }
  // 单引号字符串的结尾引号在上面按原样输出了，这里统一成双引号（仅处理不含双引号的简单单引号串）
  out = out.replace(/"([^"\\\n]*)'/g, '"$1"');
  return JSON.parse(out.replace(/,\s*([}\]])/g, '$1'));
}

/** 返回 [{ uin, wsUrl, token, file }]，按 uin 排序。目录不存在返回 []；目录或文件存在却读不了（权限 / 隐私保护）时抛 DiscoveryUnreadableError。 */
export function discoverNapCatEndpoints(dir) {
  if (!dir) return [];
  const out = new Map();
  for (const d of [path.join(dir, 'config'), dir]) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (err) { classifyReadError(err, d); continue; }
    for (const e of entries) {
      if (!e.isFile()) continue;
      const m = /^onebot11_(\d+)\.json$/i.exec(e.name);
      if (!m || out.has(m[1])) continue;
      let text;
      try { text = fs.readFileSync(path.join(d, e.name), 'utf8'); } catch (err) { classifyReadError(err, path.join(d, e.name)); continue; }
      try {
        const cfg = parseLooseJson(text);
        const ws = (cfg?.network?.websocketServers ?? []).find((s) => s?.enable === true);
        if (!ws) continue;
        const host = !ws.host || ws.host === '0.0.0.0' || ws.host === '::' ? '127.0.0.1' : String(ws.host);
        out.set(m[1], { uin: m[1], wsUrl: `ws://${host}:${Number(ws.port) || 3001}`, token: String(ws.token ?? ''), file: path.join(d, e.name) });
      } catch {
        // 单个文件坏了不影响其他账号
      }
    }
  }
  return [...out.values()].sort((a, b) => a.uin.localeCompare(b.uin));
}
