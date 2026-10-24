#!/usr/bin/env node
/**
 * 下载语义检索用的 ONNX 模型（bge-small-zh-v1.5 int8）。
 *
 *   node scripts/fetch-model.mjs [--force]
 *
 * 从 ModelScope 下载（HF 与 hf-mirror 在本机不可达；npm registry 与 modelscope 可用）。
 * 目标目录是 `models/bge-small-zh-v1.5/`（已被 .gitignore 忽略，不进仓库）。
 */
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(ROOT, 'models', 'bge-small-zh-v1.5');
const REPO = 'Xenova/bge-small-zh-v1.5';
const BASE = `https://www.modelscope.cn/api/v1/models/${REPO}/repo?Revision=master&FilePath=`;
const FILES = [
  ['onnx/model_quantized.onnx', 20_000_000],
  ['vocab.txt', 100_000],
  ['config.json', 100],
  ['tokenizer_config.json', 100],
];
const force = process.argv.includes('--force');

mkdirSync(join(TARGET, 'onnx'), { recursive: true });

for (const [file, minBytes] of FILES) {
  const dest = join(TARGET, file);
  if (!force && existsSync(dest) && statSync(dest).size >= minBytes) {
    console.log(`skip  ${file} (already ${(statSync(dest).size / 1e6).toFixed(1)} MB)`);
    continue;
  }
  process.stdout.write(`fetch ${file} ... `);
  const started = Date.now();
  const response = await fetch(BASE + encodeURIComponent(file), { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) {
    console.log(`FAILED ${response.status}`);
    process.exitCode = 1;
    continue;
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));
  console.log(`ok ${(statSync(dest).size / 1e6).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

console.log(`\nmodel dir: ${TARGET}`);
console.log('enable: config.json → {"semantic":{"enabled":true}} 然后 node scripts/embed.mjs');
