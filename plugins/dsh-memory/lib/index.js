/**
 * DSH host plugin: report session messages to memory-hub as short-term
 * memories, so the forgetting curve covers every session (not just QQ).
 *
 * - `agent/pre-step` gives us the user messages entering a step; assistant
 *   output is not visible there and is not ingested.
 * - QQ bridge sessions are skipped: the bridge already ingests them with the
 *   correct scene/audience, and their wake prompt contains 【会话令牌】.
 * - Every call is fire-and-forget: memd being down must not affect a turn.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const name = 'dsh-memory';

const DEFAULTS = {
  endpoint: process.env.MEMD_ENDPOINT ?? 'http://127.0.0.1:8787',
  tokenFile: process.env.MEMD_TOKEN_FILE ?? join(homedir(), '.dsh', 'memory-token'),
  scene: process.env.MEMD_SURFACE ?? 'main',
  enabled: process.env.MEMD_INGEST !== '0',
};

export function textOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n');
  }
  return '';
}

/** QQ bridge sessions carry the session token line; they are ingested by the bridge. */
export function isBridgeSession(messages) {
  return messages.some((message) => textOf(message).includes('【会话令牌】'));
}

export function messageIdFor(sessionId, turn, step, text) {
  return `${sessionId}:${turn}:${step}:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
}

export function apply(ctx, config = {}) {
  const options = { ...DEFAULTS, ...config };
  if (options.enabled === false) return;

  ctx.on(
    'agent/pre-step',
    async ({ agent, messages, turn, step, signal }, next) => {
      const decision = await next();
      try {
        if (signal?.aborted) return decision;
        const list = Array.isArray(messages) ? messages : [];
        if (list.length === 0 || isBridgeSession(list)) return decision;
        // Pet sessions are reported by pet-brain with scene=pet (and the pet's
        // own visibility rules); skip them here so a chat is not written twice.
        if (agent?.session?.header?.agentPreset === 'pet-chat') return decision;
        const sessionId = String(agent?.session?.header?.id ?? agent?.session?.id ?? 'session');
        // `.catch` is mandatory: a rejected promise here becomes an
        // unhandledRejection, and DSH's fail-loud handler treats that as a
        // fatal load failure and exits the whole app (observed 2026-10-24:
        // memd down -> ECONNREFUSED -> host exited).
        ingest(list, sessionId, turn, step, options).catch(() => {});
      } catch {
        // Never block or fail a turn because of memory ingest.
      }
      return decision;
    },
    { prepend: true },
  );
}

async function ingest(messages, sessionId, turn, step, options) {
  try {
    const payload = messages
      .map((message) => textOf(message).trim())
      .filter((text) => text.length > 0 && !text.includes('【会话令牌】'))
      .map((text) => ({
        message_id: messageIdFor(sessionId, turn, step, text),
        role: 'user',
        author: 'owner',
        text: text.slice(0, 2000),
      }));
    if (payload.length === 0) return;

    let token;
    try {
      token = readFileSync(options.tokenFile, 'utf8').trim();
    } catch {
      return;
    }

    // No cap for DSH sessions (and future surfaces such as dsh-pet); only the
    // request size is bounded, so messages are sent in batches of 50.
    for (let i = 0; i < payload.length; i += 50) {
      const batch = payload.slice(i, i + 50);
      await fetch(`${options.endpoint.replace(/\/+$/, '')}/v1/ingest`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: batch, ...(options.scene ? { scene: options.scene } : {}) }),
        signal: AbortSignal.timeout(4000),
      });
    }
  } catch {
    // memd down, timeout, or a bad response: drop this batch silently. It must
    // never reject, because an unhandled rejection crashes the DSH host.
  }
}
