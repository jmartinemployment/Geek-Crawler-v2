import { hostnameKey } from './links.js';
import { localeNormalizeForMap } from './locale-path.js';
import { BOT } from '../bot/identity.js';
import { crawlDedupKey, type AliasTable } from './dedup.js';

const MAX_SITEMAPS = 40;
const MAX_URLS = 50_000;
const FETCH_MS = 20_000;

/** Tracking / session params — never meaningful sitemap pages. */
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
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
  'sessionid',
  'sid',
]);

export type SiteMapIndex = {
  /**
   * When true, only URLs in `urls` may be enqueued (sitemap is the map).
   * When false, no usable sitemap — open same-site BFS (after normalize).
   */
  hasMap: boolean;
  urls: Set<string>;
  sources: string[];
};

function sameSite(seed: URL, candidate: URL): boolean {
  if (seed.protocol !== candidate.protocol) return false;
  return hostnameKey(seed.hostname) === hostnameKey(candidate.hostname);
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_MS),
      headers: {
        Accept: 'application/xml,text/xml,text/plain,*/*',
        'User-Agent': `${BOT.name}/1.0 (+https://geekatyourspot.com)`,
      },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function extractLocs(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const loc = m[1]?.trim();
    if (loc) out.push(loc);
  }
  return out;
}

function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex[\s>]/i.test(xml);
}

async function sitemapUrlsFromRobots(origin: string): Promise<string[]> {
  const text = await fetchText(`${origin}/robots.txt`);
  if (!text) return [];
  const found: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*Sitemap:\s*(\S+)/i);
    if (m?.[1]) found.push(m[1].trim());
  }
  return found;
}

/**
 * Normalize for map membership / enqueue: drop hash + tracking params.
 * Keeps content-bearing query strings exactly as the site maps them.
 */
export function normalizeCrawlUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) {
      u.searchParams.delete(key);
    }
  }
  return u.toString();
}

/** Load sitemap URL set for one seed origin (robots.txt + /sitemap.xml). */
export async function loadSiteMapForSeed(seedUrl: string): Promise<SiteMapIndex> {
  let seed: URL;
  try {
    seed = new URL(seedUrl);
  } catch {
    return { hasMap: false, urls: new Set(), sources: [] };
  }

  const origin = seed.origin;
  const sources = new Set<string>();
  const queue: string[] = [];

  for (const s of await sitemapUrlsFromRobots(origin)) {
    queue.push(s);
    sources.add(s);
  }
  const fallback = `${origin}/sitemap.xml`;
  if (![...sources].some((s) => s.replace(/\/$/, '') === fallback.replace(/\/$/, ''))) {
    queue.push(fallback);
  }

  const urlSet = new Set<string>();
  const seenSitemaps = new Set<string>();
  let sitemapsFetched = 0;

  while (queue.length > 0 && sitemapsFetched < MAX_SITEMAPS && urlSet.size < MAX_URLS) {
    const smUrl = queue.shift()!;
    if (seenSitemaps.has(smUrl)) continue;
    seenSitemaps.add(smUrl);

    const xml = await fetchText(smUrl);
    if (!xml) continue;
    sitemapsFetched += 1;
    sources.add(smUrl);

    const locs = extractLocs(xml);
    if (isSitemapIndex(xml)) {
      for (const child of locs) {
        if (!seenSitemaps.has(child) && queue.length + seenSitemaps.size < MAX_SITEMAPS * 2) {
          queue.push(child);
        }
      }
      continue;
    }

    for (const loc of locs) {
      if (urlSet.size >= MAX_URLS) break;
      let u: URL;
      try {
        u = new URL(loc);
      } catch {
        continue;
      }
      if (!sameSite(seed, u)) continue;
      // Drop non-English locales; strip en / en-us / … so they collapse with bare paths.
      const localeOk = localeNormalizeForMap(u.toString());
      if (!localeOk) continue;
      const normalized = normalizeCrawlUrl(localeOk);
      if (normalized) urlSet.add(normalized);
    }
  }

  return {
    hasMap: urlSet.size > 0,
    urls: urlSet,
    sources: [...sources].slice(0, 20),
  };
}

/** Merge per-seed maps (legacy multi-seed runs). */
export async function loadSiteMapIndex(seeds: string[]): Promise<SiteMapIndex> {
  const urls = new Set<string>();
  const sources: string[] = [];
  for (const seed of seeds) {
    const part = await loadSiteMapForSeed(seed);
    for (const u of part.urls) urls.add(u);
    for (const s of part.sources) {
      if (!sources.includes(s)) sources.push(s);
    }
  }
  return {
    hasMap: urls.size > 0,
    urls,
    sources: sources.slice(0, 40),
  };
}

export type EnqueueDedupOpts = {
  /** Redirect alias table — compare on resolved dedup keys. */
  aliases?: AliasTable;
  /** Mutated: enqueueAttempts / enqueueSuppressedLocal. */
  counters?: { enqueueAttempts: number; enqueueSuppressedLocal: number };
};

function compareKey(url: string, aliases?: AliasTable): string {
  const k = crawlDedupKey(url) ?? url;
  return aliases ? aliases.resolve(k) : k;
}

/**
 * Filter candidate same-site URLs for enqueue.
 * Sitemap present → only map members. No sitemap → all candidates (normalized).
 * Local `seen` compares on crawlDedupKey (alias-resolved); pushed URL stays normalizeCrawlUrl.
 */
export function filterEnqueueUrls(
  candidates: string[],
  map: SiteMapIndex,
  opts?: EnqueueDedupOpts,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (opts?.counters) opts.counters.enqueueAttempts += 1;
    const localeOk = localeNormalizeForMap(c);
    if (!localeOk) continue;
    const n = normalizeCrawlUrl(localeOk);
    if (!n) continue;
    const ck = compareKey(n, opts?.aliases);
    if (seen.has(ck)) {
      if (opts?.counters) opts.counters.enqueueSuppressedLocal += 1;
      continue;
    }
    if (map.hasMap && !map.urls.has(n)) continue;
    seen.add(ck);
    out.push(n);
  }
  return out;
}

/** Start URLs: seeds always, plus full sitemap when it is the map. */
export function initialCrawlUrls(
  seeds: string[],
  map: SiteMapIndex,
  opts?: EnqueueDedupOpts,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of seeds) {
    if (opts?.counters) opts.counters.enqueueAttempts += 1;
    // Prefer stripped English form so seed matches map keys; keep non-English seeds as-is.
    const localeOk = localeNormalizeForMap(s) ?? s;
    const n = normalizeCrawlUrl(localeOk) ?? localeOk;
    const ck = compareKey(n, opts?.aliases);
    if (seen.has(ck)) {
      if (opts?.counters) opts.counters.enqueueSuppressedLocal += 1;
      continue;
    }
    seen.add(ck);
    out.push(n);
  }
  if (map.hasMap) {
    for (const u of map.urls) {
      if (opts?.counters) opts.counters.enqueueAttempts += 1;
      const ck = compareKey(u, opts?.aliases);
      if (seen.has(ck)) {
        if (opts?.counters) opts.counters.enqueueSuppressedLocal += 1;
        continue;
      }
      seen.add(ck);
      out.push(u);
      if (out.length >= MAX_URLS + seeds.length) break;
    }
  }
  return out;
}
