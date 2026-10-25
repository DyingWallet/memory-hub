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
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { idemKey } from './idem.js';
import { createMirrorJournal } from './mirror-journal.js';

const RECALL_CACHE_MS = 5000;

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
  // 失败流水 + 遗忘队列。journal 关掉等于回到「失败只打一行日志」的旧行为，
  // 只留给排障用；默认开。
  const journal = memoryConfig.journal === false ? null : createMirrorJournal({ root, log });
  const forgetRetryMs = clampInt(memoryConfig.forgetQueueRetryMs ?? 300_000, 60_000, 24 * 3_600_000);

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

  /**
   * 重试遗忘队列：每条都按 scene 取对应令牌重算键，再忘一次。
   * 只在 enabled 且有 journal 时轮转；`unref()` 保证不会把桥接进程吊住不退出。
   */
  async function drainForgetQueue() {
    if (!enabled || !journal) return { drained: 0, left: 0, gaveUp: 0 };
    const result = await journal.drain(async (item) => {
      const api = await getClient(item.scene);
      if (!api) throw new Error('no memory client (token not mapped)');
      const key = item.dedupeKey ?? idemKey(item.scene, item.category, { target: item.target }, item.text);
      await api.forget({ idempotencyKey: key });
      return true;
    });
    if (result.drained > 0 || result.gaveUp > 0) {
      log.warn?.(`[memory] forget queue: drained=${result.drained} left=${result.left} gaveUp=${result.gaveUp}`);
    }
    return result;
  }

  let forgetTimer = null;
  if (enabled && journal) {
    // 启动 30 秒后先跑一次（补上次停机期间没忘掉的），之后按配置轮转。
    const kick = setTimeout(() => {
      void drainForgetQueue().catch(() => {});
    }, 30_000);
    kick.unref?.();
    forgetTimer = setInterval(() => {
      void drainForgetQueue().catch(() => {});
    }, forgetRetryMs);
    forgetTimer.unref?.();
  }

  return {
    enabled,
    journal,
    drainForgetQueue,
    stopForgetQueue() {
      if (forgetTimer) clearInterval(forgetTimer);
      forgetTimer = null;
    },

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
      const text = String(content ?? '').trim();
      if (text.length === 0) return;
      const scene = sceneOf(key, cfg?.ownerQQ);
      void (async () => {
        try {
          const api = await getClient(scene);
          if (!api) {
            // 没有客户端也要留痕：否则「场景没配令牌」会伪装成「一切正常」。
            journal?.recordFailure({ op: 'write', scene, category, target: extra?.target, error: 'no memory client (token not mapped)', missing: true });
            return;
          }
          const kind = category === 'memberImpression' ? 'qq-impression' : 'qq-topic';
          // 注意：adapter 客户端把任何失败都吞成 `false`（memory-client.ts 里
          // catch { return false }），所以**不能只靠 catch 判断失败**——
          // 只捕获异常的版本在实测里一条痕迹都不会留下。
          const ok = await api.mirrorWrite({
            kind,
            text,
            scene,
            privacy: category === 'memberImpression' ? 'personal' : 'normal',
            tags: [category],
            idempotencyKey: idemKey(scene, category, extra, text),
          });
          if (ok === false) {
            log.warn?.('[memory] mirror write returned false (memd unreachable or rejected)');
            journal?.recordFailure({ op: 'write', scene, category, target: extra?.target, error: 'client returned false' });
          }
        } catch (error) {
          log.warn?.(`[memory] mirror write failed: ${error?.message ?? error}`);
          journal?.recordFailure({ op: 'write', scene, category, target: extra?.target, error });
        }
      })();
    },

    /** QQ 侧删除一条记忆时，同步让 memd 忘掉镜像事实（tombstone）。 */
    mirrorForget(key, category, content, extra = {}) {
      if (!enabled || memoryConfig.writeMirror === false) return;
      const text = String(content ?? '').trim();
      if (text.length === 0) return;
      const scene = sceneOf(key, cfg?.ownerQQ);
      void (async () => {
        try {
          const api = await getClient(scene);
          if (!api) {
            journal?.recordFailure({ op: 'forget', scene, category, target: extra?.target, error: 'no memory client (token not mapped)' });
            return;
          }
          const ok = await api.forget({ idempotencyKey: idemKey(scene, category, extra, text) });
          if (ok === false) {
            // 该忘而没忘掉：进队列，由 drainForgetQueue 重试（不静默丢弃）。
            log.warn?.('[memory] mirror forget returned false — queued for retry');
            journal?.recordFailure({ op: 'forget', scene, category, target: extra?.target, error: 'client returned false' });
            journal?.enqueueForget(
              { scene, category, target: extra?.target, text, error: 'client returned false' },
              idemKey(scene, category, extra, text),
            );
          }
        } catch (error) {
          log.warn?.(`[memory] mirror forget failed: ${error?.message ?? error}`);
          journal?.recordFailure({ op: 'forget', scene, category, target: extra?.target, error });
          // 该忘而没忘掉：进队列，由 drainForgetQueue 重试（不静默丢弃）。
          journal?.enqueueForget({ scene, category, target: extra?.target, text, error }, idemKey(scene, category, extra, text));
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
