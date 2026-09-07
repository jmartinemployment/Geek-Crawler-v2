/**
 * Seed URL normalization aligned with GeekBackend GeekCrawlerSeedNormalizer.
 */

import { createHash } from 'node:crypto';

export function tryNormalizeSeedUrl(raw: string): string | null {
  let trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('* ') || trimmed.startsWith('- ') || trimmed.startsWith('+ ')) {
    trimmed = trimmed.slice(2).trimStart();
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    if (trimmed.startsWith('//')) trimmed = `https:${trimmed}`;
    else trimmed = `https://${trimmed.replace(/^\/+/, '')}`;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  // strip hash; keep query like Backend GetLeftPart(Query)
  url.hash = '';
  let out = url.toString();
  if (url.pathname === '/' && out.endsWith('/')) {
    out = out.replace(/\/$/, '');
  }
  return out;
}

export function normalizeSeeds(rawSeeds: string[]): string[] {
  const urls: string[] = [];
  for (const raw of rawSeeds) {
    const n = tryNormalizeSeedUrl(raw);
    if (!n) continue;
    if (!urls.some((u) => u.toLowerCase() === n.toLowerCase())) urls.push(n);
  }
  return urls;
}

/** Host key for matching seeds (www-stripped lowercase host). */
export function seedHostKey(rawUrl: string): string | null {
  try {
    const u = new URL(tryNormalizeSeedUrl(rawUrl) ?? rawUrl);
    let host = u.hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    return host || null;
  } catch {
    return null;
  }
}

export function computeSeedKey(normalizedSeeds: string[]): string {
  const sorted = [...normalizedSeeds].sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase()),
  );
  const json = JSON.stringify(sorted);
  return createHash('sha256').update(json).digest('hex');
}
