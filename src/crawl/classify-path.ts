/**
 * What kind of page a URL is, decided from its whole path.
 *
 * One function, two consumers: `sectionAdmissionOrder` sorts by it and `createSectionQuota` budgets
 * by it. The section vocabulary it reads is the one the quotas read too (section-vocabulary.ts):
 * two lists of "what is this directory" drifted, and the crawler ordered pages by one and capped
 * them by the other.
 *
 * Why the whole path and not the first segment. Until 2026-09-30 both ordering and quotas keyed on
 * segment one, which is too coarse in both directions:
 *
 *   dext.com/business/pricing                      product, under a generic segment
 *   quickbooks.intuit.com/accounting/…-guide/      editorial, under a product segment
 *
 * The first is invisible to a first-segment product list; the second is counted as product by one.
 * A 100-page guide cluster under /accounting/ exhausts the budget before a second product page is
 * reached, which is how a corpus ends up 72% editorial while every rule appears to be working.
 *
 * Boundaries are anchored to path segments. Substring matching is what makes this dangerous in B2B
 * software, where `resource` appears in "Enterprise Resource Planning" — `/solutions/erp-resource-planning`
 * must stay PRODUCT while `/resources/` is EDITORIAL.
 */

import { segmentTier } from './section-vocabulary.js';

export type PageTier = 'product' | 'evidence' | 'other' | 'editorial';

/** Sort weight. Lower is crawled first. */
export const TIER_ORDER: Readonly<Record<PageTier, number>> = {
  product: 0,
  evidence: 1,
  other: 2,
  editorial: 3,
};

/**
 * Editorial no matter where it sits.
 *
 * Checked before anything else, so a guide nested under a product directory is still a guide. Kept
 * deliberately narrow: `-guide` is not on this list because `/integrations/setup-guide` is product
 * documentation and is evidence worth citing. `how-to` and `tutorial` carry no such ambiguity.
 */
const STRONG_EDITORIAL_TOKENS: readonly RegExp[] = [
  /(?:^|\/|-)how-to(?:-|\/|$)/,
  /(?:^|\/|-)tutorials?(?:-|\/|$)/,
  /(?:^|\/|-)explained(?:-|\/|$)/,
  /(?:^|\/|-)best-practices(?:-|\/|$)/,
  /(?:^|\/|-)what-is-/,
];

/**
 * Weak signals: editorial only when no path segment has already classified the page.
 *
 * `-guide` is the case that forces the distinction. `/accounting/accounts-receivable-guide` is an
 * SEO article under a topic folder; `/integrations/setup-guide` is product documentation and is
 * evidence worth citing. The parent decides, so this is consulted last.
 */
const WEAK_EDITORIAL_TOKENS: readonly RegExp[] = [
  /-guide(?:s)?(?:\/|$)/,
  /-checklist(?:s)?(?:\/|$)/,
  /-template(?:s)?(?:\/|$)/,
];

/** Path segments, lowercased, empties dropped. Accepts a full URL or a bare path. */
function segmentsOf(urlOrPath: string): string[] {
  let pathname = urlOrPath;
  try {
    pathname = new URL(urlOrPath).pathname;
  } catch {
    // Already a path, or unparseable. Either way, split what we were given.
  }
  return pathname.toLowerCase().split('/').filter(Boolean);
}

/**
 * Tier for one URL. Pure, and total — every URL lands somewhere.
 *
 * Precedence, and each step exists because a real URL needed it:
 *
 *   1. Strong tokens        /solutions/how-to-automate-invoices  -> editorial
 *      An unambiguous article beats its parent folder. This is the trap that matters: marketing
 *      nests SEO clusters under product directories, and a 100-page cluster exhausts the crawl
 *      budget before a second product page is reached.
 *
 *   2. Leftmost segment     /solutions/category/product-0        -> product
 *                           /blog/category/accounting            -> editorial
 *      The section a page lives in is the leftmost one that classifies. Scanning for "any editorial
 *      segment anywhere" made `category` mean archive even under /solutions/.
 *
 *   3. Weak tokens          /accounting/accounts-receivable-guide -> editorial
 *                           /integrations/setup-guide             -> product (step 2 already fired)
 *      Consulted only when nothing else classified, because `-guide` means different things under
 *      a topic folder and under a product folder.
 */
export function classifyPath(urlOrPath: string): PageTier {
  const segments = segmentsOf(urlOrPath);
  if (segments.length === 0) return 'other'; // homepage

  const joined = `/${segments.join('/')}`;
  if (STRONG_EDITORIAL_TOKENS.some((re) => re.test(joined))) return 'editorial';

  // The section vocabulary is shared with the quotas; see section-vocabulary.ts. Evidence is checked
  // before editorial within a segment, but still inside the leftmost scan, so it does not override
  // an outer section: plooto.com/resources/case-studies stays editorial because `resources`
  // classifies first. That consequence is accepted, not overlooked.
  const tier = segmentTier(segments);
  if (tier) return tier;

  if (WEAK_EDITORIAL_TOKENS.some((re) => re.test(joined))) return 'editorial';
  return 'other';
}
