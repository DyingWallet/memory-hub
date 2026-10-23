import { MemoryClient } from '@memsvc/sdk';
import type { BootstrapResponse, MemoryResult } from '@memsvc/protocol';
import type { MemoryPluginConfig } from './config.js';

export interface BootstrapContext {
  response: BootstrapResponse;
  /** Ready-to-inject `system-reminder` body. */
  text: string;
}

export function buildBootstrapBlock(response: BootstrapResponse): string {
  const lines: string[] = ['【记忆】'];
  lines.push(`身份：${oneLine(response.identity)}`);

  if (response.audience.face && response.audience.face.length > 0) {
    lines.push(`受众：${response.audience.id} — ${oneLine(response.audience.face)}`);
  }
  if (response.recent.length > 0) {
    lines.push(`最近：${response.recent.map((item) => item.title).join('；')}`);
  }
  lines.push(`规模：文档 ${response.counts.docs} / 事实 ${response.counts.facts}`);
  lines.push(`用法：${response.instructions}`);
  lines.push('这些是摘要，不是全文。需要细节就调用 memory_search；不要凭标题编内容。');
  return lines.join('\n');
}

/**
 * One bootstrap round-trip. Never throws: a dead memd must not block a session
 * from starting, and the caller decides whether to inject anything.
 */
export async function fetchBootstrap(
  config: MemoryPluginConfig,
  options: { scene?: string; token?: string } = {},
): Promise<BootstrapContext | null> {
  if (!config.bootstrap) return null;
  const client = new MemoryClient({
    endpoint: config.endpoint,
    tokenFile: config.tokenFile,
    timeoutMs: config.timeoutMs,
    ...(options.token ? { token: options.token } : {}),
  });
  try {
    const response = await client.bootstrap(options.scene ?? config.scene);
    return { response, text: buildBootstrapBlock(response) };
  } catch (error) {
    console.error(`[memory-plugin] bootstrap failed: ${(error as Error).message}`);
    return null;
  }
}

/** Compact recall block for chat adapters (QQ wake-up). */
export function formatRecallItems(items: readonly MemoryResult[], maxChars = 800): string {
  const lines: string[] = [];
  let used = 0;
  for (const [index, item] of items.entries()) {
    const text = oneLine(item.render.text);
    const line = `${index + 1}. ${text}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
