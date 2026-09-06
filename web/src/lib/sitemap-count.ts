/**
 * Fetch and count same-site URLs from robots.txt Sitemap: entries and /sitemap.xml.
 * Report-only. Crawl policy lives in src/crawl/sitemap.ts (sitemap is the map).
 */

const MAX_SITEMAPS = 40;
const MAX_URLS = 50_000;
const FETCH_MS = 20_000;

export type SitemapCountResult = {
  /** Unique absolute URLs as listed (includes query strings). */
  sitemapUrlCount: number;
  /** Unique origin+pathname only (strips ?query) — useful vs Zapier-style dupes. */
  sitemapPathCount: number;
  sitemapSources: string[];
  error?: string;
};

function hostnameKey(hostname: string): string {
  const h = hostname.trim().toLowerCase();
  return h.startsWith("www.") ? h.slice(4) : h;
}

function sameSite(seedOrigin: URL, candidate: URL): boolean {
  if (seedOrigin.protocol !== candidate.protocol) return false;
  return hostnameKey(seedOrigin.hostname) === hostnameKey(candidate.hostname);
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_MS),
      headers: {
        Accept: "application/xml,text/xml,text/plain,*/*",
        "User-Agent": "geekatyourspotbot/1.0 (+https://geekatyourspot.com)",
      },
      redirect: "follow",
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
 * Count crawlable URLs advertised by the site's sitemap(s) for this seed.
 */
export async function countSitemapPages(seedUrl: string): Promise<SitemapCountResult> {
  let seed: URL;
  try {
    seed = new URL(seedUrl);
  } catch {
    return {
      sitemapUrlCount: 0,
      sitemapPathCount: 0,
      sitemapSources: [],
      error: "invalid seed URL",
    };
  }

  const origin = seed.origin;
  const sources = new Set<string>();
  const queue: string[] = [];

  for (const s of await sitemapUrlsFromRobots(origin)) {
    queue.push(s);
    sources.add(s);
  }
  const fallback = `${origin}/sitemap.xml`;
  if (![...sources].some((s) => s.replace(/\/$/, "") === fallback.replace(/\/$/, ""))) {
    queue.push(fallback);
  }

  const urlSet = new Set<string>();
  const pathSet = new Set<string>();
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
      u.hash = "";
      const full = u.toString();
      urlSet.add(full);
      const pathOnly = `${u.origin}${u.pathname}`;
      pathSet.add(pathOnly.endsWith("/") && u.pathname !== "/" ? pathOnly.slice(0, -1) : pathOnly);
    }
  }

  return {
    sitemapUrlCount: urlSet.size,
    sitemapPathCount: pathSet.size,
    sitemapSources: [...sources].slice(0, 20),
    error:
      urlSet.size === 0 && sitemapsFetched === 0
        ? "no sitemap found"
        : undefined,
  };
}
