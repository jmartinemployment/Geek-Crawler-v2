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
/**
 * One profile for every third-party crawl.
 *
 * Jeff, 2026-09-30: partner, competitors and local are the same crawl. A competitor is a partner you
 * are not affiliated with, so it gets a partner's treatment -- no thin slices, no per-type budgets.
 * The previous competitors: 150 and local: 100 were marked "PROPOSED, pending operator
 * confirmation" and never confirmed; this is the confirmation, in the other direction.
 *
 * Composition is now controlled by EDITORIAL_SHARE in section-quota.ts, not by shrinking the page
 * budget. Capping pages was never the right lever: it made competitor crawls smaller without making
 * them better, while the 72%-editorial problem was untouched.
 */
const THIRD_PARTY: CrawlProfile = {
  defaultMaxPages: MAX_PAGES_PER_SITE,
  // Unlimited, still. Opening discovery past the sitemap (2026-10-04) made a depth cap the obvious
  // trap backstop, but a cap is what 03a53ce removed: link hops from the seed dropped nested product
  // pages three hops behind a nav. The trap rules in link-trap.ts and the page budget bound a trap
  // instead. Depth now only governs links the sitemap omits, and each URL it refuses is counted
  // under `depth` in the discovery report, so setting a cap here is measurable.
  maxDepth: null,
  useSectionQuotas: true,
};

/**
 * Keyed by crawl type with no fallback branch, so adding a type is a compile error rather than a
 * silent inheritance of someone else's configuration.
 *
 * The three third-party types share a VALUE, not the structure. An earlier version collapsed them
 * behind a ternary and that is how competitors ended up budgeted like a partner by accident; here it
 * is the intended outcome, written once and assigned by explicit key, so a future divergence is a
 * deliberate edit rather than a side effect.
 */
const PROFILES: Record<CrawlType, CrawlProfile> = {
  [CrawlTypes.Partner]: THIRD_PARTY,
  [CrawlTypes.Competitors]: THIRD_PARTY,
  [CrawlTypes.Local]: THIRD_PARTY,

  // Quotas OFF. They exist to stop a third party's page farm eating the budget; on your own site
  // every directory is content you chose to publish, and quotas would starve the directories the
  // heading hierarchy is built from. Depth unlimited: maxDepth counts link hops from the seed, not
  // path segments, so a cap silently drops whichever pages sit furthest from the front door.
  //
  // Unchanged by the 2026-09-30 composition work, deliberately. geekatyourspot.com is 83% editorial
  // for this reason, and whether your own site should be filtered is a separate question.
  [CrawlTypes.ProjectSite]: {
    defaultMaxPages: MAX_PAGES_PER_SITE,
    maxDepth: null,
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
