import { chromium, type Browser } from 'playwright';
import { MOBILE_USER_AGENT } from '../bot/identity.js';

/**
 * Discover a site's links with a browser, once, when static HTML does not contain them.
 *
 * This repo is CheerioCrawler only and stays that way: the browser is used to FIND urls, never to
 * fetch the pages. That distinction is the whole design. Measured on lightyear.cloud 2026-09-30,
 * Cheerio fetched /en-us/pricing/ perfectly well — 200, full HTML — it simply never learned the url
 * existed, because the site's nav is rendered by JavaScript and its sitemap.xml returns 500. The
 * homepage's entire static link set was six urls, one stylesheet and one favicon among them, while
 * the words "pricing", "features" and "industries" appeared 8, 16 and 20 times in the HTML and zero
 * times inside an href.
 *
 * So one page load, one browser, one crawl. Everything after this is Cheerio at Cheerio's speed,
 * and a site that exposes its links statically — bill.com with 127 /product/ links, medius.com with
 * 113 /solutions/ — never launches a browser at all.
 */

/** Same-origin links a static fetch must yield before a browser is considered unnecessary. */
export const STATIC_LINK_FLOOR = 25;

export type HarvestOutcome =
  | { ok: true; urls: string[]; launched: boolean }
  | { ok: false; reason: string };

/**
 * Whether a browser pass is warranted.
 *
 * A sitemap makes it unnecessary regardless of the static link count: the map already is the url
 * list, which is why bill.com and medius.com never reach this path.
 */
export function needsBrowserDiscovery(opts: {
  hasSiteMap: boolean;
  staticSameOriginLinks: number;
}): boolean {
  if (opts.hasSiteMap) return false;
  return opts.staticSameOriginLinks < STATIC_LINK_FLOOR;
}

/**
 * Same-origin hrefs from the rendered DOM of one page.
 *
 * One attempt. No retry, no second navigation, no waiting loop beyond the single load — plans/rules
 * §3a, and a browser that cannot start is a real failure the caller must see rather than a reason to
 * proceed with six urls and call it a crawl.
 */
export async function harvestLinks(
  seedUrl: string,
  opts: { timeoutMs?: number; maxUrls?: number } = {},
): Promise<HarvestOutcome> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxUrls = opts.maxUrls ?? 2_000;

  let origin: string;
  try {
    origin = new URL(seedUrl).origin;
  } catch {
    return { ok: false, reason: `seed is not a url: ${seedUrl}` };
  }

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent: MOBILE_USER_AGENT });
    const page = await context.newPage();

    // domcontentloaded, not networkidle: the nav markup is in the DOM well before analytics and
    // chat widgets settle, and networkidle on a marketing site can hang until the timeout.
    await page.goto(seedUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    const hrefs: string[] = await page.$$eval('a[href]', (nodes) =>
      nodes.map((n) => (n as HTMLAnchorElement).href).filter(Boolean),
    );

    const seen = new Set<string>();
    for (const h of hrefs) {
      if (seen.size >= maxUrls) break;
      try {
        const u = new URL(h);
        if (u.origin !== origin) continue;
        if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
        u.hash = '';
        seen.add(u.toString());
      } catch {
        // An unparseable href is not a url. Skipping it is not a fallback; there is nothing to fetch.
      }
    }

    return { ok: true, urls: [...seen], launched: true };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await browser?.close().catch(() => {
      // Close failure cannot change the result and must not mask it.
    });
  }
}
