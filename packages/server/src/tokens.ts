import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { newTokenId } from '@memsvc/core';

export interface TokenRecord {
  id: string;
  name: string;
  /** The scene this token normally acts in (`main`, `qq:owner`, `qq:group:…`). */
  surface: string;
  /** Scenes it may pass as `scene` (['*'] = any). */
  scenes: string[];
  /** Audience scopes it may read (`*` = root, `work:read` = work/financial). */
  scopes: string[];
  hash: string;
  created_at: string;
  revoked_at: string | null;
  last_used_at?: string;
}

interface TokenFile {
  version: 1;
  tokens: TokenRecord[];
}

export interface IssueOptions {
  name: string;
  surface: string;
  scopes: string[];
  scenes?: string[];
}

export interface IssuedToken {
  record: TokenRecord;
  /** Plaintext — shown once, never persisted. */
  token: string;
}

const TOKEN_PREFIX = 'msv1';

export class TokenStore {
  private records: TokenRecord[] = [];
  private loaded = false;
  private loadedAt = 0;

  constructor(private readonly file: string) {}

  /**
   * Reloads when the token file changes on disk. Token issuance/revocation is
   * done by the admin CLI in another process, so a server that only read the
   * file at startup would reject freshly issued tokens until restarted.
   */
  private load(): void {
    if (!existsSync(this.file)) {
      this.records = [];
      this.loaded = true;
      this.loadedAt = 0;
      return;
    }
    let mtime = 0;
    try {
      mtime = statSync(this.file).mtimeMs;
    } catch {
      return;
    }
    if (this.loaded && mtime === this.loadedAt) return;
    try {
      const raw = readFileSync(this.file, 'utf8');
      if (raw.trim().length === 0) {
        this.records = [];
        this.loaded = true;
        this.loadedAt = mtime;
        return;
      }
      const parsed = JSON.parse(raw) as TokenFile;
      if (!Array.isArray(parsed.tokens)) throw new Error(`invalid token file: ${this.file}`);
      this.records = parsed.tokens;
      this.loaded = true;
      this.loadedAt = mtime;
    } catch (error) {
      // A half-written file must not lock everyone out; keep the previous view.
      if (!this.loaded) throw error;
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const body: TokenFile = { version: 1, tokens: this.records };
    writeFileSync(this.file, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      this.loadedAt = statSync(this.file).mtimeMs;
    } catch {
      this.loadedAt = Date.now();
    }
  }

  hasTokens(): boolean {
    this.load();
    return this.records.some((record) => record.revoked_at === null);
  }

  list(): TokenRecord[] {
    this.load();
    return this.records.map((record) => ({ ...record }));
  }

  issue(options: IssueOptions): IssuedToken {
    this.load();
    if (!options.name.trim()) throw new Error('token name is required');
    const surface = options.surface.trim();
    if (!surface) throw new Error('token surface is required');
    const scenes = options.scenes && options.scenes.length > 0 ? options.scenes : [surface];
    const scopes = options.scopes.length > 0 ? options.scopes : [surface];

    // A token must be able to read the scene it acts in, or it is useless.
    if (!scopes.includes('*') && !scopes.includes(surface)) {
      scopes.push(surface);
    }

    const id = newTokenId();
    const secret = randomBytes(32).toString('base64url');
    const record: TokenRecord = {
      id,
      name: options.name.trim(),
      surface,
      scenes,
      scopes,
      hash: hashSecret(secret),
      created_at: new Date().toISOString(),
      revoked_at: null,
    };
    this.records.push(record);
    this.persist();
    return { record: { ...record }, token: `${TOKEN_PREFIX}.${id}.${secret}` };
  }

  revoke(id: string): TokenRecord | null {
    this.load();
    const record = this.records.find((item) => item.id === id);
    if (!record) return null;
    record.revoked_at = new Date().toISOString();
    this.persist();
    return { ...record };
  }

  /** Verifies a bearer token; returns the record when valid and not revoked. */
  verify(bearer: string | undefined): TokenRecord | null {
    if (!bearer) return null;
    this.load();
    const parts = bearer.trim().split('.');
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
    const [, id, secret] = parts;
    if (!id || !secret) return null;
    const record = this.records.find((item) => item.id === id);
    if (!record || record.revoked_at !== null) return null;
    if (!verifySecret(secret, record.hash)) return null;
    record.last_used_at = new Date().toISOString();
    return record;
  }
}

export function hashSecret(secret: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(secret, salt, 32);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export function verifySecret(secret: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const salt = Buffer.from(parts[1] ?? '', 'base64url');
    const expected = Buffer.from(parts[2] ?? '', 'base64url');
    const actual = scryptSync(secret, salt, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
