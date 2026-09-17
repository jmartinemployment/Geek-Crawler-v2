/**
 * Per-crawl-type scope policy.
 *
 * Each crawl type carries its own configuration. That is design intent, not an optimisation: the
 * types answer different questions, so they cannot share a budget.
 *
 *   partner       evidence to cite — capabilities, pricing, integrations, limits, ICP.
 *                 Mandatory on every create. The one type that genuinely needs depth.
 *   competitors   the angle — gaps, positioning, honest comparison. A thin slice, never required.
 *                 You want their services / about / pricing, not their blog archive.
 *   local         geography — local SEO pages. Few by nature.
 *   project-site  grounding — heading hierarchy, brand voice, placement, anti-duplication.
 *                 The whole of your own site.
 *
 * Scope only. What is kept per page is a separate concern, decided downstream.
 */

import { CrawlTypes, type CrawlType } from './types.js';
import { MAX_PAGES_PER_SITE, clampToSiteCap } from './crawl-limits.js';
import { resolveSectionQuotas } from './section-quota.js';

export type CrawlProfile = {
  /** Page budget when the caller supplies none. Always clamped to MAX_PAGES_PER_SITE. */
  defaultMaxPages: number;
  /** Maximum link depth from a seed. `null` means unlimited. */
  maxDepth: number | null;
  /** Apply the section quota table. `false` leaves every directory uncapped. */
  useSectionQuotas: boolean;
};

/**
 * Keyed by crawl type with no fallback branch, so adding a type is a compile error rather than a
 * silent inheritance of someone else's configuration. The previous version collapsed partner,
 * competitors and local into one THIRD_PARTY profile behind a ternary, which is how competitors
 * ended up budgeted like a partner despite being a thin slice.
 */
const PROFILES: Record<CrawlType, CrawlProfile> = {
  // Evidence has to be thorough enough to cite. Quotas still apply — a partner's template farm is
  // not evidence.
  [CrawlTypes.Partner]: {
    defaultMaxPages: MAX_PAGES_PER_SITE,
    maxDepth: null,
    useSectionQuotas: true,
  },

  // PROPOSED, pending operator confirmation. A rival consultancy's positioning lives on a handful
  // of pages — services, about, pricing. 2500 was the old number and it treated a thin slice like a
  // partner corpus.
  [CrawlTypes.Competitors]: {
    defaultMaxPages: 150,
    maxDepth: 2,
    useSectionQuotas: true,
  },

  // PROPOSED, pending operator confirmation. Geographic pages are few by nature.
  [CrawlTypes.Local]: {
    defaultMaxPages: 100,
    maxDepth: 2,
    useSectionQuotas: true,
  },

  // Quotas OFF. They exist to stop a third party's page farm eating the budget; on your own site
  // every directory is content you chose to publish, and quotas would starve the directories the
  // heading hierarchy is built from. Depth is capped because structure lives near the surface.
  [CrawlTypes.ProjectSite]: {
    defaultMaxPages: MAX_PAGES_PER_SITE,
    maxDepth: 3,
    useSectionQuotas: false,
  },
};

export function crawlProfileFor(crawlType: CrawlType): CrawlProfile {
  const profile = PROFILES[crawlType];
  if (!profile) {
    throw new Error(`No crawl profile for crawlType "${crawlType}" — add one before crawling.`);
  }
  return { ...profile, defaultMaxPages: clampToSiteCap(profile.defaultMaxPages) };
}

/**
 * Quota map for a crawl type, with SECTION_PAGE_QUOTA env overrides still applied. Returns null
 * when the profile disables quotas.
 */
export function sectionQuotasFor(crawlType: CrawlType): Map<string, number> | null {
  return crawlProfileFor(crawlType).useSectionQuotas ? resolveSectionQuotas() : null;
}
