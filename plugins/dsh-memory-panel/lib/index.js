/**
 * Host half of the memory-hub settings panel.
 *
 * The page runs inside DSH's renderer. Chromium 152 blocks direct loopback
 * fetches from an opaque-origin frame (Local Network Access), so the page talks
 * to these same-origin routes and this host plugin proxies to memd. Only the
 * fixed endpoints in ROUTES are exposed; the browser never gets a generic proxy.
 *
 * Zero-config: when the page sends no Authorization header, the host injects the
 * desktop root token from `~/.dsh/memory-token` (override with MEMD_TOKEN_FILE).
 * That is the same secret the page used to ask the user to paste, and the page
 * already runs in the trusted renderer, so this only removes a manual step. The
 * panel still accepts an explicit token and then forwards that instead.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const name = 'dsh-memory-panel';
export const inject = ['webServer'];

const MEMD = 'http://127.0.0.1:8787';
const TOKEN_FILE = process.env.MEMD_TOKEN_FILE ?? join(homedir(), '.dsh', 'memory-token');
const ROUTES = new Map([
  ['/memory-hub/health', { method: 'GET', target: '/v1/health' }],
  ['/memory-hub/config-state', { method: 'GET', target: '/v1/config-state' }],
  ['/memory-hub/config', { method: 'POST', target: '/v1/config' }],
  ['/memory-hub/tokens', { method: 'GET', target: '/v1/tokens' }],
  ['/memory-hub/tokens/revoke', { method: 'POST', target: '/v1/tokens/revoke' }],
  ['/memory-hub/timeline', { method: 'POST', target: '/v1/timeline' }],
]);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-private-network': 'true',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

/** 宿主侧读 root 令牌；页面没带 Authorization 时用它兜底。 */
function hostAuthorization() {
  try {
    const token = readFileSync(TOKEN_FILE, 'utf8').trim();
    return token.length > 0 ? `Bearer ${token}` : undefined;
  } catch {
    return undefined;
  }
}

/** 在 memory-hub/data/plugin-load/<name>.json 写一条带时间戳与 pid 的加载记录。 */
function writeLoadMarker(name) {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const file = join(here, '..', '..', '..', 'data', 'plugin-load', `${name}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify({ name, at: new Date().toISOString(), pid: process.pid }, null, 2)}\n`,
      'utf8',
    );
  } catch {
    // 只影响自检，不影响代理。
  }
}

/**
 * 启动后自检：等 8 秒（memd 与另一个插件都稳定）跑一次 doctor，结果写进
 * logs/doctor-boot.log 与 data/doctor-last.json。`MEMD_BOOT_CHECK=0` 可关掉。
 * 任何异常都只打一行 warning——自检永远不能影响面板。
 */
function scheduleBootCheck() {
  if (process.env.MEMD_BOOT_CHECK === '0') return;
  const timer = setTimeout(() => {
    void (async () => {
      try {
        const here = dirname(fileURLToPath(import.meta.url));
        const doctorUrl = pathToFileURL(join(here, '..', '..', '..', 'scripts', 'doctor.mjs')).href;
        const { runDoctor, recordBootCheck } = await import(doctorUrl);
        const summary = recordBootCheck(await runDoctor());
        if (!summary.ready) {
          console.warn(`[dsh-memory-panel] 启动自检未通过：${summary.failed.join(', ')}（logs/doctor-boot.log）`);
        }
      } catch (error) {
        console.warn(`[dsh-memory-panel] 启动自检失败：${error?.message ?? error}`);
      }
    })();
  }, 8000);
  timer.unref?.();
}

export function apply(ctx) {
  // 加载标记：doctor 用它判断「安装之后有没有重启」。
  writeLoadMarker('dsh-memory-panel');
  // 启动后自检：等 memd/插件都稳定了再跑一次，结果进 logs/doctor-boot.log 与
  // data/doctor-last.json。任何失败都只写日志，不影响面板本身。
  scheduleBootCheck();
  for (const [path, route] of ROUTES) {
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          if (req.method === 'OPTIONS') {
            res.writeHead(204, {
              'access-control-allow-origin': '*',
              'access-control-allow-methods': 'GET,POST,OPTIONS',
              'access-control-allow-headers': 'authorization,content-type',
              'access-control-allow-private-network': 'true',
              'access-control-max-age': '600',
            });
            res.end();
            return;
          }
          if (req.method !== route.method) {
            sendJson(res, 405, { error: { code: 'method_not_allowed', message: `use ${route.method}` } });
            return;
          }
          try {
            const headers = {};
            const authorization =
              typeof req.headers.authorization === 'string' ? req.headers.authorization : hostAuthorization();
            if (authorization) headers.authorization = authorization;
            if (req.method === 'POST') headers['content-type'] = 'application/json';
            const body = req.method === 'POST' ? await readBody(req) : undefined;
            const upstream = await fetch(MEMD + route.target, {
              method: req.method,
              headers,
              body,
              signal: AbortSignal.timeout(6000),
            });
            const text = await upstream.text();
            res.writeHead(upstream.status, {
              'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
              'access-control-allow-origin': '*',
              'access-control-allow-private-network': 'true',
              'cache-control': 'no-store',
            });
            res.end(text);
          } catch (error) {
            sendJson(res, 502, {
              error: { code: 'bad_gateway', message: String((error && error.message) || error) },
            });
          }
        },
      }),
    );
  }
}
