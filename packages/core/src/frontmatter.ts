/**
 * Minimal YAML front-matter reader/writer for memory Markdown files.
 *
 * Supports exactly what the memory corpus uses: scalar strings/numbers/booleans,
 * inline arrays (`[a, b]`), and dash lists. Nested maps are not supported and
 * are returned as raw strings — the indexer never needs them.
 */

export interface FrontMatter {
  data: Record<string, unknown>;
  body: string;
  /** True when the file started with a `---` fence. */
  present: boolean;
}

const FENCE = /^---\r?\n/;

export function parseFrontMatter(raw: string): FrontMatter {
  const normalized = raw.replaceAll('\r\n', '\n');
  if (!FENCE.test(normalized)) return { data: {}, body: normalized, present: false };

  const end = normalized.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: normalized, present: false };

  const header = normalized.slice(3, end);
  const bodyStart = normalized.indexOf('\n', end + 1);
  const body = bodyStart === -1 ? '' : normalized.slice(bodyStart + 1).replace(/^\n+/, '');

  return { data: parseHeader(header), body, present: true };
}

function parseHeader(header: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  let listKey: string | null = null;

  for (const rawLine of header.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (line.trim().length === 0 || line.trim().startsWith('#')) continue;

    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && listKey) {
      const arr = (data[listKey] as unknown[]) ?? [];
      arr.push(scalar(listItem[1] ?? ''));
      data[listKey] = arr;
      continue;
    }

    const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!pair) continue;
    const key = pair[1] ?? '';
    const value = (pair[2] ?? '').trim();

    if (value.length === 0) {
      listKey = key;
      data[key] = [] as unknown[];
      continue;
    }
    listKey = null;
    data[key] = parseValue(value);
  }
  return data;
}

function parseValue(value: string): unknown {
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((item) => scalar(item.trim()))
      .filter((item) => item.length > 0);
  }
  return scalar(value);
}

function scalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

export function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

export function asStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const out = value.map((v) => asString(v)).filter((v): v is string => typeof v === 'string' && v.length > 0);
    return out.length > 0 ? out : undefined;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return undefined;
}
