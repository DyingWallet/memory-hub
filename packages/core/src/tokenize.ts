/**
 * Chinese text tokenization for SQLite FTS5.
 *
 * Why bigrams: FTS5's `trigram` tokenizer does not match two-character CJK
 * queries such as 「记忆」/「桌宠」 in this Node build, while `unicode61` treats a
 * whole CJK run as one token. Pre-tokenizing into bigrams (with spaces) makes
 * both indexing and querying land on the same units.
 *
 * Index side: bigrams + unigrams (so a single-character query still hits).
 * Query side: bigrams for runs of length >= 2, unigram only for length 1.
 */
import { STOPWORDS } from './stopwords.js';

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const SEGMENT_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|[a-z0-9]+/gu;

export interface Segment {
  kind: 'cjk' | 'word';
  value: string;
}

export function normalizeText(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

/** Splits normalized text into CJK runs and ASCII/digit words. */
export function segment(text: string): Segment[] {
  const out: Segment[] = [];
  for (const match of normalizeText(text).matchAll(SEGMENT_RE)) {
    const value = match[0];
    out.push({ kind: CJK_RE.test(value[0] ?? '') ? 'cjk' : 'word', value });
  }
  return out;
}

function cjkBigrams(run: string, includeUnigrams: boolean): string[] {
  const chars = Array.from(run);
  const out: string[] = [];
  if (includeUnigrams) out.push(...chars);
  for (let i = 0; i + 1 < chars.length; i += 1) {
    out.push(`${chars[i]}${chars[i + 1]}`);
  }
  return out;
}

/** Tokens written into the FTS `tokens` column. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const seg of segment(text)) {
    if (seg.kind === 'cjk') out.push(...cjkBigrams(seg.value, true));
    else out.push(seg.value);
  }
  return dedupe(out);
}

/** Tokens used to build a MATCH expression (fewer, higher-signal). */
export function tokenizeQuery(text: string): string[] {
  const out: string[] = [];
  for (const seg of segment(text)) {
    if (seg.kind === 'cjk') {
      if (Array.from(seg.value).length === 1) out.push(seg.value);
      else out.push(...cjkBigrams(seg.value, false));
    } else if (seg.value.length >= 2) out.push(seg.value);
    else if (seg.value.length === 1) out.push(seg.value);
  }
  return dedupe(out);
}

export function dedupe(tokens: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokens) {
    if (!token) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

export type MatchMode = 'and' | 'or';

/** Builds an FTS5 MATCH expression. Tokens are quoted, so no operator injection. */
export function buildFtsQuery(tokens: readonly string[], mode: MatchMode = 'and'): string {
  const clean = tokens.filter((t) => t.length > 0);
  if (clean.length === 0) return '';
  const quoted = clean.map((t) => `"${t.replaceAll('"', '""')}"`);
  return quoted.join(mode === 'and' ? ' AND ' : ' OR ');
}

const STOP_CHAR = new Set(Array.from(Array.from(STOPWORDS).join('')));

function isStopToken(token: string): boolean {
  if (STOPWORDS.has(token)) return true;
  // A pure-CJK bigram/unigram made only of stop characters carries no signal.
  const chars = Array.from(token);
  if (chars.length <= 2 && chars.every((c) => STOP_CHAR.has(c))) return true;
  if (/^[a-z0-9]$/.test(token)) return false;
  return false;
}

/**
 * Extracts query keywords from a free-form sentence.
 * Bigrams win over unigrams; stopwords are dropped; order is preserved.
 */
export function extractKeywords(text: string, max = 8): string[] {
  const tokens = tokenizeQuery(text);
  const strong: string[] = [];
  const weak: string[] = [];
  for (const token of tokens) {
    if (isStopToken(token)) continue;
    const cjk = /[\p{Script=Han}]/u.test(token);
    if (cjk && Array.from(token).length === 1) weak.push(token);
    else strong.push(token);
  }
  const picked = dedupe([...strong, ...weak]).slice(0, max);
  return picked;
}

/** True when the query has no usable keyword (caller should skip search). */
export function isKeywordless(text: string): boolean {
  return extractKeywords(text).length === 0;
}
