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
  /** How far back the daily review looks (hours). */
  reviewLookbackHours: number;
  /** Max items returned by one review. */
  reviewLimit: number;
  /** Minimum gap between two reviews for the same scene (hours). */
  reviewIntervalHours: number;
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
    reviewLookbackHours: 72,
    reviewLimit: 30,
    reviewIntervalHours: 20,
  },
  archive: { enabled: false, keepMonths: 12 },
  backup: { enabled: true, dir: resolve(PACKAGE_ROOT, '..', 'backups', 'memory-hub'), keepDays: 14 },
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
  if (!isAbsolute(merged.backup.dir)) merged.backup.dir = resolve(PACKAGE_ROOT, merged.backup.dir);
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
    reviewLookbackHours: clamp(base.reviewLookbackHours, 72, 1, 24 * 14),
    reviewLimit: Math.trunc(clamp(base.reviewLimit, 30, 1, 100)),
    reviewIntervalHours: clamp(base.reviewIntervalHours, 20, 1, 24 * 7),
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
