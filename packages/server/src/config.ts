import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_POLICY, type RestrictedPolicy } from '@memsvc/core';

/**
 * Locates the `memory-hub/` root. Do NOT use "three levels up from this
 * module": under pnpm's hoisted layout workspace packages are reachable through
 * package-local node_modules junctions that Node does not realpath, which used
 * to resolve `<pkg>/node_modules` as the root. Walk up to a project marker.
 */
function findPackageRoot(start: string): string {
  let dir = start;
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const packageJson = join(dir, 'package.json');
    if (existsSync(packageJson)) {
      try {
        const parsed = JSON.parse(readFileSync(packageJson, 'utf8')) as { name?: string };
        if (parsed.name === 'memory-hub') return dir;
      } catch {
        // ignore unparseable package.json and keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.env.MEMD_ROOT ? resolve(process.env.MEMD_ROOT) : resolve(process.cwd());
}

export const PACKAGE_ROOT = findPackageRoot(dirname(fileURLToPath(import.meta.url)));

export interface ServerConfig {
  version: string;
  /** Addresses to bind. Loopback + ZeroTier only; never 0.0.0.0. */
  hosts: string[];
  port: number;
  dataDir: string;
  memoriesDir: string;
  indexFile: string;
  tokensFile: string;
  auditFile: string;
  identityFile: string;
  audiencesDir: string;
  factsDir: string;
  searchDefaultK: number;
  searchMaxK: number;
  searchDefaultChars: number;
  /**
   * 短期记忆在搜索结果里的权重（1 = 不降权，0 = 排到最后）。
   * bm25 天然偏爱短文档，聊天碎片会挤掉长期文档，所以默认 0.5。
   */
  searchShortWeight: number;
  recallMaxMessages: number;
  writeMaxChars: number;
  watch: boolean;
  logLevel: string;
  /** Default identity line when `user/identity.md` is missing. */
  identityFallback: string;
  instructions: string;
  /** Which sensitivity labels exist, where they may appear, what unlocks them. */
  privacy: RestrictedPolicy;
  /** Ordinary-chat memory: TTL, review window, forgetting curve. */
  shortTerm: ShortTermConfig;
  /** Monthly JSONL archiving. Disabled by default. */
  archive: ArchiveConfig;
  /** Daily file backup of memories + tokens + config. */
  backup: BackupConfig;
  /** Optional: let the same watchdog revive the QQ bridge. */
  bridge: BridgeConfig;
  /** Optional: let the same watchdog run the nightly consolidation once a day. */
  sleep: SleepConfig;
  /** Optional semantic search (local embedding + sqlite-vec hybrid ranking). */
  semantic: SemanticConfig;
  /** Absolute path of the config.json this instance was loaded from. */
  configFile: string;
}

export interface ShortTermConfig {
  /** Ingest ordinary chat as short-term memories at all. */
  enabled: boolean;
  /** Base TTL for a short memory (hours). */
  ttlHours: number;
  /** Upper bound after repeated recall (hours). */
  maxTtlHours: number;
}

export interface ArchiveConfig {
  /** Turn monthly JSONL archiving on. Off by default: data volume is small. */
  enabled: boolean;
  /** Keep the last N finished months as plain JSONL; older ones are gzipped. */
  keepMonths: number;
}

export interface BackupConfig {
  /** Run the daily backup script at all. */
  enabled: boolean;
  /** Destination directory (absolute, or relative to memory-hub/). */
  dir: string;
  /** How many daily snapshots to keep. */
  keepDays: number;
}

/**
 * 可选：让同一个看护任务顺带盯着 QQ 桥接（默认关）。
 * 这段配置只被 `scripts/supervisor.mjs` 读，memd 自己不用。
 */
export interface BridgeConfig {
  /** 开不开这条看护。关着的时候 supervisor 完全不碰桥接。 */
  enabled: boolean;
  /** qq-bridge 目录（绝对路径，或相对 memory-hub/）。 */
  dir: string;
  /** 桥接控制台探活地址；2xx 或 401 都算活着（401 = 控制台在，只是没带 token）。 */
  probeUrl: string;
  /** 启动失败后隔多久再试（分钟），免得每分钟刷一次日志。 */
  retryMinutes: number;
  /** 启动后最多等几秒确认它真的起来了。桥接冷启动实测 2–5 秒。 */
  startTimeoutSeconds: number;
}

/**
 * 语义检索（可选，默认关）。关着的时候 memd 完全不加载模型、不建向量表，
 * 行为和 v1 的纯 FTS 完全一致。
 */
export interface SemanticConfig {
  /** 总开关。关 = 不加载 onnxruntime、不写向量、recall 走纯 FTS。 */
  enabled: boolean;
  /** 混合分值里 BM25 的权重；1 - alpha 给余弦。0.5 = 各半。 */
  alpha: number;
  /** ONNX 模型与词表所在目录（相对 memory-hub/）。 */
  modelDir: string;
  modelFile: string;
  vocabFile: string;
  /** 向量维度（bge-small-zh = 512）。与已有向量表不一致时自动重建。 */
  dim: number;
  /** 截断长度（token）。实测 >256 会明显抬高内存与 p95。 */
  maxLen: number;
  /** 一次推理的批大小。实测 >8 会把激活张量放大到 GB 级。 */
  batchSize: number;
  /** 稳态推理线程数。实测 1 线程足够（短查询 0.5 ms），多开只会抬高总 CPU。 */
  threads: number;
  /** 一次性回填用的线程数（脚本里可再覆盖）。 */
  backfillThreads: number;
  /** 每次检索从向量表取多少个候选（再与 FTS 结果融合）。 */
  maxCandidates: number;
}

export const DEFAULT_INSTRUCTIONS =
  '需要细节时调用 memory_search；先 5 条，不够再 k=10。不要一次取全量，也不要编造没检索到的记忆。';

const DEFAULTS: Omit<ServerConfig, 'dataDir' | 'memoriesDir' | 'indexFile' | 'tokensFile' | 'auditFile' | 'identityFile' | 'audiencesDir' | 'factsDir' | 'configFile'> & {
  dataDir: string;
  memoriesDir: string;
  indexFile: string;
  tokensFile: string;
  auditFile: string;
  identityFile: string;
  audiencesDir: string;
  factsDir: string;
} = {
  version: '0.1.0',
  hosts: ['127.0.0.1'],
  port: 8787,
  dataDir: join(PACKAGE_ROOT, 'data'),
  memoriesDir: resolve(PACKAGE_ROOT, '..', 'memories'),
  indexFile: join(PACKAGE_ROOT, 'data', 'index.db'),
  tokensFile: join(PACKAGE_ROOT, 'data', 'tokens.json'),
  auditFile: join(PACKAGE_ROOT, 'data', 'audit.jsonl'),
  identityFile: resolve(PACKAGE_ROOT, '..', 'memories', 'user', 'identity.md'),
  audiencesDir: resolve(PACKAGE_ROOT, '..', 'memories', 'audiences'),
  factsDir: resolve(PACKAGE_ROOT, '..', 'memories', 'facts'),
  searchDefaultK: 5,
  searchMaxK: 10,
  searchDefaultChars: 600,
  searchShortWeight: 0.5,
  recallMaxMessages: 8,
  writeMaxChars: 8000,
  watch: false,
  logLevel: 'info',
  identityFallback: '本地助手。',
  instructions: DEFAULT_INSTRUCTIONS,
  privacy: DEFAULT_POLICY,
  shortTerm: {
    enabled: true,
    ttlHours: 24,
    maxTtlHours: 168,
  },
  archive: { enabled: false, keepMonths: 12 },
  backup: { enabled: true, dir: resolve(PACKAGE_ROOT, '..', 'backups', 'memory-hub'), keepDays: 14 },
  bridge: {
    enabled: false,
    dir: resolve(PACKAGE_ROOT, '..', 'qq-bridge'),
    probeUrl: 'http://127.0.0.1:3100/',
    retryMinutes: 10,
    startTimeoutSeconds: 20,
  },
  sleep: {
    enabled: false,
    at: '03:00',
    retryMinutes: 30,
  },
  semantic: {
    enabled: false,
    alpha: 0.5,
    modelDir: 'models/bge-small-zh-v1.5',
    modelFile: 'onnx/model_quantized.onnx',
    vocabFile: 'vocab.txt',
    dim: 512,
    maxLen: 256,
    batchSize: 8,
    threads: 1,
    backfillThreads: 4,
    // 每次检索取多少个向量候选再与 FTS 融合。实测 50 与 200 的排序结果一致，
    // 但 200 会多花约 1 ms（782 个 chunk 时 4.32 → 3.35 ms）。
    maxCandidates: 50,
  },
};

type PartialConfig = Partial<ServerConfig> & { configFile?: string };

/** Reads `config.json` (if present) and applies env overrides. */
export function loadConfig(overrides: PartialConfig = {}): ServerConfig {
  const rootConfigPath = overrides.configFile ?? process.env.MEMD_CONFIG ?? join(PACKAGE_ROOT, 'config.json');
  let fileConfig: Partial<ServerConfig> = {};
  if (existsSync(rootConfigPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(rootConfigPath, 'utf8')) as Partial<ServerConfig>;
    } catch (error) {
      throw new Error(`invalid config JSON at ${rootConfigPath}: ${(error as Error).message}`);
    }
  }

  const merged = { ...DEFAULTS, ...fileConfig, ...stripUndefined(overrides) } as ServerConfig;

  // Relative paths in config.json are relative to memory-hub/.
  const pathKeys = [
    'dataDir',
    'memoriesDir',
    'indexFile',
    'tokensFile',
    'auditFile',
    'identityFile',
    'audiencesDir',
    'factsDir',
  ] as const;
  for (const key of pathKeys) {
    const value = merged[key];
    if (typeof value === 'string' && value.length > 0 && !isAbsolute(value)) {
      merged[key] = resolve(PACKAGE_ROOT, value);
    }
  }

  if (process.env.MEMD_HOSTS) merged.hosts = process.env.MEMD_HOSTS.split(',').map((h) => h.trim()).filter(Boolean);
  if (process.env.MEMD_PORT) merged.port = Number.parseInt(process.env.MEMD_PORT, 10);
  if (process.env.MEMD_DATA_DIR) merged.dataDir = resolve(process.env.MEMD_DATA_DIR);
  if (process.env.MEMD_MEMORIES_DIR) merged.memoriesDir = resolve(process.env.MEMD_MEMORIES_DIR);
  if (process.env.MEMD_LOG_LEVEL) merged.logLevel = process.env.MEMD_LOG_LEVEL;
  if (process.env.MEMD_WATCH) merged.watch = process.env.MEMD_WATCH === '1' || process.env.MEMD_WATCH === 'true';

  if (merged.hosts.some((host) => host === '0.0.0.0' || host === '::')) {
    throw new Error('refusing to bind 0.0.0.0/:: — memd must stay on loopback + ZeroTier addresses');
  }
  if (!Number.isInteger(merged.port) || merged.port < 1 || merged.port > 65535) {
    throw new Error(`invalid port: ${String(merged.port)}`);
  }

  merged.privacy = normalizePrivacyPolicy(merged.privacy, fileConfig.privacy);
  merged.shortTerm = normalizeShortTerm(merged.shortTerm, fileConfig.shortTerm);
  merged.archive = normalizeArchive(merged.archive, fileConfig.archive);
  merged.backup = normalizeBackup(merged.backup, fileConfig.backup);
  merged.bridge = normalizeBridge(merged.bridge, fileConfig.bridge);
  merged.sleep = normalizeSleep(merged.sleep, fileConfig.sleep);
  merged.semantic = normalizeSemantic(merged.semantic, fileConfig.semantic);
  if (!isAbsolute(merged.semantic.modelDir)) merged.semantic.modelDir = resolve(PACKAGE_ROOT, merged.semantic.modelDir);
  if (process.env.MEMD_SEMANTIC === '1' || process.env.MEMD_SEMANTIC === 'true') merged.semantic.enabled = true;
  if (process.env.MEMD_SEMANTIC === '0' || process.env.MEMD_SEMANTIC === 'false') merged.semantic.enabled = false;
  if (!isAbsolute(merged.bridge.dir)) merged.bridge.dir = resolve(PACKAGE_ROOT, merged.bridge.dir);
  if (!isAbsolute(merged.backup.dir)) merged.backup.dir = resolve(PACKAGE_ROOT, merged.backup.dir);
  // 短期降权：0（永远最后）到 1（不降权）。非法值退回默认。
  if (typeof merged.searchShortWeight !== 'number' || !Number.isFinite(merged.searchShortWeight)) {
    merged.searchShortWeight = DEFAULTS.searchShortWeight;
  }
  merged.searchShortWeight = Math.min(1, Math.max(0, merged.searchShortWeight));
  merged.configFile = rootConfigPath;

  mkdirSync(merged.dataDir, { recursive: true });
  return merged;
}

function normalizeShortTerm(
  value: ShortTermConfig | undefined,
  fromFile: Partial<ShortTermConfig> | undefined,
): ShortTermConfig {
  const base: ShortTermConfig = { ...DEFAULTS.shortTerm, ...(value ?? {}), ...(fromFile ?? {}) };
  const clamp = (n: unknown, fallback: number, min: number, max: number): number => {
    const parsed = typeof n === 'number' && Number.isFinite(n) ? n : fallback;
    return Math.min(max, Math.max(min, parsed));
  };
  return {
    enabled: base.enabled !== false,
    ttlHours: clamp(base.ttlHours, 24, 0.1, 24 * 30),
    maxTtlHours: clamp(base.maxTtlHours, 168, 0.1, 24 * 365),
  };
}

function normalizeArchive(value: Partial<ArchiveConfig> | undefined, fromFile: Partial<ArchiveConfig> | undefined): ArchiveConfig {
  const base = { ...DEFAULTS.archive, ...(value ?? {}), ...(fromFile ?? {}) };
  const keep = typeof base.keepMonths === 'number' && Number.isFinite(base.keepMonths) ? Math.trunc(base.keepMonths) : 12;
  return {
    enabled: base.enabled === true,
    keepMonths: Math.min(120, Math.max(0, keep)),
  };
}

function normalizeBackup(value: Partial<BackupConfig> | undefined, fromFile: Partial<BackupConfig> | undefined): BackupConfig {
  const base = { ...DEFAULTS.backup, ...(value ?? {}), ...(fromFile ?? {}) };
  const keep = typeof base.keepDays === 'number' && Number.isFinite(base.keepDays) ? Math.trunc(base.keepDays) : 14;
  const dir = typeof base.dir === 'string' && base.dir.trim().length > 0 ? base.dir.trim() : DEFAULTS.backup.dir;
  return {
    enabled: base.enabled !== false,
    dir,
    keepDays: Math.min(365, Math.max(1, keep)),
  };
}

/**
 * 桥接看护配置。默认关；字段全部夹到安全区间，手写 config.json 写歪了也不会
 * 变成「每分钟重启一次桥接」。
 */
export function normalizeBridge(value: Partial<BridgeConfig> | undefined, fromFile: Partial<BridgeConfig> | undefined): BridgeConfig {
  const base = { ...DEFAULTS.bridge, ...(value ?? {}), ...(fromFile ?? {}) };
  const num = (input: unknown, fallback: number, min: number, max: number): number => {
    const parsed = typeof input === 'number' && Number.isFinite(input) ? input : fallback;
    return Math.min(max, Math.max(min, parsed));
  };
  const text = (input: unknown, fallback: string): string =>
    typeof input === 'string' && input.trim().length > 0 ? input.trim() : fallback;
  return {
    // 只有明确写 true 才开，避免 "enabled": "yes" 这种手滑把它打开。
    enabled: base.enabled === true,
    dir: text(base.dir, DEFAULTS.bridge.dir),
    probeUrl: text(base.probeUrl, DEFAULTS.bridge.probeUrl),
    retryMinutes: Math.trunc(num(base.retryMinutes, DEFAULTS.bridge.retryMinutes, 1, 1440)),
    startTimeoutSeconds: Math.trunc(num(base.startTimeoutSeconds, DEFAULTS.bridge.startTimeoutSeconds, 5, 120)),
  };
}

/**
 * 夜间整理配置（默认关）。整理本身由 `scripts/sleep-consolidate.mjs` 做——
 * 它唤起一个 `sleep-consolidator` preset 的 DSH 会话，把当天记忆交给它整理。
 * 这段配置只被 `scripts/supervisor.mjs` 读：memd 自己不用，也不该为它改动。
 */
export interface SleepConfig {
  /** 开不开。关着的时候 supervisor 完全不碰整理。 */
  enabled: boolean;
  /** 每天几点跑，`HH:mm`（本地时间）。 */
  at: string;
  /** 失败后隔多久再试（分钟）；跑成功则当天不再触发。 */
  retryMinutes: number;
}

/**
 * 夜间整理配置的收紧：时刻必须是合法 `HH:mm`，重试间隔夹在 5–1440 分钟，
 * 手写 config.json 写歪了也不会变成「每分钟起一次整理会话」。
 */
export function normalizeSleep(
  value: Partial<SleepConfig> | undefined,
  fromFile: Partial<SleepConfig> | undefined,
): SleepConfig {
  const base: Partial<SleepConfig> = { ...DEFAULTS.sleep, ...(value ?? {}), ...(fromFile ?? {}) };
  const at = typeof base.at === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(base.at.trim())
    ? base.at.trim()
    : DEFAULTS.sleep.at;
  const retry = typeof base.retryMinutes === 'number' && Number.isFinite(base.retryMinutes)
    ? Math.trunc(base.retryMinutes)
    : DEFAULTS.sleep.retryMinutes;
  return {
    enabled: base.enabled === true,
    at,
    retryMinutes: Math.min(1440, Math.max(5, retry)),
  };
}

/**
 * 语义检索配置：全部字段都夹紧到实测安全区间（线程 1–8、批 1–16、maxLen 32–512），
 * 避免手改 config.json 写进一个会把内存打爆的组合。
 */
export function normalizeSemantic(
  value: Partial<SemanticConfig> | undefined,
  fromFile: Partial<SemanticConfig> | undefined,
): SemanticConfig {
  const base: Partial<SemanticConfig> = { ...DEFAULTS.semantic, ...(value ?? {}), ...(fromFile ?? {}) };
  const num = (input: unknown, fallback: number, min: number, max: number): number => {
    const parsed = typeof input === 'number' && Number.isFinite(input) ? input : fallback;
    return Math.min(max, Math.max(min, parsed));
  };
  const text = (input: unknown, fallback: string): string =>
    typeof input === 'string' && input.trim().length > 0 ? input.trim() : fallback;
  return {
    enabled: base.enabled === true,
    alpha: num(base.alpha, DEFAULTS.semantic.alpha, 0, 1),
    modelDir: text(base.modelDir, DEFAULTS.semantic.modelDir),
    modelFile: text(base.modelFile, DEFAULTS.semantic.modelFile),
    vocabFile: text(base.vocabFile, DEFAULTS.semantic.vocabFile),
    dim: Math.trunc(num(base.dim, DEFAULTS.semantic.dim, 64, 2048)),
    maxLen: Math.trunc(num(base.maxLen, DEFAULTS.semantic.maxLen, 32, 512)),
    batchSize: Math.trunc(num(base.batchSize, DEFAULTS.semantic.batchSize, 1, 16)),
    threads: Math.trunc(num(base.threads, DEFAULTS.semantic.threads, 1, 8)),
    backfillThreads: Math.trunc(num(base.backfillThreads, DEFAULTS.semantic.backfillThreads, 1, 16)),
    maxCandidates: Math.trunc(num(base.maxCandidates, DEFAULTS.semantic.maxCandidates, 20, 2000)),
  };
}

/**
 * Validates the `privacy` section: one sensitivity bit plus the audiences that
 * count as the owner's own rooms. No per-label vocabulary anymore.
 */
function normalizePrivacyPolicy(
  value: RestrictedPolicy | undefined,
  fromFile: Partial<RestrictedPolicy> | undefined,
): RestrictedPolicy {
  const base = (fromFile ?? value ?? DEFAULT_POLICY) as Partial<RestrictedPolicy>;
  const cleanList = (input: unknown, fallback: string[]): string[] => {
    if (!Array.isArray(input)) return [...fallback];
    const cleaned = input.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
    return cleaned.length > 0 ? Array.from(new Set(cleaned)) : [...fallback];
  };
  const sensitiveScope =
    typeof base.sensitiveScope === 'string' && base.sensitiveScope.trim().length > 0
      ? base.sensitiveScope.trim()
      : DEFAULT_POLICY.sensitiveScope;
  return {
    sensitiveScope,
    sensitiveAudiences: cleanList(base.sensitiveAudiences, DEFAULT_POLICY.sensitiveAudiences),
    secretAudiences: cleanList(base.secretAudiences, DEFAULT_POLICY.secretAudiences),
    ownerAudiences: cleanList(base.ownerAudiences, DEFAULT_POLICY.ownerAudiences),
  };
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, val] of Object.entries(value)) {
    if (val !== undefined && key !== 'configFile') (out as Record<string, unknown>)[key] = val;
  }
  return out;
}

/** Maps our config value onto Fastify's accepted logger levels. */
export function buildLogLevel(level: string): 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent' {
  switch (level) {
    case 'fatal':
    case 'error':
    case 'warn':
    case 'info':
    case 'debug':
    case 'trace':
    case 'silent':
      return level;
    default:
      return 'info';
  }
}
