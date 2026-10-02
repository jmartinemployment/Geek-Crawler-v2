/**
 * What kind of page a URL is, decided from its whole path.
 *
 * One function, two consumers: `sectionAdmissionOrder` sorts by it and `createSectionQuota` budgets
 * by it. Two implementations of "is this editorial" would eventually disagree, and then the crawler
 * would order pages by one rule and cap them by another.
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

/**
 * Editorial sections, matched as whole path segments anywhere in the path.
 *
 * This is the existing DEFAULT_SECTION_QUOTAS vocabulary, not a shorter replacement for it. The
 * failure being fixed is the MATCHING, not the list: exact-string keys missed `case-study` next to
 * `case-studies`, `company-blog` next to `blog`, and had no entry at all for `learning` (510 pages)
 * or `press-releases` (254). Compounds and singular/plural are handled by the patterns below.
 */
const EDITORIAL_SEGMENTS: readonly RegExp[] = [
  /^(?:[a-z0-9]+-)?blogs?$/,                       // blog, blogs, company-blog, security-blog
  /^(?:[a-z0-9]+-)?news$/,                         // news, company-news
  /^press(?:-releases?|-room|-centre?|-center)?$/, // press, press-release, press-releases
  /^(?:case-stud(?:y|ies))$/,
  /^(?:[a-z0-9]+-)?stor(?:y|ies)$/,                // stories, customer-stories, success-stories
  /^customers$/,
  /^(?:[a-z0-9]+-)?resources?$/,                   // resources, general-resources
  /^[a-z0-9-]*resource-cent(?:er|re)$/,            // accountant-resource-center
  /^(?:[a-z0-9]+-)?(?:hub|content-corner)$/,       // unmatched-vocabulary catch, per review
  /^learn(?:ing)?$/,
  /^academy$/,
  /^(?:glossary|definitions|dictionary|what-is)$/,
  /^insights?$/,
  /^articles?$/,
  /^guides?$/,
  /^ebooks?$/,
  /^(?:[a-z0-9]+-)?templates?$/,                   // templates, business-templates
  /^videos?$/,
  /^webinars?$/,
  /^podcasts?$/,
  /^events?$/,
  /^(?:community|forum|answers|questions)$/,
  /^(?:job-descriptions|roles|titles)$/,
  /^(?:free-tools|generators|calculators)$/,
  /^(?:knowledge|kb|help|support|faq)$/,
];

/**
 * Product sections, matched as whole path segments anywhere in the path.
 *
 * "Anywhere" is what finds `dext.com/business/pricing`. `alternatives` / `vs` / `compare` are
 * product here on purpose: a competitor comparison is exactly the evidence these crawls exist to
 * collect, and the old table capped them at 250 as if they were filler.
 */
const PRODUCT_SEGMENTS: readonly RegExp[] = [
  /^products?$/,
  /^solutions?$/,
  /^features?$/,
  /^pricing$/,
  /^plans?$/,
  /^platform$/,
  // integrations only. `apps`, `connectors`, `plugins` and `marketplace` stay OTHER: the original
  // quota table capped all four at 10 as catalogues, and promoting a browse-our-directory farm to
  // the front of the queue is the opposite of the point. "What we integrate with" is capability
  // evidence; "browse our app directory" is a page farm.
  /^integrations?$/,
  /^use-cases?$/,
  /^industries$/,
  /^(?:alternatives|vs|versus|compare|comparison)$/,
  /^capabilities$/,
  /^modules?$/,
];

/**
 * Directories whose pages ARE the evidence a tool page is grounded in.
 *
 * Separate from `editorial` for one reason, and it is not ordering: `admit()` rations editorial
 * against `EDITORIAL_SHARE`, so a case study competes with blog posts for a 20% budget and loses.
 * Measured 2026-10-02 by diffing crawl_links against crawl_pages — bill.com discovered 75 of these
 * and crawled 1, melio.com discovered 23 and crawled 1, 111 refused across five partners. Every one
 * classified `editorial`, checked by running this function over them rather than inferred.
 *
 * They are not editorial in any useful sense. `melio.com/case-studies/cubepros` is a named client
 * with a stated outcome, which is the `caseStudies` extraction category verbatim; `/faq` is
 * `faqBank`; customer pages carry `testimonials`. Three of the 22 categories a tool page is refused
 * for lacking live here.
 *
 * Deliberately NOT here: security, trust, changelog, demo, docs, limits, awards. They fill five more
 * categories but already tier `other`, so moving them would change crawl order only — and ordering
 * changes nothing while the 2,500-page cap goes unreached, which it has on all 47 runs to date.
 *
 * The leading-qualifier group mirrors `blog`'s, so dext's `smb-testimonials` is caught. Whole
 * segments only: `/blog/case-studies-in-ap-automation` is an article about case studies and stays
 * editorial.
 */
const EVIDENCE_SEGMENTS: readonly RegExp[] = [
  /^customers$/,
  /^(?:[a-z0-9]+-)?case-stud(?:y|ies)$/,       // case-study, case-studies, customer-case-studies
  /^(?:[a-z0-9]+-)?success-stor(?:y|ies)$/,
  /^(?:[a-z0-9]+-)?stories$/,                  // stories, customer-stories, success-stories
  /^(?:[a-z0-9]+-)?testimonials?$/,            // testimonials, smb-testimonials
  /^(?:faqs?|frequently-asked(?:-questions)?)$/,
];

/**
 * Archive and pagination views. Editorial only as the FIRST segment.
 *
 * `/category/accounting` is a blog archive; `/solutions/category/enterprise` is product taxonomy,
 * and treating the second as editorial buried exactly the pages this change exists to surface.
 * Position carries the meaning, so position is what is checked.
 */
const ARCHIVE_SEGMENTS: readonly RegExp[] = [
  /^(?:author|authors|tag|tags|category|categories|topics|archive|page)$/,
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

  for (const [i, seg] of segments.entries()) {
    if (PRODUCT_SEGMENTS.some((re) => re.test(seg))) return 'product';
    // Before EDITORIAL_SEGMENTS, because `stories` and `customers` appear in both vocabularies and
    // evidence is the more specific reading. Still inside the leftmost scan, so this does not
    // override an outer section: plooto.com/resources/case-studies stays editorial because
    // `resources` classifies first. That consequence is accepted, not overlooked.
    if (EVIDENCE_SEGMENTS.some((re) => re.test(seg))) return 'evidence';
    if (EDITORIAL_SEGMENTS.some((re) => re.test(seg))) return 'editorial';
    if (i === 0 && ARCHIVE_SEGMENTS.some((re) => re.test(seg))) return 'editorial';
  }

  if (WEAK_EDITORIAL_TOKENS.some((re) => re.test(joined))) return 'editorial';
  return 'other';
}
