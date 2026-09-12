/**
 * URL comparison keys, redirect aliases, and content fingerprints for crawl dedup.
 * crawlDedupKey is lossy comparison only — never use it as a fetch URL.
 * normalizeCrawlUrl remains the fetchable form (see sitemap.ts).
 */

import { createHash } from 'node:crypto';

/** Marketing / session noise — unambiguous params only (never page/p/sort/variant). */
export const DEDUP_NOISE_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_reader',
  'utm_name',
  'utm_social',
  'utm_social-type',
  'gclid',
  'gbraid',
  'wbraid',
  'fbclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'ref',
  'referrer',
  'source',
  '_ga',
  '_gl',
  '_hsenc',
  '_hsmi',
  'hsCtaTracking',
  'sessionid',
  'sid',
  'yclid',
  'igshid',
  'mc_tc',
  'mkt_tok',
  'vero_id',
  'wickedid',
]);

export function aggressiveAliasesEnabled(): boolean {
  const v = process.env.AGGRESSIVE_URL_ALIASES?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export type CrawlDedupKeyOpts = {
  /** Host/protocol/slash/case/index + query-param sorting. Off by default. */
  aggressive?: boolean;
};

/**
 * Lossy comparison key. Never request this URL.
 * Default: lowercase host, drop default port, drop fragment, drop noise params.
 * Preserves www/apex, http/https, path case, trailing slash, query order.
 */
export function crawlDedupKey(raw: string, opts?: CrawlDedupKeyOpts): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  const aggressive = opts?.aggressive ?? aggressiveAliasesEnabled();
  u.hash = '';

  if (aggressive) {
    if (u.protocol === 'http:') u.protocol = 'https:';
    let host = u.hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    u.hostname = host;
    let pathname = u.pathname;
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }
    pathname = pathname.replace(/\/index\.html?$/i, '') || '/';
    u.pathname = pathname.toLowerCase();
  } else {
    u.hostname = u.hostname.toLowerCase();
  }

  if (
    (u.protocol === 'http:' && u.port === '80') ||
    (u.protocol === 'https:' && u.port === '443')
  ) {
    u.port = '';
  }

  const kept: Array<[string, string]> = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (DEDUP_NOISE_PARAMS.has(k.toLowerCase())) continue;
    kept.push([k, v]);
  }
  if (aggressive) {
    kept.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  }
  u.search = '';
  for (const [k, v] of kept) {
    u.searchParams.append(k, v);
  }

  return u.toString();
}

const ALIAS_RESOLVE_MAX_DEPTH = 16;

/** Variant key → representative key. Learned from redirects at runtime. */
export class AliasTable {
  private readonly map = new Map<string, string>();
  learned = 0;

  get size(): number {
    return this.map.size;
  }

  /** Reject self-maps and empty. Caller must ensure same-site. */
  learn(variantKey: string, representativeKey: string): boolean {
    if (!variantKey || !representativeKey) return false;
    if (variantKey === representativeKey) return false;
    const prev = this.map.get(variantKey);
    if (prev === representativeKey) return false;
    this.map.set(variantKey, representativeKey);
    this.learned += 1;
    return true;
  }

  resolve(key: string): string {
    let cur = key;
    const seen = new Set<string>();
    for (let i = 0; i < ALIAS_RESOLVE_MAX_DEPTH; i++) {
      if (seen.has(cur)) return cur;
      seen.add(cur);
      const next = this.map.get(cur);
      if (!next || next === cur) return cur;
      cur = next;
    }
    return cur;
  }
}

export function htmlHash(html: string): string {
  return createHash('sha256').update(html).digest('hex');
}

/** Whitespace collapsed only; case preserved (identity, not similarity). */
export function contentHash(markdown: string): string {
  const collapsed = markdown.replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(collapsed).digest('hex');
}

function tokenizeForSimhash(markdown: string): string[] {
  return markdown
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** 64-bit SimHash over word n-shingles; returns 16-char hex. */
export function simhash64(markdown: string, shingle = 5): string {
  const tokens = tokenizeForSimhash(markdown);
  const n = Math.max(1, Math.min(12, Math.floor(shingle)));
  const weights = new Float64Array(64);

  if (tokens.length === 0) {
    return '0'.repeat(16);
  }

  const limit = Math.max(1, tokens.length - n + 1);
  for (let i = 0; i < limit; i++) {
    const gram = tokens.slice(i, i + n).join(' ');
    const digest = createHash('sha256').update(gram).digest();
    for (let b = 0; b < 64; b++) {
      const byte = digest[b >> 3]!;
      const bit = (byte >> (7 - (b & 7))) & 1;
      weights[b]! += bit ? 1 : -1;
    }
  }

  let hi = 0n;
  let lo = 0n;
  for (let b = 0; b < 64; b++) {
    if (weights[b]! >= 0) {
      if (b < 32) hi |= 1n << BigInt(31 - b);
      else lo |= 1n << BigInt(63 - b);
    }
  }
  // Pack as unsigned 64-bit hex (hi<<32|lo conceptually; use full loop)
  let value = 0n;
  for (let b = 0; b < 64; b++) {
    if (weights[b]! >= 0) value |= 1n << BigInt(63 - b);
  }
  return value.toString(16).padStart(16, '0');
}

export function hammingHex64(a: string, b: string): number {
  const x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  let v = x;
  while (v > 0n) {
    n += Number(v & 1n);
    v >>= 1n;
  }
  return n;
}

export type NearDupConfig = {
  hamming: number;
  minChars: number;
  shingle: number;
};

export function nearDupConfig(): NearDupConfig {
  const hamming = Math.max(
    0,
    Math.min(7, Number(process.env.NEAR_DUP_HAMMING ?? 3) || 3),
  );
  const minChars = Math.max(0, Number(process.env.NEAR_DUP_MIN_CHARS ?? 500) || 500);
  const shingle = Math.max(1, Math.min(12, Number(process.env.NEAR_DUP_SHINGLE ?? 5) || 5));
  return { hamming, minChars, shingle };
}

export type SimhashEntry = {
  simhash: string;
  contentHash: string;
  pageId: string;
  url: string;
  title?: string | null;
  markdownLength: number;
  canonicalUrl?: string | null;
  excerpt: string;
};

/**
 * Banded SimHash index. Band count = threshold + 1 so pigeonhole holds for d ≤ threshold.
 */
export class SimhashIndex {
  private readonly bands: Map<string, SimhashEntry[]>[];
  private readonly bandBits: number[];
  readonly threshold: number;

  constructor(threshold: number) {
    this.threshold = Math.max(0, Math.min(7, Math.floor(threshold)));
    const bands = this.threshold + 1;
    const base = Math.floor(64 / bands);
    let rem = 64 % bands;
    this.bandBits = [];
    for (let i = 0; i < bands; i++) {
      const w = base + (rem > 0 ? 1 : 0);
      if (rem > 0) rem -= 1;
      this.bandBits.push(w);
    }
    this.bands = this.bandBits.map(() => new Map());
  }

  private bandKeys(simhash: string): string[] {
    const value = BigInt(`0x${simhash}`);
    const keys: string[] = [];
    let shift = 64n;
    for (let i = 0; i < this.bandBits.length; i++) {
      const w = BigInt(this.bandBits[i]!);
      shift -= w;
      const mask = (1n << w) - 1n;
      const part = (value >> shift) & mask;
      keys.push(`${i}:${part.toString(16)}`);
    }
    return keys;
  }

  add(entry: SimhashEntry): void {
    for (const key of this.bandKeys(entry.simhash)) {
      const bucket = this.bands[Number(key.split(':')[0]!)]!;
      const list = bucket.get(key) ?? [];
      list.push(entry);
      bucket.set(key, list);
    }
  }

  findNear(simhash: string): { entry: SimhashEntry; distance: number } | null {
    const candidates = new Map<string, SimhashEntry>();
    for (const key of this.bandKeys(simhash)) {
      const bi = Number(key.split(':')[0]!);
      const list = this.bands[bi]!.get(key) ?? [];
      for (const e of list) {
        candidates.set(e.contentHash, e);
      }
    }
    let best: { entry: SimhashEntry; distance: number } | null = null;
    for (const e of candidates.values()) {
      const d = hammingHex64(simhash, e.simhash);
      if (d <= this.threshold && (!best || d < best.distance)) {
        best = { entry: e, distance: d };
      }
    }
    return best;
  }
}
