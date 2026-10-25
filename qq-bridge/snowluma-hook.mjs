// Ensure the SnowLuma hook is attached to the bot account's QQ process.
//
// SnowLuma exposes an HTTP API on its WebUI port:
//   POST /api/login                     { password } -> { token }
//   GET  /api/processes                 (header x-snowluma-token)
//   POST /api/processes/:pid/load       inject
//   POST /api/processes/:pid/unload     eject
//
// This script logs in, finds the QQ process whose account.uin matches the bot
// account, injects the hook if needed, then waits until it reports connected.
//
// Credentials live in state/snowluma-webui.json (state/ is ACL-tightened):
//   { "password": "...", "botUin": "10000", "port": 5099 }
//
// Exit codes: 0 ok / already connected, 2 bot account not found,
//             3 inject rejected, 4 timed out.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(ROOT, 'state', 'snowluma-webui.json');

function readConf() {
  const raw = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  return {
    port: Number(raw.port) || 5099,
    password: String(raw.password || ''),
    botUin: String(raw.botUin || ''),
  };
}

const conf = readConf();
const pwd = conf.password;
const base = `http://127.0.0.1:${conf.port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers['x-snowluma-token'] = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

async function main() {
  const login = await api('/api/login', { method: 'POST', body: { password: pwd } });
  if (login.status !== 200 || !login.json.token) {
    console.error(`login failed: HTTP ${login.status} ${JSON.stringify(login.json).slice(0, 200)}`);
    return 3;
  }
  const token = login.json.token;

  let target = null;
  for (let i = 0; i < 60; i++) {
    const list = await api('/api/processes', { token });
    const items = list.json.list || [];
    target = items.find((p) => String(p.account?.uin || '') === conf.botUin) || null;
    if (target) break;
    await sleep(1000);
  }
  if (!target) {
    console.error(`QQ process for uin ${conf.botUin} not found (is that account logged in?)`);
    return 2;
  }

  if (!target.injected) {
    const res = await api(`/api/processes/${target.pid}/load`, { method: 'POST', token });
    if (res.status !== 200 || res.json.success !== true) {
      console.error(`inject rejected: HTTP ${res.status} ${JSON.stringify(res.json).slice(0, 300)}`);
      return 3;
    }
    console.log(`injected hook into pid ${target.pid} (uin ${conf.botUin})`);
  } else {
    console.log(`hook already injected in pid ${target.pid}`);
  }

  for (let i = 0; i < 60; i++) {
    const list = await api('/api/processes', { token });
    const cur = (list.json.list || []).find((p) => String(p.account?.uin || '') === conf.botUin);
    if (cur && (cur.connected || cur.loggedIn)) {
      console.log(`hook connected: uin=${conf.botUin} pid=${cur.pid} status=${cur.status}`);
      return 0;
    }
    await sleep(1000);
  }
  console.error('hook did not report connected within 60s');
  return 4;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('snowluma-hook failed:', err?.message || err);
  process.exit(1);
});
