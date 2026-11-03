/**
 * 记忆块渲染：/v1/recall 的 `format: "block"` 用它把结果拼成
 * 可以直接塞进 prompt 的一段文本。
 *
 * 为什么放在服务端：记忆提示词的形状是记忆服务的产品契约，不该由每个
 * 消费端（桌宠、QQ、以后的第三个端）各写一份；而且过滤与截断都在服务端
 * 完成，拼出来的块天然不会越权。
 */
import type { MemoryResult } from '@memsvc/protocol';

export interface RecallBlockOptions {
  /** 每行正文的预算上限，默认 1500。 */
  maxChars?: number;
  /** live 块标题里的时间窗（分钟），默认 30。 */
  liveMinutes?: number;
}

function clockOf(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')} `;
}

function textOf(result: MemoryResult): string {
  const text = result.render?.type === 'text' ? result.render.text : '';
  return (text || result.title || '').replace(/\s+/g, ' ').trim();
}

/**
 * 按**码点**截断。直接 `slice()` 按 UTF-16 码元切，切在 emoji 的代理对中间会留下
 * 孤立代理项；这条记忆块会被拼进 QQ 桥接的提示词，DeepSeek Messages API 的 JSON
 * 解析器对孤立代理项零容忍，整份请求 400（"lone leading surrogate in hex escape"），
 * 而且坏字符进入 DSH 会话历史后该会话永久失败（2026-11-04 事故）。
 * 注意 @memsvc/core 的 truncate 会加省略号，这里保持原来的「不留尾巴」行为。
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** 把孤立代理项换成 U+FFFD（lib 是 ES2023，没有 String.prototype.toWellFormed 的类型）。 */
function wellFormed(text: string): string {
  return text.replace(LONE_SURROGATE, '\uFFFD');
}

function clip(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  // 先清理已存在的孤立代理（历史上被切坏的存量数据），再按码点截断。
  const clean = wellFormed(text);
  const chars = Array.from(clean);
  return chars.length <= maxChars ? clean : chars.slice(0, maxChars).join('');
}

/** 只渲染记忆列表（不带 live 段）。`/v1/recent` 的 block 也用它，标题可换。 */
export function renderMemoryBlock(
  results: readonly MemoryResult[],
  options: RecallBlockOptions & { title?: string } = {},
): string {
  if (results.length === 0) return '';
  const maxChars = Math.max(200, options.maxChars ?? 1500);
  const title = options.title ?? '【长期记忆】（只是背景，不要原样复述）';
  const perLine = Math.max(120, Math.floor(maxChars / Math.max(1, results.length)));
  const lines = [title];
  for (const row of results) {
    const text = textOf(row);
    if (!text) continue;
    const marker = row.disclosure === 'owner_initiated' ? '（对方自己提起过的）' : '';
    lines.push(`- ${marker}${clip(text, perLine)}`);
  }
  return lines.join('\n').trim();
}

/** 纯函数：结果 → prompt 块。空结果返回空串。 */
export function renderRecallBlock(
  results: readonly MemoryResult[],
  live: readonly MemoryResult[] | undefined,
  options: RecallBlockOptions = {},
): string {
  const maxChars = Math.max(200, options.maxChars ?? 1500);
  const lines: string[] = [];

  const liveList = live ?? [];
  if (liveList.length > 0) {
    lines.push(`【最近在聊的】（近 ${options.liveMinutes ?? 30} 分钟，是现状，不是回忆）`);
    const perLine = Math.max(80, Math.floor(maxChars / Math.max(1, liveList.length)));
    for (const row of liveList) {
      const text = textOf(row);
      if (!text) continue;
      lines.push(`- ${clockOf(row.updated_at)}${clip(text, perLine)}`);
    }
    lines.push('');
  }

  const memory = renderMemoryBlock(results, { maxChars });
  if (memory) lines.push(memory);

  return lines.join('\n').trim();
}
