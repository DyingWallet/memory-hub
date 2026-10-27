/**
 * Privacy policy: the single place that decides who may read a memory.
 *
 * One sensitivity bit on top of the audience model:
 *  - privacy is normal | personal | sensitive | secret;
 *  - audience already decides which room a memory lives in (main, qq:owner,
 *    qq:group:<id>, qq:private:<id>, ...);
 *  - a token with `sensitiveScope` (default `sensitive:read`) may additionally
 *    read/write `sensitive` memories, which are pinned to the owner's own
 *    audiences;
 *  - `secret` needs `secret:read` / `secret:write` (root `*` has both) and is
 *    pinned to `secretAudiences` (default `main`), so group / third-party
 *    private / pet tokens never see it. It is plaintext on disk, not encrypted.
 *
 * Older data may still carry `work` / `financial` / ... values; the migration
 * rewrites them to `sensitive` and keeps the old name as a tag. Any non
 * normal/personal/secret value is treated as sensitive for safety.
 */
import type { MemoryKind, Privacy, ScopeList } from '@memsvc/protocol';

export const ROOT_SCOPE = '*';
export const SHARED_SCOPE = 'shared';
export const NORMAL_LABEL = 'normal';
export const PERSONAL_LABEL = 'personal';
export const SENSITIVE_LABEL = 'sensitive';
export const SECRET_LABEL = 'secret';

/** `secret` 的读写各要一个 scope；root（`*`）同时具备两者。 */
export const SECRET_READ_SCOPE = 'secret:read';
export const SECRET_WRITE_SCOPE = 'secret:write';

export interface PrivacyPolicy {
  /** Token scope required to read/write `sensitive` memories. */
  sensitiveScope: string;
  /** Audiences `sensitive` memories are pinned to (owner's own rooms). */
  sensitiveAudiences: string[];
  /** Audiences `secret` memories are pinned to. */
  secretAudiences: string[];
  /** Audiences that count as "the owner" for recall disclosure. */
  ownerAudiences: string[];
}

export const DEFAULT_POLICY: PrivacyPolicy = {
  sensitiveScope: 'sensitive:read',
  sensitiveAudiences: ['main', 'qq:owner'],
  secretAudiences: ['main'],
  ownerAudiences: ['main', 'qq:owner'],
};

/** Backwards-compatible alias for callers that still import the old name. */
export type RestrictedPolicy = PrivacyPolicy;

/** Removed in the single-bit model; kept as a no-op so old call sites compile. */
export function classifyPrivacy(): undefined {
  return undefined;
}

export interface MemoryView {
  kind: MemoryKind;
  privacy: Privacy;
  audience: readonly string[];
}

export interface TokenView {
  surface: string;
  /** Scopes the token may read (`*` = root, `sensitive:read` = sensitive). */
  scopes: readonly string[];
  /** Scenes the token may act in (`*` = any). */
  scenes: readonly string[];
}

export function hasRootScope(scopes: readonly string[]): boolean {
  return scopes.includes(ROOT_SCOPE);
}

export function hasCapability(scopes: readonly string[], policy: PrivacyPolicy = DEFAULT_POLICY): boolean {
  // `work:read` is accepted as a legacy alias so an upgrade does not silently
  // widen access; the migration renames it in tokens.json.
  return scopes.includes(policy.sensitiveScope) || scopes.includes('work:read');
}

/** `secret` 的读：root 或显式 `secret:read`。群、私聊、pet 都不带这个 scope。 */
export function hasSecretRead(scopes: readonly string[]): boolean {
  return scopes.includes(ROOT_SCOPE) || scopes.includes(SECRET_READ_SCOPE);
}

/** `secret` 的写：root 或显式 `secret:write`。 */
export function hasSecretWrite(scopes: readonly string[]): boolean {
  return scopes.includes(ROOT_SCOPE) || scopes.includes(SECRET_WRITE_SCOPE);
}

export function isSceneAllowed(token: TokenView, scene: string): boolean {
  if (token.scenes.includes(ROOT_SCOPE)) return true;
  return token.scenes.includes(scene);
}

export function isSensitive(privacy: Privacy): boolean {
  if (privacy === SENSITIVE_LABEL) return true;
  // Unknown / legacy labels are treated as sensitive (fail closed).
  return privacy !== NORMAL_LABEL && privacy !== PERSONAL_LABEL && privacy !== SECRET_LABEL;
}

/** Kept for callers that still say "restricted"; `sensitive` is the only tier. */
export function isRestricted(privacy: Privacy, _policy: PrivacyPolicy = DEFAULT_POLICY): boolean {
  return isSensitive(privacy);
}

export function allowedPrivacy(scopes: readonly string[], policy: PrivacyPolicy = DEFAULT_POLICY): string[] {
  const allowed = [NORMAL_LABEL, PERSONAL_LABEL];
  if (hasCapability(scopes, policy)) allowed.push(SENSITIVE_LABEL);
  if (hasSecretRead(scopes)) allowed.push(SECRET_LABEL);
  return allowed;
}

/** Pre-computed restriction for one request (SQL + tests share it). */
export interface Restriction {
  /** Privacy values this token/scene may read. */
  allowed: string[];
  /** Audiences treated as the owner's own rooms. */
  ownerAudiences: string[];
  sensitiveScope: string;
}

export function restrictionFor(
  scopes: readonly string[],
  _scene: string,
  policy: PrivacyPolicy = DEFAULT_POLICY,
): Restriction {
  return {
    allowed: allowedPrivacy(scopes, policy),
    ownerAudiences: [...policy.ownerAudiences],
    sensitiveScope: policy.sensitiveScope,
  };
}

/**
 * Can `token` read `memory` while acting in `scene`?
 * Mirrors the SQL filter in `packages/server/src/visibility.ts`.
 */
export function canRead(
  memory: MemoryView,
  token: TokenView,
  scene: string,
  policy: PrivacyPolicy = DEFAULT_POLICY,
): boolean {
  if (!isSceneAllowed(token, scene)) return false;
  if (memory.privacy === SECRET_LABEL) {
    // secret 只对 root / 显式 secret:read 开放；其余令牌当作不存在。
    if (!hasSecretRead(token.scopes)) return false;
    if (hasRootScope(token.scopes)) return true;
    return memory.audience.some((scope) => token.scopes.includes(scope) || scope === SHARED_SCOPE);
  }
  if (isSensitive(memory.privacy) && !hasCapability(token.scopes, policy)) return false;
  if (hasRootScope(token.scopes)) return true;
  if (memory.audience.includes(SHARED_SCOPE)) return true;
  return memory.audience.some((scope) => token.scopes.includes(scope));
}

const MAIN_ONLY_KINDS: ReadonlySet<MemoryKind> = new Set<MemoryKind>([
  'journal',
  'decision',
  'knowledge',
  'audience',
  'project',
  'profile',
  'preference',
]);

/** Default audience by kind. When in doubt, `['main']` — the conservative choice. */
export function defaultAudience(kind: MemoryKind, scene?: string): ScopeList {
  if (kind === 'identity') return [SHARED_SCOPE];
  if (kind === 'qq-topic' || kind === 'qq-impression' || kind === 'chat') {
    return scene && scene !== 'main' ? [scene] : ['main'];
  }
  if (MAIN_ONLY_KINDS.has(kind)) return ['main'];
  return scene && scene !== 'main' ? [scene] : ['main'];
}

/** Fills in missing fields; never widens an explicitly given audience. */
export function normalizeAudience(
  audience: readonly string[] | undefined,
  kind: MemoryKind,
  scene?: string,
): ScopeList {
  const cleaned = (audience ?? []).map((s) => s.trim()).filter(Boolean);
  if (cleaned.length === 0) return defaultAudience(kind, scene);
  return Array.from(new Set(cleaned));
}

export function defaultPrivacy(kind: MemoryKind, source?: string): Privacy {
  if (source === 'work') return SENSITIVE_LABEL;
  if (kind === 'qq-impression') return PERSONAL_LABEL;
  return NORMAL_LABEL;
}

/** Sensitive memories are pinned to the owner's own audiences. */
export function audienceForWrite(
  requestedAudience: readonly string[] | undefined,
  kind: MemoryKind,
  privacy: Privacy,
  scene?: string,
  policy: PrivacyPolicy = DEFAULT_POLICY,
): ScopeList {
  const base = normalizeAudience(requestedAudience, kind, scene);
  // secret 只钉在 secretAudiences，不随请求来的 audience 扩散。
  if (privacy === SECRET_LABEL) return [...policy.secretAudiences];
  if (!isSensitive(privacy)) return base;
  const pinned = base.filter((scope) => policy.sensitiveAudiences.includes(scope));
  return Array.from(new Set(pinned.length > 0 ? pinned : policy.sensitiveAudiences));
}

/**
 * A write token may only create memories the same token could read back,
 * except that root tokens may write anywhere.
 */
export function canWriteAudience(token: TokenView, audience: readonly string[]): boolean {
  if (hasRootScope(token.scopes)) return true;
  return audience.every((scope) => token.scopes.includes(scope) || scope === SHARED_SCOPE);
}
