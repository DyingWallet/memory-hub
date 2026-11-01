// ComfyUI 绘图 MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 为什么自己写而不是装第三方包：
//   - 只需要「提交提示词 → 等出图 → 回路径」这一条链路，第三方动辄上百个工具；
//   - 模型、尺寸、采样器都由本文件钉死，不依赖别人的 workflow 版本；
//   - 零外部依赖（SDK 与 zod 复用 qq-bridge 的 node_modules）。
//
// 环境变量：
//   COMFY_ENDPOINT    ComfyUI 地址，默认 http://127.0.0.1:8188
//   COMFY_OUTPUT_DIR  ComfyUI 的 output 目录，默认 D:\AI_Stuff\ComfyUI_windows_portable\ComfyUI\output
//   COMFY_TIMEOUT_MS  单次出图等待上限，默认 180000
//
// 工具：
//   draw_image    出图，返回 PNG 绝对路径
//   comfy_status  探活 + 列出可用基座
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const COMFY = (process.env.COMFY_ENDPOINT || 'http://127.0.0.1:8188').replace(/\/+$/, '');
const OUTPUT_DIR = process.env.COMFY_OUTPUT_DIR || 'D:\\AI_Stuff\\ComfyUI_windows_portable\\ComfyUI\\output';
const TIMEOUT_MS = Number(process.env.COMFY_TIMEOUT_MS || 180_000);
const POLL_MS = 800;

/** 常用画幅。宽高都按 8 的倍数给，SDXL 系在 1024 附近表现最好。 */
const SIZES = {
  '1:1': [1024, 1024],
  '2:3': [832, 1216],
  '3:2': [1216, 832],
  '3:4': [896, 1152],
  '4:3': [1152, 896],
  '16:9': [1344, 768],
  '9:16': [768, 1344],
};

/**
 * 默认负面提示词。
 *
 * 注意：Illustrious / NoobAI 都是 CFG≈6 的模型，负面词是**有效**的（不像千问那种 cfg=1）。
 * 这一段只压低级错误，不压风格——风格该由调用方在 positive 里给。
 */
const DEFAULT_NEGATIVE =
  'lowres, bad anatomy, bad hands, missing fingers, extra digit, fewer digits, ' +
  'worst quality, low quality, jpeg artifacts, blurry, text, watermark, signature';

let clientId = null;
function getClientId() {
  if (!clientId) clientId = `dsh-comfy-${Date.now().toString(36)}`;
  return clientId;
}

async function api(pathname, init) {
  const res = await fetch(`${COMFY}${pathname}`, {
    ...init,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ComfyUI ${pathname} -> HTTP ${res.status}${body ? `：${body.slice(0, 300)}` : ''}`);
  }
  return res.json();
}

/** 列出 CheckpointLoaderSimple 能加载的基座。 */
async function listCheckpoints() {
  const info = await api('/object_info/CheckpointLoaderSimple');
  const names = info?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
  return Array.isArray(names) ? names : [];
}

/**
 * 把本地参考图传进 ComfyUI 的 input 目录。
 *
 * 走 HTTP `/upload/image` 而不是直接拷文件：MCP server 是 DSH 的子进程，
 * 和用户手动启动的 ComfyUI 不一定在同一个可写上下文里，HTTP 这条路两边都通。
 */
async function uploadImage(localPath) {
  const buf = readFileSync(localPath);
  const form = new FormData();
  form.append('image', new Blob([buf], { type: 'image/png' }), basename(localPath));
  form.append('overwrite', 'true');
  const res = await fetch(`${COMFY}/upload/image`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`上传参考图失败：HTTP ${res.status}${body ? ` ${body.slice(0, 200)}` : ''}`);
  }
  const json = await res.json();
  return json.subfolder ? `${json.subfolder}/${json.name}` : json.name;
}

/** 把 ComfyUI 的 history 输出拼成磁盘绝对路径。 */
function outputPathOf(image) {
  const parts = [OUTPUT_DIR.replace(/[\\/]+$/, '')];
  if (image.subfolder) parts.push(String(image.subfolder).replace(/^[\\/]+|[\\/]+$/g, ''));
  parts.push(String(image.filename));
  return parts.join('\\');
}

/**
 * 标准 SDXL 文生图图：CheckpointLoader → 两个 CLIPTextEncode → KSampler → VAEDecode → SaveImage。
 * 节点 id 与 ComfyUI 默认模板一致，方便对照。
 */
function buildWorkflow({ model, positive, negative, width, height, steps, cfg, seed, sampler, scheduler }) {
  return {
    5: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: model } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: positive, clip: ['5', 1] } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['5', 1] } },
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
        // 有参考图时由 IP-Adapter 改写 model 链路，见下方 ipAdapter 分支。
        model: ['5', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['10', 0],
      },
    },
    9: { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['5', 2] } },
    11: { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: 'xi' } },
  };
}

/**
 * 往文生图图里插入 IP-Adapter 链路。
 *
 *   20 LoadImage ─┐
 *   21 UnifiedLoader（吃 5 的 MODEL）─► 22 IPAdapterAdvanced ─► KSampler.model
 *
 * UnifiedLoader 自己去找 ipadapter 文件与 clip_vision 编码器，所以这里不用指定路径。
 *
 * **end_at 不能给 1.0**（2026-10-30 实机踩坑）：Illustrious 这类 SDXL 深度微调模型，
 * 全程注入会让画面崩成彩虹色 + 油画笔触 + 脸变形，weight 降到 0.6 也没用。
 * 限制在 denoise 前半程（0.4~0.6）就正常——后期让模型自己收敛细节。
 */
function withIPAdapter(workflow, { imageName, weight, endAt, preset }) {
  workflow[20] = { class_type: 'LoadImage', inputs: { image: imageName } };
  workflow[21] = {
    class_type: 'IPAdapterUnifiedLoader',
    inputs: { model: ['5', 0], preset },
  };
  workflow[22] = {
    class_type: 'IPAdapterAdvanced',
    inputs: {
      model: ['21', 0],
      ipadapter: ['21', 1],
      image: ['20', 0],
      weight,
      weight_type: 'linear',
      combine_embeds: 'concat',
      start_at: 0,
      end_at: endAt,
      embeds_scaling: 'V only',
    },
  };
  workflow[8].inputs.model = ['22', 0];
  return workflow;
}

/** 轮询 /history/{id} 直到出图或超时。 */
async function waitForImages(promptId, deadline) {
  while (Date.now() < deadline) {
    const history = await api(`/history/${promptId}`);
    const entry = history?.[promptId];
    if (entry) {
      const status = entry.status ?? {};
      if (status.status_str === 'error') {
        const message = status.messages?.flat?.()?.join?.(' ') ?? '未知错误';
        throw new Error(`ComfyUI 执行失败：${message}`);
      }
      const images = entry.outputs?.['11']?.images ?? [];
      if (images.length > 0) return images;
      if (status.completed === true) throw new Error('ComfyUI 跑完了但没有输出图片（SaveImage 节点没拿到图？）');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`等图超时（${Math.round(TIMEOUT_MS / 1000)} 秒）。ComfyUI 可能还卡在队列里，看它的控制台。`);
}

const server = new McpServer({ name: 'comfyui', version: '1.0.0' });

server.tool(
  'draw_image',
  '用本机 ComfyUI 出图（纯本地，不出网）。返回 PNG 的绝对路径，可直接内联展示。' +
    '提示词用英文 Danbooru 标签最稳：主体 + 外观 + 服装 + 动作 + 场景 + 光线 + 质量词。',
  {
    prompt: z
      .string()
      .min(1)
      .max(2000)
      .describe('画面描述。建议 1girl 或 1boy 开头，逗号分隔标签，末尾加 masterpiece, best quality'),
    negative: z.string().max(1000).optional().describe('负面提示词；不填用默认那一段（压低级错误，不压风格）'),
    size: z
      .enum(Object.keys(SIZES))
      .optional()
      .describe(`画幅：${Object.keys(SIZES).join(' / ')}，默认 1:1`),
    steps: z.number().int().min(8).max(60).optional().describe('采样步数，默认 28'),
    cfg: z.number().min(1).max(15).optional().describe('CFG，二次元模型一般 5~7，默认 6'),
    seed: z.number().int().min(0).optional().describe('种子；同提示词 + 同种子 = 同一张图，不填随机'),
    model: z.string().max(200).optional().describe('基座文件名；不填用第一个可用的'),
    sampler: z.string().max(64).optional().describe('采样器，默认 euler_ancestral'),
    scheduler: z.string().max(64).optional().describe('调度器，默认 normal'),
    reference: z
      .string()
      .max(500)
      .optional()
      .describe(
        '参考图绝对路径。给了就走 IP-Adapter：脸、发型、服装、气质都向这张图靠。' +
          '同一角色补不同角度/表情时必须给，否则每张都会是不同的人。',
      ),
    reference_weight: z
      .number()
      .min(0)
      .max(2)
      .optional()
      .describe('参考图强度，默认 0.85。低了不像，高了会连构图一起抄（1.2+ 容易复刻原图姿势）'),
  },
  async ({ prompt, negative, size, steps, cfg, seed, model, sampler, scheduler, reference, reference_weight }) => {
    const started = Date.now();
    try {
      const checkpoints = await listCheckpoints();
      if (checkpoints.length === 0) {
        return {
          content: [{ type: 'text', text: 'ComfyUI 在跑，但一个 checkpoint 都没有。检查 models\\checkpoints 目录。' }],
          isError: true,
        };
      }
      const chosen = model ?? checkpoints[0];
      if (!checkpoints.includes(chosen)) {
        return {
          content: [{ type: 'text', text: `没有这个基座：${chosen}\n可用：\n${checkpoints.map((n) => `- ${n}`).join('\n')}` }],
          isError: true,
        };
      }

      const [width, height] = SIZES[size ?? '1:1'];
      const workflow = buildWorkflow({
        model: chosen,
        positive: prompt,
        negative: negative ?? DEFAULT_NEGATIVE,
        width,
        height,
        steps: steps ?? 28,
        cfg: cfg ?? 6,
        seed: seed ?? Math.floor(Math.random() * 2 ** 32),
        sampler: sampler ?? 'euler_ancestral',
        scheduler: scheduler ?? 'normal',
      });

      let usedReference = null;
      if (reference) {
        const imageName = await uploadImage(reference);
        withIPAdapter(workflow, {
          imageName,
          weight: reference_weight ?? 0.85,
          endAt: 0.5,
          preset: 'PLUS (high strength)',
        });
        usedReference = imageName;
      }

      const queued = await api('/prompt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: workflow, client_id: getClientId() }),
      });
      if (queued?.node_errors && Object.keys(queued.node_errors).length > 0) {
        return {
          content: [{ type: 'text', text: `ComfyUI 拒绝了这张图：${JSON.stringify(queued.node_errors).slice(0, 600)}` }],
          isError: true,
        };
      }
      const promptId = queued?.prompt_id;
      if (!promptId) {
        return { content: [{ type: 'text', text: `提交失败：${JSON.stringify(queued).slice(0, 400)}` }], isError: true };
      }

      const images = await waitForImages(promptId, Date.now() + TIMEOUT_MS);
      const paths = images.map(outputPathOf);
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      return {
        content: [
          {
            type: 'text',
            text: [
              `出图完成（${seconds}s）：`,
              ...paths.map((p) => `- ${p}`),
              '',
              `基座 ${chosen}　画幅 ${size ?? '1:1'}（${width}×${height}）　steps ${steps ?? 28}　cfg ${cfg ?? 6}`,
              usedReference
                ? `参考图 ${usedReference}　IP-Adapter 权重 ${reference_weight ?? 0.85}`
                : '（未使用参考图）',
            ].join('\n'),
          },
        ],
      };
    } catch (error) {
      const message = String(error?.message ?? error);
      const hint = message.includes('ECONNREFUSED') || message.includes('fetch failed')
        ? '（ComfyUI 没在跑？先启动 run_nvidia_gpu.bat）'
        : '';
      return { content: [{ type: 'text', text: `画图失败：${message}${hint}` }], isError: true };
    }
  },
);

server.tool(
  'comfy_status',
  '检查本机 ComfyUI 是否在线，并列出可用的基座模型。',
  {},
  async () => {
    try {
      const stats = await api('/system_stats');
      const checkpoints = await listCheckpoints();
      const lines = [
        `ComfyUI 在线：${COMFY}`,
        `设备：${stats?.devices?.map((d) => `${d.name}（显存 ${Math.round((d.vram_total ?? 0) / 1024 ** 2)} MB）`).join(' / ') ?? '未知'}`,
        `Python torch：${stats?.system?.pytorch_version ?? '未知'}`,
        '',
        `可用基座（${checkpoints.length}）：`,
        ...(checkpoints.length > 0 ? checkpoints.map((n) => `- ${n}`) : ['（空）']),
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `ComfyUI 不可达：${String(error?.message ?? error)}\n先启动 D:\\AI_Stuff\\ComfyUI_windows_portable\\run_nvidia_gpu.bat`,
          },
        ],
        isError: true,
      };
    }
  },
);

await server.connect(new StdioServerTransport());
