/**
 * SQL mirror of `canRead` (packages/core/src/policy.ts).
 *
 * Filtering happens in SQL so a group token's query never even loads owner or
 * sensitive rows. If you change the rules here, change core/policy.ts too — the
 * privacy tests assert both sides agree.
 *
 * Model: audience + one sensitivity bit. `sensitive` rows are pinned to the
 * owner's own audiences and need the token's `sensitive:read` scope.
 */
import { ROOT_SCOPE, SHARED_SCOPE, restrictionFor } from '@memsvc/core';
import type { Restriction, TokenView } from '@memsvc/core';

export interface Visibility {
  where: string;
  params: (string | number)[];
}

export interface VisibilityOptions {
  /** Allow the owner's own audiences (recall disclosure only). */
  ownerDisclosure?: boolean;
  /** Pre-computed restriction; defaults to the configured policy. */
  restriction?: Restriction;
}

export function visibilityClause(
  token: TokenView,
  scene: string,
  alias = 'c',
  options: VisibilityOptions = {},
): Visibility {
  const parts: string[] = [];
  const params: (string | number)[] = [];
  const restriction = options.restriction ?? restrictionFor(token.scopes, scene);

  parts.push(`${alias}.privacy <> 'secret'`);
  // Short-term memories are invisible once their TTL passes, even before purge.
  parts.push(`(${alias}.expires_at IS NULL OR ${alias}.expires_at > ?)`);
  params.push(Date.now());

  // `normal` / `personal` plus `sensitive` when the token carries the scope.
  parts.push(`${alias}.privacy IN (${restriction.allowed.map(() => '?').join(', ')})`);
  params.push(...restriction.allowed);

  if (!token.scopes.includes(ROOT_SCOPE)) {
    const scopes = token.scopes.filter(
      (scope) => scope !== ROOT_SCOPE && scope !== restriction.sensitiveScope && scope !== 'work:read',
    );
    const placeholders = scopes.map(() => '?').join(', ');
    const scopeFilter =
      scopes.length > 0 ? `s.scope = '${SHARED_SCOPE}' OR s.scope IN (${placeholders})` : `s.scope = '${SHARED_SCOPE}'`;

    const normal = `EXISTS (SELECT 1 FROM chunk_scopes s WHERE s.chunk_id = ${alias}.id AND (${scopeFilter}))`;
    const ownerAudiences = restriction.ownerAudiences.map(() => '?').join(', ');
    const ownerBorrow = options.ownerDisclosure
      ? `EXISTS (SELECT 1 FROM chunk_scopes s2 WHERE s2.chunk_id = ${alias}.id AND s2.scope IN (${ownerAudiences}))` +
        ` AND NOT EXISTS (SELECT 1 FROM chunk_scopes s3 WHERE s3.chunk_id = ${alias}.id AND s3.scope LIKE '%:private:%')`
      : '';

    const visibility = ownerBorrow.length > 0 ? `(${normal} OR (${ownerBorrow}))` : normal;
    parts.push(`(${visibility})`);
    params.push(...scopes, ...(options.ownerDisclosure ? restriction.ownerAudiences : []));
  }

  return { where: parts.join(' AND '), params };
}

/** Audience rows written to `chunk_scopes`; `shared` is matched by every token. */
export function scopesForAudience(audience: readonly string[]): string[] {
  return Array.from(new Set(audience.map((scope) => scope.trim()).filter(Boolean)));
}
