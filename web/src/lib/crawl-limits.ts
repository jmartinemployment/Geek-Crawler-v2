/**
 * Mirror of the crawler's per-site page cap (`src/crawl/crawl-limits.ts`).
 * The operator UI measures completion against what the crawler will actually
 * fetch, not against the raw sitemap size.
 */

export const MAX_PAGES_PER_SITE = 2500;

/** Expected page total for a site, capped the way the crawler caps it. */
export function expectedPageTotal(sitemapTotal: number): number {
  if (!Number.isFinite(sitemapTotal) || sitemapTotal <= 0) return 0;
  return Math.min(MAX_PAGES_PER_SITE, Math.floor(sitemapTotal));
}
