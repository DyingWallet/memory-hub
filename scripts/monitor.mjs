#!/usr/bin/env node
/**
 * Poll memd health and append one sample to data/metrics.csv.
 *
 *   node scripts/monitor.mjs            # one sample
 *   node scripts/monitor.mjs --loop 900 # keep sampling every 15 min
 *
 * The endpoint always uses loopback, regardless of the configured bind hosts.
 */
import { join } from 'node:path';
import { loadConfig } from '../packages/server/dist/config.js';
import { appendHealthSample } from '../packages/server/dist/metrics.js';

const config = loadConfig();
const endpoint = `http://127.0.0.1:${config.port}/v1/health`;
const file = join(config.dataDir, 'metrics.csv');
const loopIndex = process.argv.indexOf('--loop');
const loopSeconds = loopIndex >= 0 ? Number(process.argv[loopIndex + 1]) : 0;

async function sample() {
  const started = performance.now();
  const at = Date.now();
  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(3000) });
    const body = await response.json().catch(() => ({}));
    const latencyMs = Math.round(performance.now() - started);
    appendHealthSample(file, {
      at,
      ok: response.ok,
      latencyMs,
      docs: body.index?.docs,
      facts: body.index?.facts,
      chunks: body.index?.chunks,
      uptimeS: body.uptime_s,
    });
    console.log(`ok=${response.ok} latency=${latencyMs}ms docs=${body.index?.docs ?? '-'} facts=${body.index?.facts ?? '-'}`);
    return response.ok;
  } catch (error) {
    const latencyMs = Math.round(performance.now() - started);
    const message = String((error && error.message) || error);
    appendHealthSample(file, { at, ok: false, latencyMs, error: message });
    console.log(`ok=false latency=${latencyMs}ms error=${message}`);
    return false;
  }
}

const ok = await sample();
if (!(loopSeconds > 0)) process.exit(ok ? 0 : 1);
setInterval(sample, loopSeconds * 1000);
