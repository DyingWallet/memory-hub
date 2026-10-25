#!/usr/bin/env node
// 生成 / 查看 / 轮换 / 删除管理通道 L3 的 TOTP 秘密（只在本机终端操作，绝不经过 QQ 或模型）。
//
// 用法（在仓库根目录执行）：
//   node scripts/admin-totp-setup.mjs            # 首次生成；已存在时拒绝覆盖
//   node scripts/admin-totp-setup.mjs --show     # 再次显示 otpauth URI（换手机时用）
//   node scripts/admin-totp-setup.mjs --rotate   # 轮换：旧秘密立即作废
//   node scripts/admin-totp-setup.mjs --remove   # 删除：L3 将不可开启
//   node scripts/admin-totp-setup.mjs --verify 123456   # 用验证器上的动态码自检
//
// 秘密存放在 state/admin/totp.json（state/ 不入库，启动时 ACL 收紧）。
// 也可以不落盘：设置环境变量 QQ_BRIDGE_TOTP_SECRET（Base32），桥接优先使用它。
// 把下面打印的 URI 导入手机验证器（Google Authenticator / Microsoft Authenticator / 1Password 等，
// 大多支持「输入设置密钥」：账户名随意，密钥填 Base32 秘密，类型选「基于时间」）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSecret, otpauthUri, verifyTotp } from '../src/admin/totp.js';
import { atomicWriteJsonFile } from '../src/lib/json-store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'state', 'admin', 'totp.json');
const args = process.argv.slice(2);
const has = (f) => args.includes(f);

function read() {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').trim()); } catch { return null; }
}

function show(seed) {
  console.log('\n请在手机验证器里添加这个账户（只在本机终端显示，不要截图发到 QQ）：');
  console.log(`  密钥（Base32）：${seed}`);
  console.log(`  otpauth URI ：${otpauthUri(seed)}`);
  console.log('\n添加后运行：node scripts/admin-totp-setup.mjs --verify <验证器上的6位数> 自检。');
}

if (process.env.QQ_BRIDGE_TOTP_SECRET) {
  console.log('注意：已设置环境变量 QQ_BRIDGE_TOTP_SECRET，桥接会优先使用它，state/admin/totp.json 不生效。');
}

if (has('--remove')) {
  try { fs.rmSync(file, { force: true }); } catch {}
  console.log('已删除 TOTP 秘密：L3 高权限将无法开启（重启桥接后生效）。');
  process.exit(0);
}

if (has('--verify')) {
  const code = args[args.indexOf('--verify') + 1];
  const seed = process.env.QQ_BRIDGE_TOTP_SECRET || read()?.secret;
  if (!seed) { console.error('还没有配置 TOTP 秘密。'); process.exit(1); }
  const r = verifyTotp(seed, code);
  console.log(r.ok ? '✅ 动态码正确，验证器配置无误。' : `❌ 动态码不正确（${r.reason}）。请检查手机时间是否自动同步。`);
  process.exit(r.ok ? 0 : 1);
}

const existing = read();
if (has('--show')) {
  if (!existing?.secret) { console.error('还没有配置 TOTP 秘密，先运行不带参数的命令生成。'); process.exit(1); }
  show(existing.secret);
  process.exit(0);
}
if (existing?.secret && !has('--rotate')) {
  console.error('TOTP 秘密已存在。要查看请加 --show；要换新的请加 --rotate（旧验证器条目将失效）。');
  process.exit(1);
}

const seed = generateSecret();
atomicWriteJsonFile(file, { secret: seed, createdAt: new Date().toISOString(), note: '管理通道 L3 二次认证秘密：不要提交、不要发到 QQ、不要贴给 AI' });
try {
  const { hardenDir } = await import('../src/state-acl.mjs');
  hardenDir?.(path.dirname(file));
} catch {}
console.log(existing ? '已轮换 TOTP 秘密（旧的已作废）。' : '已生成 TOTP 秘密。');
console.log(`保存位置：${path.relative(root, file)}`);
show(seed);
