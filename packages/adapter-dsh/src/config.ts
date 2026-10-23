import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface MemoryPluginConfig {
  endpoint: string;
  tokenFile: string;
  surface: string;
  scene?: string;
  bootstrap: boolean;
  recall: boolean;
  write: boolean;
  timeoutMs: number;
}

export const DEFAULT_PLUGIN_CONFIG: MemoryPluginConfig = {
  endpoint: 'http://127.0.0.1:8787',
  tokenFile: join(homedir(), '.dsh', 'memory-token'),
  surface: 'main',
  bootstrap: true,
  recall: true,
  write: true,
  timeoutMs: 4000,
};

/**
 * Config precedence: env > plugin config file > defaults.
 * The DSH settings page is a renderer over this file, not the source of truth.
 */
export function loadPluginConfig(file?: string): MemoryPluginConfig {
  const path = file ?? process.env.MEMD_PLUGIN_CONFIG ?? join(homedir(), '.dsh', 'plugins', 'dsh-memory', 'config.json');
  let fromFile: Partial<MemoryPluginConfig> = {};
  if (existsSync(path)) {
    try {
      fromFile = JSON.parse(readFileSync(path, 'utf8')) as Partial<MemoryPluginConfig>;
    } catch (error) {
      console.error(`[memory-plugin] ignoring invalid config ${path}: ${(error as Error).message}`);
    }
  }

  const merged: MemoryPluginConfig = { ...DEFAULT_PLUGIN_CONFIG, ...fromFile };

  if (process.env.MEMD_ENDPOINT) merged.endpoint = process.env.MEMD_ENDPOINT;
  if (process.env.MEMD_TOKEN_FILE) merged.tokenFile = process.env.MEMD_TOKEN_FILE;
  if (process.env.MEMD_SURFACE) merged.surface = process.env.MEMD_SURFACE;
  if (process.env.MEMD_SCENE) merged.scene = process.env.MEMD_SCENE;

  merged.endpoint = merged.endpoint.replace(/\/+$/, '');
  return merged;
}
