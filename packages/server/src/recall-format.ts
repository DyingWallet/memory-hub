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
      lines.push(`- ${clockOf(row.updated_at)}${text.slice(0, perLine)}`);
    }
    lines.push('');
  }

  if (results.length > 0) {
    lines.push('【长期记忆】（只是背景，不要原样复述）');
    const perLine = Math.max(120, Math.floor(maxChars / Math.max(1, results.length)));
    for (const row of results) {
      const text = textOf(row);
      if (!text) continue;
      const marker = row.disclosure === 'owner_initiated' ? '（对方自己提起过的）' : '';
      lines.push(`- ${marker}${text.slice(0, perLine)}`);
    }
  }

  return lines.join('\n').trim();
}
