import { createHash } from 'node:crypto';

/** Mirror GeekCrawlerSeedNormalizer.ComputeSeedKey / SerializeSeeds. */
export function normalizeSeedUrl(raw: string): string | null {
  let trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('* ') || trimmed.startsWith('- ') || trimmed.startsWith('+ ')) {
    trimmed = trimmed.slice(2).trimStart();
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    if (trimmed.startsWith('//')) trimmed = `https:${trimmed}`;
    else trimmed = `https://${trimmed.replace(/^\/+/, '')}`;
  }
  let uri: URL;
  try {
    uri = new URL(trimmed);
  } catch {
    return null;
  }
  if (uri.protocol !== 'http:' && uri.protocol !== 'https:') return null;
  if (!uri.hostname) return null;
  let url = uri.origin + uri.pathname + uri.search;
  if (url.endsWith('/') && uri.pathname === '/') url = url.slice(0, -1);
  return url;
}

export function normalizeSeeds(rawSeeds: string[]): string[] {
  const out: string[] = [];
  for (const raw of rawSeeds) {
    const n = normalizeSeedUrl(raw);
    if (!n) continue;
    if (!out.some((u) => u.toLowerCase() === n.toLowerCase())) out.push(n);
  }
  return out;
}

export function computeSeedKey(normalizedSeeds: string[]): string {
  const sorted = [...normalizedSeeds].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'accent' }),
  );
  const json = JSON.stringify(sorted);
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** Host key for matching seed URLs (strips www., lowercases). */
export function seedHostKey(raw: string): string | null {
  const normalized = normalizeSeedUrl(raw);
  if (!normalized) return null;
  try {
    return new URL(normalized).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}
