/**
 * Health metrics as append-only CSV.
 *
 * One row per poll: timestamp, ok flag, latency, and the index counters from
 * `/v1/health`. `scripts/monitor.mjs` appends; the file stays small (a row is
 * ~80 bytes, hourly polling is ~0.7 MB/year).
 */
import { appendFileSync, existsSync } from 'node:fs';

export const METRICS_HEADER = 'at,iso,ok,latency_ms,docs,facts,chunks,uptime_s,error';

export interface HealthSample {
  at: number;
  ok: boolean;
  latencyMs: number;
  docs?: number;
  facts?: number;
  chunks?: number;
  uptimeS?: number;
  error?: string;
}

function cell(value: string | number | undefined): string {
  if (value === undefined) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function appendHealthSample(file: string, sample: HealthSample): void {
  const line = [
    sample.at,
    new Date(sample.at).toISOString(),
    sample.ok ? 1 : 0,
    sample.latencyMs,
    sample.docs,
    sample.facts,
    sample.chunks,
    sample.uptimeS,
    sample.error,
  ]
    .map((value) => cell(value))
    .join(',');
  if (!existsSync(file)) appendFileSync(file, `${METRICS_HEADER}\n`, 'utf8');
  appendFileSync(file, `${line}\n`, 'utf8');
}
