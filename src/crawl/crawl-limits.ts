/**
 * Crawl-scope limits. One crawl targets exactly one seed site, so the
 * per-crawl request budget is the per-site page cap.
 */

/** Hard ceiling on pages fetched per site URL, regardless of sitemap size. */
export const MAX_PAGES_PER_SITE = 2500;

/**
 * Clamp a requested budget to the per-site cap. `undefined` means "no
 * requested budget", which still resolves to the cap.
 */
export function clampToSiteCap(requested: number | undefined): number {
  if (requested == null || !Number.isFinite(requested)) return MAX_PAGES_PER_SITE;
  return Math.max(1, Math.min(MAX_PAGES_PER_SITE, Math.floor(requested)));
}
