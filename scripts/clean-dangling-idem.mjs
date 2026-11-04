#!/usr/bin/env node
/**
 * 清理「悬空幂等键」：meta 里 `idem:*` / `dedupe:*` 指向的文档已经不在 docs 表。
 *
 * 背景（2026-11-04 对账 missing 1）：
 *   forgetFact 过去只删 docs/chunks，不清 meta 里的幂等映射。之后同一条记忆再写入时，
 *   /v1/write 命中 idem 直接返回 duplicate（id 指向已删文档），新内容写不进去；
 *   reconcile --fix 又把 duplicate 当成「已修好」，于是每次对账都报同一条 missing。
 *
 *   服务端已修（forgetFact 现在连带清 idem/dedupe），这个脚本只清历史存量。
 *
 * 用法（**必须先停 memd**，它持有这个 SQLite 文件）：
 *   powershell -File scripts\stop.ps1
 *   node scripts\clean-dangling-idem.mjs            # 只列出来
 *   node scripts\clean-dangling-idem.mjs --apply    # 删除
 *   powershell -File scripts\start.ps1
 *
 * 退出码：0 正常（含「没有悬空键」）、2 --apply 时写库失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultDb = path.join(here, '..', 'data', 'index.db');

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const dbFlag = argv.indexOf('--db');
const dbPath = dbFlag >= 0 && argv[dbFlag + 1] ? path.resolve(argv[dbFlag + 1]) : defaultDb;

if (!fs.existsSync(dbPath)) {
  console.error(`找不到索引：${dbPath}`);
  process.exit(2);
}

const db = new DatabaseSync(dbPath);
try {
  const docs = new Set(db.prepare('SELECT id FROM docs').all().map((row) => row.id));
  const rows = db.prepare("SELECT key, value FROM meta WHERE key LIKE 'idem:%' OR key LIKE 'dedupe:%'").all();
  const dangling = rows.filter((row) => !docs.has(row.value));

  console.log(`索引：${dbPath}`);
  console.log(`docs：${docs.size}，idem/dedupe 键：${rows.length}，悬空：${dangling.length}`);
  for (const row of dangling) {
    console.log(`  [悬空] ${row.key} -> ${row.value}`);
  }

  if (dangling.length === 0) {
    console.log('没有需要清理的键。');
    process.exit(0);
  }
  if (!apply) {
    console.log('\n只列出，没有写入。确认 memd 已停止后加 --apply。');
    process.exit(0);
  }

  const del = db.prepare('DELETE FROM meta WHERE key = ?');
  db.exec('BEGIN');
  try {
    for (const row of dangling) del.run(row.key);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    console.error(`删除失败：${error?.message ?? error}`);
    process.exit(2);
  }
  console.log(`\n已删除 ${dangling.length} 个悬空键。`);
} finally {
  db.close();
}
