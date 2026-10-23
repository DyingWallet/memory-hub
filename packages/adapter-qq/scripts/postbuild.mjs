/**
 * adapter-qq must be importable from the plain-JS QQ bridge with a single
 * stable path: `dist/memory-client.mjs`. tsc emits `.js`, so copy it.
 * The source file deliberately has no imports, so the copy is self-contained.
 */
import { copyFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');
const from = join(dist, 'memory-client.js');
const to = join(dist, 'memory-client.mjs');

if (!existsSync(from)) {
  console.error(`missing build output: ${from}`);
  process.exit(1);
}
copyFileSync(from, to);

const body = readFileSync(from, 'utf8');
const nonBuiltinImport = /^\s*import\s[^;]*from\s+['"](?!node:)[^'"]+['"]/m.test(body);
if (nonBuiltinImport) {
  console.warn('warning: memory-client.js imports non-builtin modules; .mjs copy may not resolve from qq-bridge');
}
writeFileSync(join(dist, 'memory-client.mjs'), body, 'utf8');
console.log(`adapter-qq: wrote ${to}`);
