/**
 * Hand-written types for the DSH plugin host API.
 *
 * DSH's plugin API is not published as a typed package on this machine, so all
 * `any`-ish edges live here and nowhere else. Keep this file in sync with the
 * findings in `docs/SPIKE-DSH.md`.
 */

export interface DshSessionInfo {
  id: string;
  surface?: string;
  scene?: string;
  cwd?: string;
}

export interface DshSystemReminder {
  type: 'system-reminder';
  text: string;
}

/** Hook the plugin host may call before the first model turn of a session. */
export type SessionStartHook = (session: DshSessionInfo) => Promise<DshSystemReminder | null> | DshSystemReminder | null;

export interface DshPluginContext {
  /** Provided when the host supports pre-turn context injection (spike A). */
  onSessionStart?: (hook: SessionStartHook) => void;
  /** Host logging; falls back to console.error when absent. */
  log?: {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
}
