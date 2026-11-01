// QQ 侧出图 CLI
//
// 只做一件事：预设 + 追加描述 → 一张 PNG（同目录写 .json 记录参数）。
// 鉴权、配额、队列都在桥接侧，这里不判断谁能画谁不能画。
//
// 用法：
//   node qq_draw.mjs --preset stand
//   node qq_draw.mjs --preset daily --extra "坐在窗边看书"
//   node qq_draw.mjs --preset stand --out D:\out\a.png --seed 42
//   node qq_draw.mjs --list
//
// 输出：最后一行打一行 JSON，便于桥接解析：
//   {"ok":true,"file":"…","preset":"stand","seed":123,"character":"xixi","nsfw":false}
//   {"ok":false,"error":"…","code":"bad_preset"}
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateToFile, DEFAULT_NEGATIVE, listCheckpoints, freeMemory } from './lib/comfy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PRESET_FILE = process.env.DRAW_PRESETS || join(HERE, 'draw_presets.json');
const OUT_ROOT = process.env.DRAW_OUT_DIR || 'D:\\deepseek_workspace\\outputs\\qq';
const MAX_EXTRA = 120;

function fail(code, error) {
  const payload = JSON.stringify({ ok: false, code, error });
  emit(payload);
  process.exit(2);
}

// 结果同时走 stdout 和 --result 文件：
// 桥接在受限环境下不能管道读 stdout（spawn EPERM），所以文件才是可靠通道。
function emit(payload) {
  const i = process.argv.indexOf('--result');
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    try {
      mkdirSync(dirname(process.argv[i + 1]), { recursive: true });
      writeFileSync(process.argv[i + 1], payload, 'utf8');
    } catch {
      /* 写不了就只走 stdout */
    }
  }
  console.log(payload);
}

function argOf(argv, name) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return null;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : null;
}

function sanitizeExtra(raw, maxLen = MAX_EXTRA) {
  if (!raw) return '';
  return raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/[<>{}]/g, '')
    .trim()
    .slice(0, maxLen);
}

// 汐的模板里已经写死了「single tail, one tail, tail fin, fluke」。
// 如果 extra 里再出现尾巴相关词，模型会把它当成第二处尾巴来画 —— 这是线上双尾的主要来源。
// 所以对 character=xixi 的预设，把 extra 里的尾巴词条剔除（保留 fin ears 等耳部词）。
function stripTailTokens(extra) {
  if (!extra) return '';
  return extra
    .replace(/\b(?:whale\s+tail|fish\s+tail|mermaid\s+tail|dolphin\s+tail)\b/gi, '')
    .replace(/\b(?:two|multiple|double|extra|single|one)\s+tails?\b/gi, '')
    .replace(/\b(?:tail\s+fin|tailfin|fluke|flukes|tails?)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/,\s*,/g, ',')
    .replace(/^\s*,|,\s*$/g, '')
    .trim();
}

function todayDir() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function main() {
  const argv = process.argv.slice(2);

  let presets;
  try {
    presets = JSON.parse(readFileSync(PRESET_FILE, 'utf8'));
  } catch (e) {
    fail('bad_presets', `读不到预设表 ${PRESET_FILE}：${e.message}`);
  }

  if (argv.includes('--list')) {
    const rows = Object.entries(presets.presets).map(([k, v]) => ({ preset: k, character: v.character, nsfw: !!v.nsfw, label: v.label }));
    emit(JSON.stringify({ ok: true, presets: rows }, null, 2));
    return;
  }

  const name = argOf(argv, 'preset');
  if (!name) fail('bad_args', '缺少 --preset');
  const p = presets.presets[name];
  if (!p) fail('bad_preset', `没有这个预设：${name}`);

  // 自由提示词类预设需要更长的 extra（最多 320 字），普通预设仍限 120。
  // character=xixi 时剔除 extra 里的尾巴词，避免模板的尾巴与 extra 的尾巴叠成双尾。
  let extra = sanitizeExtra(argOf(argv, 'extra'), Number(p.maxExtra) || MAX_EXTRA);

  // 中文（或任何 CJK）进了 CLIP 等于没写：模型完全忽略，画面不按描述走。
  // 与其静默丢弃、让模型以为已经按描述画了，不如直接报错让它改写成英文标签重试。
  if (/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/.test(extra)) {
    fail(
      'extra_not_english',
      'extra 里检测到中文/日文。模型只认英文 Danbooru 标签，请把描述翻成英文再试，例如「站在窗边做家务」→ `standing by window, cleaning, holding cloth, window light`',
    );
  }

  if (p.character === 'xixi') extra = stripTailTokens(extra);
  const prompt = p.prompt.replace('{extra}', extra || 'beautiful detailed scene').trim();
  if (prompt.includes('{extra}')) fail('bad_preset', '预设里 {extra} 没被替换');

  const negKey = p.negative;
  const negative = (negKey && presets.negatives?.[negKey]) || negKey || DEFAULT_NEGATIVE;

  const d = presets.defaults ?? {};
  const size = p.size ?? d.size ?? '2:3';
  const steps = p.steps ?? d.steps ?? 30;
  const cfg = p.cfg ?? d.cfg ?? 5.5;
  const sampler = p.sampler ?? d.sampler ?? 'euler_ancestral';
  const scheduler = p.scheduler ?? d.scheduler ?? 'normal';
  const seedArg = argOf(argv, 'seed');
  const seed = seedArg ? Number(seedArg) : null;

  const checkpoints = await listCheckpoints();
  // 底模解析顺序：预设自带 model > 顶层 model > ComfyUI 第一个可用。
  // 有了它，「场景/成人向用 WAI、白底立绘用 Illustrious」可以按预设分别指定。
  const model = p.model ?? presets.model ?? checkpoints[0];
  if (!Array.isArray(checkpoints) || !checkpoints.includes(model)) {
    fail('bad_model', `ComfyUI 里没有基座 ${model}；可用：${(checkpoints || []).join(', ')}`);
  }
  // 只加载预设需要的 LoRA；generic 不挂 v15。
  const lora = p.lora || null;
  if (lora && !checkpoints.length) fail('bad_model', 'ComfyUI 不可用');

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  const outPath = resolve(argOf(argv, 'out') || join(OUT_ROOT, todayDir(), `${stamp}-${rand}.png`));
  mkdirSync(dirname(outPath), { recursive: true });

  // 与训练共存：出图前释放别人的显存（不释放自己的），失败不致命。
  await freeMemory();

  try {
    const r = await generateToFile({
      destPath: outPath,
      prompt,
      negative,
      model,
      lora,
      loraStrength: p.loraStrength ?? 1,
      size,
      steps,
      cfg,
      seed,
      sampler,
      scheduler,
      timeoutMs: Number(process.env.DRAW_TIMEOUT_MS || 240_000),
    });
    emit(
      JSON.stringify({
        ok: true,
        file: r.file,
        preset: name,
        label: p.label,
        character: p.character,
        nsfw: !!p.nsfw,
        seed: r.seed,
        params: r.params,
      }),
    );
  } catch (e) {
    fail('gen_failed', e.message);
  }
}

main().catch((e) => fail('unhandled', e.message));
