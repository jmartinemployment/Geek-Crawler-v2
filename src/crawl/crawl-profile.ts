/**
 * Per-crawl-type scope policy.
 *
 * Until now crawl type was a pure label — nothing branched on it, so every crawl ran the same
 * budget and the same section quotas. That is wrong for the operator's own site, where the crawl
 * exists to build a heading hierarchy rather than to gather quotable prose.
 *
 * Scope and retention are separate concerns. This file is scope only: how much to fetch and from
 * where. What is kept per page is decided downstream.
 */

import { CrawlTypes, type CrawlType } from './types.js';
import { MAX_PAGES_PER_SITE } from './crawl-limits.js';
import { DEFAULT_SECTION_QUOTAS, resolveSectionQuotas } from './section-quota.js';

export type CrawlProfile = {
  /** Page budget when the caller supplies none. Always clamped to MAX_PAGES_PER_SITE. */
  defaultMaxPages: number;
  /** Maximum link depth from a seed. `null` means unlimited (the historical behaviour). */
  maxDepth: number | null;
  /**
   * Section quotas to apply. `null` disables them entirely — every directory uncapped.
   */
  sectionQuotas: ReadonlyMap<string, number> | null;
};

/**
 * The operator's own site.
 *
 * Section quotas are OFF. They exist to stop someone else's programmatic page farm eating the
 * budget; on your own site every directory is content you chose to publish. Leaving them on would
 * starve exactly the directories the grounding depends on — GccV2SiteHierarchyFromCrawl ranks
 * /tools second only to the homepage, and the anchors under those headings are where partner links
 * come from.
 *
 * Depth is capped because a site's heading structure lives near the surface; deep pagination adds
 * pages without adding hierarchy.
 */
const PROJECT_SITE: CrawlProfile = {
  defaultMaxPages: MAX_PAGES_PER_SITE,
  maxDepth: 3,
  sectionQuotas: null,
};

/** Third-party sites: quotas on, no depth limit, sitemap-bounded as before. */
const THIRD_PARTY: CrawlProfile = {
  defaultMaxPages: MAX_PAGES_PER_SITE,
  maxDepth: null,
  sectionQuotas: DEFAULT_SECTION_QUOTAS,
};

export function crawlProfileFor(crawlType: CrawlType): CrawlProfile {
  return crawlType === CrawlTypes.ProjectSite ? PROJECT_SITE : THIRD_PARTY;
}

/**
 * Quota map for a crawl type, with SECTION_PAGE_QUOTA env overrides still applied for the types
 * that use quotas. Returns null when the profile disables them.
 */
export function sectionQuotasFor(crawlType: CrawlType): Map<string, number> | null {
  return crawlProfileFor(crawlType).sectionQuotas === null ? null : resolveSectionQuotas();
}
