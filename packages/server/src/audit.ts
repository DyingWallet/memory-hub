import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface AuditEntry {
  ts: string;
  token: string;
  surface: string;
  route: string;
  query_hash?: string;
  ids?: string[];
  denied?: number;
  ms?: number;
}

/**
 * Append-only, body-free audit log. Only ids, hashes, scopes, and timings —
 * never query text or memory content. Rotated after 30 days.
 */
export class AuditLog {
  constructor(
    private readonly file: string,
    private readonly retentionDays = 30,
  ) {}

  append(entry: AuditEntry): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (error) {
      console.error(`[audit] write failed: ${(error as Error).message}`);
    }
  }

  /** Drops lines older than the retention window. Runs at startup only. */
  prune(now = Date.now()): void {
    if (!existsSync(this.file)) return;
    const cutoff = now - this.retentionDays * 24 * 60 * 60 * 1000;
    const lines = readFileSync(this.file, 'utf8').split('\n');
    const kept: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const entry = JSON.parse(trimmed) as AuditEntry;
        const ts = Date.parse(entry.ts);
        if (Number.isNaN(ts) || ts >= cutoff) kept.push(trimmed);
      } catch {
        // Keep unparseable lines out of the way; they carry no useful audit data.
      }
    }
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, kept.length > 0 ? `${kept.join('\n')}\n` : '', 'utf8');
    renameSync(tmp, this.file);
  }
}
