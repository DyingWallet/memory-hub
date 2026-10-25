/**
 * qq-bridge ↔ memory-hub adapter (drop-in module for the QQ bridge).
 *
 * Install as `qq-bridge/src/memory/memory-bridge.js`; the bridge wires it in
 * three places (wake recall, mirror write, optional read tools) — see
 * `memory-hub/docs/QQ-BRIDGE-PATCH.md`.
 *
 * Contract:
 *  - the bridge behaves exactly as before when memd is down or disabled;
 *  - every call is soft-failing and hard-timeout bounded (wake-up latency);
 *  - scene is computed here from the conversation key, never accepted from the
 *    model;
 *  - each scene kind must use its own token file, because a group token must not
 *    be able to read owner or private-scene memories. Config:
 *
 *      "tokens": {
 *        "group":   "state/memory-group.token",
 *        "owner":   "state/memory-owner.token",
 *        "10001": "state/memory-private-10001.token"
 *      }
 *
 *    There is deliberately no fallback: an unmapped scene gets no memory at all
 *    (falling back to another scene's token would leak a wider view).
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const RECALL_CACHE_MS = 5000;

/** Stable idempotency key for one QQ memory entry (write/forget must agree). */
function idemKey(scene, category, extra, text) {
  const digest = createHash('sha256')
    .update(`${scene}\u0000${category}\u0000${extra?.target ?? ''}\u0000${text}`)
    .digest('hex')
    .slice(0, 16);
  return `${scene}:${category}:${digest}`;
}

/**
 * @param {object} options
 * @param {object} options.cfg   bridge config (reads `cfg.memory`)
 * @param {object} [options.log] logger with warn/info
 * @param {string} [options.root] qq-bridge root directory
 */
export function createMemoryBridge({ cfg, log = console, root = process.cwd() }) {
  const memoryConfig = cfg?.memory ?? {};
  const enabled =
    memoryConfig.enabled === true &&
    Boolean(memoryConfig.endpoint) &&
    Boolean(memoryConfig.tokenFile || memoryConfig.tokens);
  const timeoutMs = clampInt(memoryConfig.timeoutMs ?? 800, 100, 5000);
  const clientPath = resolve(
    memoryConfig.clientPath ?? resolve(root, '..', 'memory-hub', 'packages', 'adapter-qq', 'dist', 'memory-client.mjs'),
  );
  const tokenMap = memoryConfig.tokens && typeof memoryConfig.tokens === 'object' ? memoryConfig.tokens : null;

  /** @type {Map<string, object>} tokenFile -> client */
  const clients = new Map();
  /** @type {Map<string, Set<string>>} conversation key -> message ids already reported */
  const ingested = new Map();
  let modulePromise = null;
  let broken = false;
  const recallCache = new Map();

  const abs = (file) => resolve(root, file);

  function tokenFileFor(scene) {
    const fallback = memoryConfig.tokenFile ? abs(memoryConfig.tokenFile) : null;
    if (!tokenMap) return fallback;
    // With a per-scene token map there is deliberately NO fallback: an unmapped
    // scene gets no memory client at all. Falling back to another scene's token
    // (especially the owner one) would leak a wider view.
    if (scene === 'qq:owner') return tokenMap.owner ? abs(tokenMap.owner) : null;
    if (scene.startsWith('qq:group:')) return tokenMap.group ? abs(tokenMap.group) : null;
    if (scene.startsWith('qq:private:')) {
      const qq = scene.slice('qq:private:'.length);
      return tokenMap[qq] ? abs(tokenMap[qq]) : null;
    }
    return null;
  }

  async function getClient(scene) {
    if (!enabled || broken) return null;
    const tokenFile = tokenFileFor(scene);
    if (!tokenFile) return null;
    const existing = clients.get(tokenFile);
    if (existing) return existing;
    if (!modulePromise) {
      modulePromise = import(pathToFileURL(clientPath).href).catch((error) => {
        broken = true;
        log.warn?.(`[memory] disabled: ${error?.message ?? error} (client=${clientPath})`);
        return null;
      });
    }
    const mod = await modulePromise;
    if (!mod || typeof mod.createQQMemoryClient !== 'function') return null;
    const client = mod.createQQMemoryClient({
      enabled: true,
      endpoint: memoryConfig.endpoint,
      tokenFile,
      recallK: memoryConfig.recallK ?? 3,
      maxChars: memoryConfig.maxChars ?? 800,
      timeoutMs,
    });
    clients.set(tokenFile, client);
    return client;
  }

  function sceneOf(key, ownerQQ) {
    const raw = String(key ?? '');
    const index = raw.indexOf(':');
    const kind = index === -1 ? '' : raw.slice(0, index);
    const id = index === -1 ? raw : raw.slice(index + 1);
    if (kind === 'group') return `qq:group:${id}`;
    if (String(id) === String(ownerQQ ?? '')) return 'qq:owner';
    return `qq:private:${id}`;
  }

  return {
    enabled,

    /** `【长期记忆】/【相关记忆】` block, or '' when unavailable. Never throws. */
    async recallBlock(key, messages, options = {}) {
      if (!enabled) return '';
      // 缓存键要带上 scope：主人问「群里聊了什么」走 groups，和普通场景召回不是一回事，
      // 共用一个缓存键会把群结果给普通召回、或反过来。
      const scope = options?.scope === 'groups' ? 'groups' : 'scene';
      const cacheKey = `${key}|${scope}`;
      const cached = recallCache.get(cacheKey);
      if (cached && Date.now() - cached.at < RECALL_CACHE_MS) return cached.text;
      let usable = (Array.isArray(messages) ? messages : [])
        .filter((message) => typeof message?.text === 'string' && message.text.trim().length > 0)
        .slice(-2);
      if (usable.length === 0) {
        if (scope !== 'groups') {
          log.warn?.(`[memory] recall skipped ${key}：没有可用消息`);
          return '';
        }
        // groups 召回不依赖关键词（返回该群最近的消息），给一个中性占位符即可；
        // 否则适配器会以「没有消息」直接返回 null，主人问群聊就永远拿不到。
        usable = [{ role: 'user', text: '最近' }];
      }
      try {
        const scene = sceneOf(key, cfg?.ownerQQ);
        const api = await getClient(scene);
        if (!api) {
          log.warn?.(`[memory] recall skipped ${key}：没有该场景的客户端（${scene}）`);
          return '';
        }
        const block = (await api.recallBlock(key, cfg?.ownerQQ, usable, options)) ?? '';
        recallCache.set(cacheKey, { text: block, at: Date.now() });
        if (recallCache.size > 50) recallCache.clear();
        return block;
      } catch (error) {
        log.warn?.(`[memory] recall failed: ${error?.message ?? error}`);
        return '';
      }
    },

    /** Fire-and-forget ingest of ordinary chat into short-term memory (TTL). */
    async ingestMessages(key, messages) {
      if (!enabled) return false;
      const seen = ingested.get(key) ?? new Set();
      ingested.set(key, seen);
      const usable = (Array.isArray(messages) ? messages : [])
        .filter((message) => typeof message?.text === 'string' && message.text.trim().length > 0)
        .filter((message) => !(message.id && seen.has(String(message.id))))
        .map((message) => ({
          ...(message.id ? { id: String(message.id) } : {}),
          role: message.role === 'assistant' ? 'assistant' : 'user',
          ...(message.author ? { author: String(message.author) } : {}),
          text: message.text,
          ...(message.ts ? { ts: String(message.ts) } : {}),
        }));
      if (usable.length === 0) return false;
      try {
        const api = await getClient(sceneOf(key, cfg?.ownerQQ));
        const ok = api ? await api.ingest(usable) : false;
        if (ok) {
          for (const message of usable) if (message.id) seen.add(message.id);
          if (seen.size > 5000) ingested.set(key, new Set([...seen].slice(-2000)));
        }
        return ok;
      } catch {
        return false;
      }
    },

    /** Fire-and-forget mirror into facts/. Never awaited on the reply path. */
    mirrorWrite(key, category, content, extra = {}) {
      if (!enabled || memoryConfig.writeMirror === false) return;
      void (async () => {
        try {
          const scene = sceneOf(key, cfg?.ownerQQ);
          const api = await getClient(scene);
          if (!api) return;
          const kind = category === 'memberImpression' ? 'qq-impression' : 'qq-topic';
          const text = String(content ?? '').trim();
          if (text.length === 0) return;
          await api.mirrorWrite({
            kind,
            text,
            scene,
            privacy: category === 'memberImpression' ? 'personal' : 'normal',
            tags: [category],
            idempotencyKey: idemKey(scene, category, extra, text),
          });
        } catch (error) {
          log.warn?.(`[memory] mirror write failed: ${error?.message ?? error}`);
        }
      })();
    },

    /** QQ 侧删除一条记忆时，同步让 memd 忘掉镜像事实（tombstone）。 */
    mirrorForget(key, category, content, extra = {}) {
      if (!enabled || memoryConfig.writeMirror === false) return;
      const text = String(content ?? '').trim();
      if (text.length === 0) return;
      void (async () => {
        try {
          const scene = sceneOf(key, cfg?.ownerQQ);
          const api = await getClient(scene);
          if (!api) return;
          await api.forget({ idempotencyKey: idemKey(scene, category, extra, text) });
        } catch (error) {
          log.warn?.(`[memory] mirror forget failed: ${error?.message ?? error}`);
        }
      })();
    },

    /** 编辑一条记忆：先忘掉旧文本的镜像，再写新文本。 */
    mirrorUpdate(key, category, oldContent, newContent, extra = {}) {
      const oldText = String(oldContent ?? '').trim();
      const newText = String(newContent ?? '').trim();
      if (oldText.length === 0 || newText.length === 0 || oldText === newText) return;
      this.mirrorForget(key, category, oldText, extra);
      this.mirrorWrite(key, category, newText, extra);
    },

    /** Read-only helpers for future MCP tools (`qq_memory_search` 等). */
    async search(key, query, k = 5, options = {}) {
      try {
        const scene = sceneOf(key, cfg?.ownerQQ);
        const api = await getClient(scene);
        return api ? await api.search(query, scene, k, options) : [];
      } catch {
        return [];
      }
    },

    /** 按时间倒出的「那阵子发生了什么」；失败返回 null（软失败）。 */
    async timeline(key, options = {}) {
      try {
        const scene = sceneOf(key, cfg?.ownerQQ);
        const api = await getClient(scene);
        return api ? await api.timeline(scene, options) : null;
      } catch {
        return null;
      }
    },

    async get(key, id) {
      try {
        const scene = sceneOf(key, cfg?.ownerQQ);
        const api = await getClient(scene);
        return api ? await api.get(id, scene) : null;
      } catch {
        return null;
      }
    },

    async recent(key, k = 5) {
      try {
        const scene = sceneOf(key, cfg?.ownerQQ);
        const api = await getClient(scene);
        return api ? await api.recent(scene, k) : [];
      } catch {
        return [];
      }
    },

    sceneOf,
    tokenFileFor,
  };
}

function clampInt(value, min, max) {
  const n = Number.isFinite(value) ? Math.trunc(value) : min;
  return Math.min(max, Math.max(min, n));
}
