import { isSceneAllowed } from '@memsvc/core';
import type { TokenView } from '@memsvc/core';
import { errors } from './errors.js';
import type { TokenRecord, TokenStore } from './tokens.js';

export interface AuthContext {
  record: Omit<TokenRecord, 'hash'>;
  view: TokenView;
  scene: string;
}

/**
 * Resolves the bearer token and the scene for this request.
 *
 * The scene can never be chosen freely: it must be one the token is allowed to
 * act in, so a group token cannot ask for `qq:owner` data by passing a scene.
 */
export function authenticate(
  authorization: string | undefined,
  tokens: TokenStore,
  requestedScene?: string,
): AuthContext {
  const record = tokens.verify(extractBearer(authorization));
  if (!record) throw errors.unauthorized();

  const view: TokenView = {
    surface: record.surface,
    scopes: record.scopes,
    scenes: record.scenes,
  };
  const scene = requestedScene && requestedScene.trim().length > 0 ? requestedScene.trim() : record.surface;
  if (!isSceneAllowed(view, scene)) {
    throw errors.forbidden(`scene "${scene}" is not allowed for this token`);
  }

  const { hash: _hash, ...safe } = record;
  return { record: safe, view, scene };
}

export function extractBearer(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1]?.trim();
}
