#!/usr/bin/env node
/**
 * 生成年表：`memories/10-journal/annual-YYYY.md`
 *
 * 把 facts（含归档 .gz）和 `10-journal/` 的日记按月聚合，整篇重写。
 * 年表是给人看、也给检索用的时间线；`/v1/timeline` 是同一件事的程序接口。
 *
 * 幂等：内容没变就不写文件，避免 mtime 抖动触发无谓的 reindex。
 *
 *   node scripts/build-timeline.mjs                 # 所有年份
 *   node scripts/build-timeline.mjs --year 2026
 *   node scripts/build-timeline.mjs --dry-run
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../packages/server/dist/config.js';
import { readFactLines } from '../packages/server/dist/archive.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const yearIndex = args.indexOf('--year');
const onlyYear = yearIndex >= 0 ? args[yearIndex + 1] : undefined;

const config = loadConfig();
const journalDir = join(config.memoriesDir, '10-journal');

function monthOf(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function dayOf(value) {
  return String(new Date(value).getDate()).padStart(2, '0');
}

/** 历史上有几条 fact 是 GBK/UTF-8 转码事故写坏的，全是 `?`，进年表只是噪声。 */
function looksMojibake(text) {
  if (text.length < 8) return false;
  const questionMarks = (text.match(/\?/g) ?? []).length;
  return questionMarks / text.length > 0.3;
}

const entries = [];
const seenText = new Set();
let skipped = 0;

for (const line of readFactLines(config.factsDir)) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    continue;
  }
  if (record.deleted === true || typeof record.text !== 'string' || typeof record.ts !== 'string') continue;
  // 年表是「留下来的东西」：短期聊天会过期，塞进来只是噪声。
  if (record.stage === 'short' || record.kind === 'chat') continue;
  const text = record.text.replace(/\s+/g, ' ').trim();
  if (text.length === 0) continue;
  if (looksMojibake(text)) {
    skipped += 1;
    continue;
  }
  const key = `${record.ts.slice(0, 10)}\u0000${text}`;
  if (seenText.has(key)) continue;
  seenText.add(key);
  const month = monthOf(record.ts);
  if (!month) continue;
  entries.push({
    month,
    day: dayOf(record.ts),
    text: text.slice(0, 120),
    kind: record.kind ?? 'note',
    subject: record.subject ?? 'owner',
    supersedes: typeof record.supersedes === 'string' ? record.supersedes : null,
  });
}

/** 日记按约定放在 `10-journal/YYYY-MM/`，所以这里要递归。 */
function listJournalFiles(dir) {
  const out = [];
  const walk = (current) => {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md') && !entry.name.startsWith('annual-')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

if (existsSync(journalDir)) {
  for (const name of listJournalFiles(journalDir)) {
    const raw = readFileSync(name, 'utf8');
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
    if (!front) continue;
    const dateMatch = /^date:\s*(.+)$/m.exec(front[1]);
    if (!dateMatch) continue;
    const month = monthOf(dateMatch[1].trim());
    if (!month) continue;
    const heading = /^#\s+(.+)$/m.exec(raw.slice(front[0].length));
    entries.push({
      month,
      day: dayOf(dateMatch[1].trim()),
      text: (heading?.[1] ?? name).trim().slice(0, 120),
      kind: 'journal',
      subject: 'owner',
      supersedes: null,
    });
  }
}

entries.sort((a, b) => a.month.localeCompare(b.month) || a.day.localeCompare(b.day));

const byYear = new Map();
for (const entry of entries) {
  const year = entry.month.slice(0, 4);
  if (onlyYear && year !== onlyYear) continue;
  if (!byYear.has(year)) byYear.set(year, new Map());
  const months = byYear.get(year);
  if (!months.has(entry.month)) months.set(entry.month, []);
  months.get(entry.month).push(entry);
}

if (byYear.size === 0) {
  console.log(`nothing to write (facts dir: ${config.factsDir})`);
  process.exit(0);
}

mkdirSync(journalDir, { recursive: true });
let written = 0;
let unchanged = 0;

for (const [year, months] of [...byYear.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  const total = [...months.values()].reduce((sum, items) => sum + items.length, 0);
  const lines = [
    '---',
    `date: ${new Date().toISOString().slice(0, 10)}`,
    'kind: journal',
    `tags: [timeline, annual, ${year}]`,
    'source: build-timeline',
    '---',
    '',
    `# ${year} 年表`,
    '',
    `> 由 \`scripts/build-timeline.mjs\` 生成，整篇覆盖，别手改。`,
    `> 共 ${total} 条：记忆事实 + 日记标题，按时间排。`,
    '',
  ];
  for (const [month, items] of [...months.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`## ${month}（${items.length} 条）`);
    lines.push('');
    for (const item of items) {
      const replaced = item.supersedes ? '（替代了更早的一条）' : '';
      lines.push(`- **${item.day}** [${item.kind}/${item.subject}] ${item.text}${replaced}`);
    }
    lines.push('');
  }
  const content = `${lines.join('\n').trimEnd()}\n`;
  const file = join(journalDir, `annual-${year}.md`);
  const previous = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (previous === content) {
    unchanged += 1;
    console.log(`${file} unchanged (${total} entries)`);
    continue;
  }
  if (dryRun) {
    console.log(`${file} would be written (${total} entries)`);
    continue;
  }
  writeFileSync(file, content, 'utf8');
  written += 1;
  console.log(`${file} written (${total} entries)`);
}

if (!dryRun) {
  console.log(`\nwritten: ${written}, unchanged: ${unchanged}${skipped > 0 ? `, skipped(mojibake): ${skipped}` : ''}`);
  if (written > 0) console.log('next: node packages/admin/dist/cli.js reindex   # 让年表进检索');
}
