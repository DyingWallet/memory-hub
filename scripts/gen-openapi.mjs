/**
 * Writes packages/protocol/openapi.json + openapi.yaml from the built route table.
 * Run `pnpm run build` first (imports dist, not src).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument } from '../packages/protocol/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'packages', 'protocol');
const doc = buildOpenApiDocument('0.1.0');

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'openapi.json'), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
writeFileSync(join(outDir, 'openapi.yaml'), toYaml(doc), 'utf8');
console.log(`openapi: ${Object.keys(doc.paths).length} paths -> ${join(outDir, 'openapi.json')}`);

function toYaml(value, indent = 0) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]\n`;
    return value
      .map((item) => {
        if (item !== null && typeof item === 'object') {
          return `${pad}- ${toYaml(item, indent + 2).slice(indent + 2)}`;
        }
        return `${pad}- ${scalar(item)}\n`;
      })
      .join('');
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return `${pad}{}\n`;
    return entries
      .map(([key, val]) => {
        const safeKey = /^[A-Za-z0-9_$.-]+$/.test(key) ? key : JSON.stringify(key);
        if (val !== null && typeof val === 'object') {
          if (Array.isArray(val) && val.length === 0) return `${pad}${safeKey}: []\n`;
          if (!Array.isArray(val) && Object.keys(val).length === 0) return `${pad}${safeKey}: {}\n`;
          return `${pad}${safeKey}:\n${toYaml(val, indent + 2)}`;
        }
        return `${pad}${safeKey}: ${scalar(val)}\n`;
      })
      .join('');
  }
  return `${pad}${scalar(value)}\n`;
}

function scalar(value) {
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const s = String(value);
  if (s.includes('\n')) {
    return `|\n${s
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n')}`;
  }
  if (s === '' || /[:#\[\]{}&*!|>'"%@`,]/.test(s) || /^\s|\s$/.test(s)) return JSON.stringify(s);
  return s;
}
