/**
 * Host half of the memory-hub settings panel.
 *
 * The page runs inside DSH's renderer. Chromium 152 blocks direct loopback
 * fetches from an opaque-origin frame (Local Network Access), so the page talks
 * to these same-origin routes and this host plugin proxies to memd. Only three
 * fixed endpoints are exposed; the browser never gets a generic proxy.
 */
export const name = 'dsh-memory-panel';
export const inject = ['webServer'];

const MEMD = 'http://127.0.0.1:8787';
const ROUTES = new Map([
  ['/memory-hub/health', { method: 'GET', target: '/v1/health' }],
  ['/memory-hub/config-state', { method: 'GET', target: '/v1/config-state' }],
  ['/memory-hub/config', { method: 'POST', target: '/v1/config' }],
  ['/memory-hub/tokens', { method: 'GET', target: '/v1/tokens' }],
  ['/memory-hub/tokens/revoke', { method: 'POST', target: '/v1/tokens/revoke' }],
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

export function apply(ctx) {
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
            if (typeof req.headers.authorization === 'string') headers.authorization = req.headers.authorization;
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
