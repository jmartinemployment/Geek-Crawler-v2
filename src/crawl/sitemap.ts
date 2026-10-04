import { hostnameKey } from './links.js';
import { localeNormalizeForMap } from './locale-path.js';
import { BOT } from '../bot/identity.js';
import { TIER_ORDER, classifyPath } from './classify-path.js';
import { crawlDedupKey, type AliasTable } from './dedup.js';
import type { SectionQuota } from './section-quota.js';
import type { DiscoveryLedger } from './discovery-ledger.js';
import { trapRuleFor, type DirectoryCap } from './link-trap.js';

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
   * True when a usable sitemap was found. The sitemap seeds the crawl in tier order; it does not
   * bound discovery. A same-origin link it omits is admitted under the trap rules and quotas like
   * any other (see filterEnqueueUrls).
   */
  hasMap: boolean;
  urls: Set<string>;
  sources: string[];
  /** The loader stopped at MAX_URLS or MAX_SITEMAPS, so the map is incomplete. */
  truncated: boolean;
  /** sitemapMemberKey of every url, so membership survives trailing-slash, case and www variants. */
  memberKeys: Set<string>;
};

/**
 * Membership key: lowercase host without www., no trailing slash on a non-root path, query kept.
 *
 * Exact string membership read /pricing/ as off-sitemap when the map listed /pricing. That cost
 * nothing while the map was an allowlist -- the variant was dropped -- but it now decides whether a
 * link is subject to the trap rules and whether it is reported as off-sitemap.
 */
export function sitemapMemberKey(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  let host = u.hostname.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  let pathname = u.pathname;
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  return `${u.protocol}//${host}${u.port ? `:${u.port}` : ''}${pathname}${u.search}`;
}

export function siteMapIndex(
  urls: Iterable<string>,
  sources: string[],
  truncated: boolean,
): SiteMapIndex {
  const set = new Set(urls);
  const memberKeys = new Set<string>();
  for (const u of set) memberKeys.add(sitemapMemberKey(u));
  return { hasMap: set.size > 0, urls: set, sources, truncated, memberKeys };
}

export function inSiteMap(map: SiteMapIndex, url: string): boolean {
  return map.hasMap && map.memberKeys.has(sitemapMemberKey(url));
}

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
    return siteMapIndex([], [], false);
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
  // Set whenever a ceiling stops the load with work left, so an incomplete map says so.
  let truncated = false;

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
        if (seenSitemaps.has(child)) continue;
        if (queue.length + seenSitemaps.size < MAX_SITEMAPS * 2) {
          queue.push(child);
        } else {
          truncated = true;
        }
      }
      continue;
    }

    for (const loc of locs) {
      if (urlSet.size >= MAX_URLS) {
        truncated = true;
        break;
      }
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
  if (queue.some((q) => !seenSitemaps.has(q))) truncated = true;

  return siteMapIndex(urlSet, [...sources].slice(0, 20), truncated);
}

/** Merge per-seed maps (legacy multi-seed runs). */
export async function loadSiteMapIndex(seeds: string[]): Promise<SiteMapIndex> {
  const urls = new Set<string>();
  const sources: string[] = [];
  let truncated = false;
  for (const seed of seeds) {
    const part = await loadSiteMapForSeed(seed);
    for (const u of part.urls) urls.add(u);
    for (const s of part.sources) {
      if (!sources.includes(s)) sources.push(s);
    }
    truncated ||= part.truncated;
  }
  return siteMapIndex(urls, sources.slice(0, 40), truncated);
}

export type EnqueueDedupOpts = {
  /** Redirect alias table — compare on resolved dedup keys. */
  aliases?: AliasTable;
  /** Mutated: enqueueAttempts / enqueueSuppressedLocal. Per offer, not per URL. */
  counters?: {
    enqueueAttempts: number;
    enqueueSuppressedLocal: number;
  };
  /** Per-directory page caps; shared by both enqueue planes. */
  quota?: SectionQuota;
  /** Run-wide cap on admitted off-sitemap other-tier pages per directory. */
  directoryCap?: DirectoryCap;
  /** Records what became of every discovered URL, once per URL. */
  ledger?: DiscoveryLedger;
};

/** A URL cleared for enqueue. forefront puts it ahead of the queued sitemap. */
export type EnqueueCandidate = {
  url: string;
  forefront: boolean;
};

/** Shallowest path first, then lexicographic — deterministic across runs. */
export function sectionAdmissionOrder(urls: string[]): string[] {
  const depth = (u: string): number => {
    try {
      return new URL(u).pathname.split('/').filter(Boolean).length;
    } catch {
      return Number.MAX_SAFE_INTEGER;
    }
  };
  // Tier first. Depth-then-alphabetical alone is why the corpus came out 72% editorial: a blog post
  // at /blog/slug is depth 2 and a product page at /solutions/category/product is depth 3, so every
  // blog post was admitted before any nested product page, and at equal depth /blog/ beat /pricing/
  // on the alphabet. Depth and name still break ties inside a tier, so ordering stays deterministic.
  return [...urls].sort((a, b) => {
    const t = TIER_ORDER[classifyPath(a)] - TIER_ORDER[classifyPath(b)];
    if (t !== 0) return t;
    const d = depth(a) - depth(b);
    return d !== 0 ? d : a.localeCompare(b);
  });
}

function compareKey(url: string, aliases?: AliasTable): string {
  const k = crawlDedupKey(url) ?? url;
  return aliases ? aliases.resolve(k) : k;
}

/**
 * Filter candidate same-site links for enqueue.
 *
 * Every link is a candidate, sitemap or not. Until 2026-10-04 a sitemap made itself an allowlist:
 * a link it did not list was dropped without a count, which is how ramp.com's /products, bill.com's
 * /pricing and lightyear.cloud's /features/* never entered the corpus. The sitemap now seeds the
 * crawl (initialCrawlUrls) and nothing more.
 *
 * A link the sitemap does not list -- every link, when there is no sitemap -- passes three further
 * gates first, because the allowlist was also the only link-trap defence: depth, the trap rules,
 * and the per-directory cap for other-tier pages. See link-trap.ts. Then the section quota, which
 * every URL passes through.
 *
 * Off-sitemap product and evidence links go to the front of the queue. Appended, they would wait
 * behind every queued sitemap URL including the editorial ones, which inverts the tier order the
 * sitemap is seeded in.
 *
 * Local `seen` compares on crawlDedupKey (alias-resolved); pushed URL stays normalizeCrawlUrl.
 */
export function filterEnqueueUrls(
  candidates: string[],
  map: SiteMapIndex,
  opts?: EnqueueDedupOpts,
  page?: { depthExceeded: boolean },
): EnqueueCandidate[] {
  const out: EnqueueCandidate[] = [];
  const seen = new Set<string>();
  const ledger = opts?.ledger;
  for (const c of candidates) {
    if (opts?.counters) opts.counters.enqueueAttempts += 1;
    const localeOk = localeNormalizeForMap(c);
    if (!localeOk) {
      ledger?.refuse(c, c, 'locale', map.hasMap);
      continue;
    }
    const n = normalizeCrawlUrl(localeOk);
    if (!n) {
      ledger?.refuse(c, c, 'invalid', map.hasMap);
      continue;
    }
    const ck = compareKey(n, opts?.aliases);
    if (seen.has(ck)) {
      if (opts?.counters) opts.counters.enqueueSuppressedLocal += 1;
      continue;
    }
    seen.add(ck);
    // Already queued, from the sitemap or an earlier page. Crawlee would drop it on uniqueKey;
    // stopping here keeps it out of the gates, which would otherwise re-decide a settled URL.
    if (ledger?.stateOf(ck) === 'enqueued') continue;

    const discovered = !inSiteMap(map, n);
    const offSitemap = map.hasMap && discovered;
    const tier = classifyPath(n);

    if (discovered) {
      if (page?.depthExceeded) {
        ledger?.refuse(ck, n, 'depth', offSitemap);
        continue;
      }
      const trap = trapRuleFor(n);
      if (trap) {
        ledger?.refuse(ck, n, trap, offSitemap);
        continue;
      }
      // Checked before the quota and committed after it. The quota counts every admission toward
      // the editorial allowance, so a page the directory cap then refused would still have raised
      // it; and a page the quota refused must not hold a directory slot.
      if (tier === 'other' && opts?.directoryCap && !opts.directoryCap.hasRoom(n)) {
        ledger?.refuse(ck, n, 'directoryCap', offSitemap);
        continue;
      }
    }

    if (opts?.quota) {
      const decision = opts.quota.decide(n);
      if (!decision.admitted) {
        ledger?.refuse(ck, n, decision.refusal, offSitemap);
        continue;
      }
    }
    if (discovered && tier === 'other') opts?.directoryCap?.commit(n);

    ledger?.enqueue(ck, n, 'link', offSitemap);
    out.push({ url: n, forefront: discovered && (tier === 'product' || tier === 'evidence') });
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
  const ledger = opts?.ledger;
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
    ledger?.enqueue(ck, n, 'seed', false);
    out.push(n);
  }
  if (map.hasMap) {
    for (const u of sectionAdmissionOrder([...map.urls])) {
      if (opts?.counters) opts.counters.enqueueAttempts += 1;
      const ck = compareKey(u, opts?.aliases);
      if (seen.has(ck)) {
        if (opts?.counters) opts.counters.enqueueSuppressedLocal += 1;
        continue;
      }
      if (opts?.quota) {
        const decision = opts.quota.decide(u);
        if (!decision.admitted) {
          ledger?.refuse(ck, u, decision.refusal, false);
          continue;
        }
      }
      seen.add(ck);
      ledger?.enqueue(ck, u, 'sitemap', false);
      out.push(u);
    }
  }
  return out;
}

/**
 * Merge a browser link-discovery pass into the start URLs, in tier order.
 *
 * The pass runs only when there is no sitemap, and its links stand in for one, so they get what
 * sitemap URLs get: the locale filter, then the section quota and editorial share, decided in tier
 * order so product pages raise the editorial allowance before any editorial page asks for it. Not
 * the trap rules: a link in the rendered navigation is a page the site chose to show, the same
 * standing as a sitemap entry.
 *
 * Until 2026-10-04 harvested URLs went into the start list ungated. The pass exists for sites like
 * lightyear.cloud, whose 148-page crawl came back 129 blog posts, and the share gate built for that
 * case never saw the URLs this pass contributed.
 */
export function mergeHarvestedUrls(
  startUrls: string[],
  harvested: string[],
  opts?: EnqueueDedupOpts,
): string[] {
  const ledger = opts?.ledger;
  const merged = new Set(startUrls);
  const seen = new Set(startUrls.map((u) => compareKey(u, opts?.aliases)));
  const fresh: string[] = [];
  for (const u of harvested) {
    const localeOk = localeNormalizeForMap(u);
    if (!localeOk) {
      ledger?.refuse(u, u, 'locale', false);
      continue;
    }
    const n = normalizeCrawlUrl(localeOk);
    if (!n) {
      ledger?.refuse(u, u, 'invalid', false);
      continue;
    }
    const ck = compareKey(n, opts?.aliases);
    if (seen.has(ck)) continue;
    seen.add(ck);
    fresh.push(n);
  }
  for (const n of sectionAdmissionOrder(fresh)) {
    const ck = compareKey(n, opts?.aliases);
    if (opts?.quota) {
      const decision = opts.quota.decide(n);
      if (!decision.admitted) {
        ledger?.refuse(ck, n, decision.refusal, false);
        continue;
      }
    }
    ledger?.enqueue(ck, n, 'harvest', false);
    merged.add(n);
  }
  return sectionAdmissionOrder([...merged]);
}
