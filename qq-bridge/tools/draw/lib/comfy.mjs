// ComfyUI 客户端（供 gen_xi.mjs / qq_draw.mjs 共用）
//
// 抽出来的原因：QQ 侧出图和数据集出图必须**用同一套参数与工作流**，
// 否则同一句提示词两边出的不是同一张（diffusers 与 ComfyUI 不等价的教训）。
//
// 只依赖 Node 18+ 内置 fetch 与 fs，不需要 npm 包。
import { readFileSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export const COMFY = (process.env.COMFY_ENDPOINT || 'http://127.0.0.1:8188').replace(/\/+$/, '');
export const OUTPUT_DIR =
  process.env.COMFY_OUTPUT_DIR || 'D:\\AI_Stuff\\ComfyUI_windows_portable\\ComfyUI\\output';
export const POLL_MS = 700;

export const SIZES = {
  '1:1': [1024, 1024],
  '2:3': [832, 1216],
  '3:2': [1216, 832],
  '3:4': [896, 1152],
  '4:3': [1152, 896],
  '16:9': [1344, 768],
  '9:16': [768, 1344],
};

// 2026-10-30 实测：这一段压得住「粉耳/尖耳/多尾」，且不压画风。
export const DEFAULT_NEGATIVE = [
  'lowres, bad anatomy, bad hands, worst quality, low quality, jpeg artifacts, blurry',
  'pink ears, cat ears, animal ears, pointy ears, elf ears, horns, human ears',
  'flat color, oversaturated, thick outlines, extra tails, multiple tails',
  'text, watermark, signature',
].join(', ');

const clientId = `dsh-draw-${Date.now().toString(36)}`;

export async function api(pathname, init) {
  const res = await fetch(`${COMFY}${pathname}`, {
    ...init,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ComfyUI ${pathname} -> HTTP ${res.status}${body ? `：${body.slice(0, 300)}` : ''}`);
  }
  return res.json();
}

export async function uploadImage(localPath) {
  const buf = readFileSync(localPath);
  const form = new FormData();
  form.append('image', new Blob([buf], { type: 'image/png' }), basename(localPath));
  form.append('overwrite', 'true');
  const res = await fetch(`${COMFY}/upload/image`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`上传参考图失败：HTTP ${res.status}`);
  const json = await res.json();
  return json.subfolder ? `${json.subfolder}/${json.name}` : json.name;
}

export function buildWorkflow({
  model,
  positive,
  negative,
  width,
  height,
  steps,
  cfg,
  seed,
  sampler = 'euler_ancestral',
  scheduler = 'normal',
  prefix,
  lora = null,
  loraStrength = 1,
  // Anima 系（Qwen 文本编码器）必须走 UNETLoader + CLIPLoader + VAELoader 三件套，
  // 不能用 CheckpointLoaderSimple 加载。
  arch = 'sdxl',
  unet = null,
  textEncoder = null,
  vae = null,
}) {
  const isAnima = arch === 'anima';
  const wf = {};
  let modelSrc;
  let clipSrc;
  let vaeSrc;

  if (isAnima) {
    if (!unet || !textEncoder || !vae) {
      throw new Error('Anima 需要 unet / textEncoder / vae 三个字段');
    }
    wf[5] = { class_type: 'UNETLoader', inputs: { unet_name: unet, weight_dtype: 'default' } };
    wf[20] = { class_type: 'CLIPLoader', inputs: { clip_name: textEncoder, type: 'stable_diffusion' } };
    wf[21] = { class_type: 'VAELoader', inputs: { vae_name: vae } };
    modelSrc = ['5', 0];
    clipSrc = ['20', 0];
    vaeSrc = ['21', 0];
  } else {
    wf[5] = { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: model } };
    modelSrc = ['5', 0];
    clipSrc = ['5', 1];
    vaeSrc = ['5', 2];
  }

  Object.assign(wf, {
    6: { class_type: 'CLIPTextEncode', inputs: { text: positive, clip: clipSrc } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: clipSrc } },
    10: { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    8: {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps,
        cfg,
        sampler_name: sampler,
        scheduler,
        denoise: 1,
        model: modelSrc,
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['10', 0],
      },
    },
    9: { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: vaeSrc } },
    11: { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: prefix } },
  });

  if (lora) {
    wf[30] = {
      class_type: 'LoraLoader',
      inputs: { model: modelSrc, clip: clipSrc, lora_name: lora, strength_model: loraStrength, strength_clip: loraStrength },
    };
    wf[6].inputs.clip = ['30', 1];
    wf[7].inputs.clip = ['30', 1];
    wf[8].inputs.model = ['30', 0];
  }
  return wf;
}

export async function waitFor(pid, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const history = await api(`/history/${pid}`);
    const entry = history?.[pid];
    if (entry) {
      if (entry.status?.status_str === 'error') {
        throw new Error(`执行失败：${JSON.stringify(entry.status?.messages ?? {}).slice(0, 400)}`);
      }
      const images = entry.outputs?.['11']?.images ?? [];
      if (images.length) return images;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`等图超时（${Math.round(timeoutMs / 1000)}s）`);
}

export async function listCheckpoints() {
  const info = await api('/object_info/CheckpointLoaderSimple');
  const names = info?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
  return Array.isArray(names) ? names : [];
}

/** 释放 ComfyUI 占用的显存（训练与出图共存时必须先调，否则会互相饿死）。 */
export async function freeMemory() {
  try {
    await api('/free', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 生成一张图并保存到 destPath。
 * @returns {{ file: string, seed: number, params: object }}
 */
export async function generateToFile({
  destPath,
  prompt,
  negative = DEFAULT_NEGATIVE,
  model,
  lora = null,
  loraStrength = 1,
  size = '2:3',
  steps = 30,
  cfg = 5.5,
  seed = null,
  sampler = 'euler_ancestral',
  scheduler = 'normal',
  timeoutMs = 300_000,
  arch = 'sdxl',
  unet = null,
  textEncoder = null,
  vae = null,
}) {
  const [width, height] = SIZES[size] ?? SIZES['2:3'];
  const useSeed = seed ?? Math.floor(Math.random() * 2 ** 31);
  const prefix = `qq_${Date.now().toString(36)}`;

  const wf = buildWorkflow({
    model,
    positive: prompt,
    negative,
    width,
    height,
    steps,
    cfg,
    seed: useSeed,
    sampler,
    scheduler,
    prefix,
    lora,
    loraStrength,
    arch,
    unet,
    textEncoder,
    vae,
  });

  const queued = await api('/prompt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: wf, client_id: clientId }),
  });
  if (queued?.node_errors && Object.keys(queued.node_errors).length) {
    throw new Error(`节点报错：${JSON.stringify(queued.node_errors).slice(0, 400)}`);
  }

  const images = await waitFor(queued.prompt_id, timeoutMs);
  const img = images[0];
  const src = [OUTPUT_DIR.replace(/[\\/]+$/, ''), img.subfolder, img.filename].filter(Boolean).join('\\');

  mkdirSync(join(destPath, '..'), { recursive: true });
  copyFileSync(src, destPath);
  writeFileSync(
    destPath.replace(/\.png$/i, '.json'),
    JSON.stringify(
      { prompt, negative, model, arch, unet, textEncoder, vae, lora, loraStrength: lora ? loraStrength : null, size, steps, cfg, seed: useSeed, sampler, scheduler },
      null,
      2,
    ),
    'utf8',
  );

  return { file: destPath, seed: useSeed, params: { model, arch, lora, loraStrength, size, steps, cfg } };
}
