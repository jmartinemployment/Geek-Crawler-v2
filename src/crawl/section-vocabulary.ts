/**
 * The section vocabulary: what a path segment names, and what kind of page lives under it.
 *
 * One table, read by both consumers. `classify-path.ts` takes the tier, `section-quota.ts` takes the
 * name. Until 2026-10-04 each kept its own list, and they drifted the way two lists always do:
 * `customer-case-studies` was evidence to the classifier and no section at all to the quotas, so
 * it was uncapped; `/page/` was an archive to the classifier and not to the quotas; `/calculator/`
 * was capped at 10 by the quotas and an ordinary page to the classifier. Each consumer was right by
 * its own table, and the crawler ordered pages by one rule and capped them by another.
 *
 * How each consumer reads an entry:
 *
 *   classifyPath  scans segments left to right and returns the tier of the first segment that a
 *                 product, evidence or editorial entry matches. Within one segment the more
 *                 specific tier wins: product, then evidence, then editorial. `other` entries never
 *                 classify -- `other` is what a page with no classifying segment already is -- so
 *                 they cannot stop the scan: /tools/blog/x is still editorial.
 *
 *   quotaKey      scans segments left to right and returns the name of the first entry that is not
 *                 product. Product sections are never capped; composition for product pages is the
 *                 tier order's job, not a cap's. So /solutions/blog/x is capped as `blog` even though
 *                 it classifies product.
 *
 * Entries may share a name. They then share one quota budget while keeping their own tier: `stories`
 * is evidence and `story` is editorial, and both draw on the `stories` cap.
 */

import type { PageTier } from './classify-path.js';

export type SectionEntry = {
  /** Section name: the key looked up in the quota map. */
  readonly name: string;
  /** Matched against one lowercased path segment, anchored. */
  readonly pattern: RegExp;
  readonly tier: PageTier;
  /**
   * Only match as the first path segment. `/category/accounting` is a blog archive;
   * `/solutions/category/enterprise` is product taxonomy. Position carries the meaning.
   */
  readonly firstSegmentOnly?: true;
};

export const SECTIONS: readonly SectionEntry[] = [
  // ---- Product. "Anywhere" in the path is what finds dext.com/business/pricing. ----
  { name: 'products', tier: 'product', pattern: /^products?$/ },
  { name: 'solutions', tier: 'product', pattern: /^solutions?$/ },
  { name: 'features', tier: 'product', pattern: /^features?$/ },
  { name: 'pricing', tier: 'product', pattern: /^pricing$/ },
  { name: 'plans', tier: 'product', pattern: /^plans?$/ },
  { name: 'platform', tier: 'product', pattern: /^platform$/ },
  // integrations only. `apps`, `connectors`, `plugins` and `marketplace` stay OTHER and capped: "what
  // we integrate with" is capability evidence; "browse our app directory" is a page farm.
  { name: 'integrations', tier: 'product', pattern: /^integrations?$/ },
  { name: 'use-cases', tier: 'product', pattern: /^use-cases?$/ },
  { name: 'industries', tier: 'product', pattern: /^industries$/ },
  // A competitor comparison is exactly the evidence these crawls exist to collect.
  { name: 'alternatives', tier: 'product', pattern: /^(?:alternatives|vs|versus|compare|comparison)$/ },
  { name: 'capabilities', tier: 'product', pattern: /^capabilities$/ },
  { name: 'modules', tier: 'product', pattern: /^modules?$/ },

  // ---- Evidence. ----
  // Directories whose pages ARE the evidence a tool page is grounded in.
  //
  // Separate from `editorial` for one reason, and it is not ordering: `admit()` rations editorial
  // against `EDITORIAL_SHARE`, so a case study competes with blog posts for a 20% budget and loses.
  // Measured 2026-10-02 by diffing crawl_links against crawl_pages — bill.com discovered 75 of these
  // and crawled 1, melio.com discovered 23 and crawled 1, 111 refused across five partners. Every one
  // classified `editorial`, checked by running classifyPath over them rather than inferred.
  //
  // They are not editorial in any useful sense. `melio.com/case-studies/cubepros` is a named client
  // with a stated outcome, which is the `caseStudies` extraction category verbatim; `/faq` is
  // `faqBank`; customer pages carry `testimonials`. Three of the 22 categories a tool page is refused
  // for lacking live here.
  //
  // Deliberately NOT here: security, trust, changelog, demo, docs, limits, awards. They fill five more
  // categories but already tier `other`, so moving them would change crawl order only — and ordering
  // changes nothing while the 2,500-page cap goes unreached, which it has on all 47 runs to date.
  //
  // The leading-qualifier group mirrors `blog`'s, so dext's `smb-testimonials` is caught. Whole
  // segments only: `/blog/case-studies-in-ap-automation` is an article about case studies and stays
  // editorial.
  { name: 'customers', tier: 'evidence', pattern: /^customers$/ },
  // case-study, case-studies, customer-case-studies
  { name: 'case-studies', tier: 'evidence', pattern: /^(?:[a-z0-9]+-)?case-stud(?:y|ies)$/ },
  { name: 'stories', tier: 'evidence', pattern: /^(?:[a-z0-9]+-)?success-stor(?:y|ies)$/ },
  // stories, customer-stories, success-stories
  { name: 'stories', tier: 'evidence', pattern: /^(?:[a-z0-9]+-)?stories$/ },
  // testimonials, smb-testimonials
  { name: 'testimonials', tier: 'evidence', pattern: /^(?:[a-z0-9]+-)?testimonials?$/ },
  { name: 'faq', tier: 'evidence', pattern: /^(?:faqs?|frequently-asked(?:-questions)?)$/ },

  // ---- Editorial. EDITORIAL_SHARE is the primary control; quotas are ceilings behind it. ----
  { name: 'blog', tier: 'editorial', pattern: /^(?:[a-z0-9]+-)?blogs?$/ },
  { name: 'news', tier: 'editorial', pattern: /^(?:[a-z0-9]+-)?news$/ },
  { name: 'press', tier: 'editorial', pattern: /^press(?:-releases?|-room|-centre?|-center)?$/ },
  // Singular `story` is an article; plural is evidence, above. One budget.
  { name: 'stories', tier: 'editorial', pattern: /^(?:[a-z0-9]+-)?story$/ },
  // Mixed resource libraries
  { name: 'resources', tier: 'editorial', pattern: /^(?:[a-z0-9]+-)?resources?$/ },
  { name: 'resource-center', tier: 'editorial', pattern: /^[a-z0-9-]*resource-cent(?:er|re)$/ },
  { name: 'hub', tier: 'editorial', pattern: /^(?:[a-z0-9]+-)?(?:hub|content-corner)$/ },
  { name: 'learn', tier: 'editorial', pattern: /^learn(?:ing)?$/ },
  { name: 'academy', tier: 'editorial', pattern: /^academy$/ },
  // Dictionary-style thin pages
  { name: 'glossary', tier: 'editorial', pattern: /^(?:glossary|definitions|dictionary|what-is)$/ },
  { name: 'insights', tier: 'editorial', pattern: /^insights?$/ },
  { name: 'articles', tier: 'editorial', pattern: /^articles?$/ },
  { name: 'guides', tier: 'editorial', pattern: /^guides?$/ },
  { name: 'ebooks', tier: 'editorial', pattern: /^ebooks?$/ },
  // Programmatic template farms
  { name: 'templates', tier: 'editorial', pattern: /^(?:[a-z0-9]+-)?templates?$/ },
  { name: 'videos', tier: 'editorial', pattern: /^videos?$/ },
  // Listing / registration pages
  { name: 'webinars', tier: 'editorial', pattern: /^webinars?$/ },
  { name: 'podcasts', tier: 'editorial', pattern: /^podcasts?$/ },
  { name: 'events', tier: 'editorial', pattern: /^events?$/ },
  // User-generated
  { name: 'community', tier: 'editorial', pattern: /^(?:community|forum|answers|questions)$/ },
  // Title-substitution pages
  { name: 'job-descriptions', tier: 'editorial', pattern: /^(?:job-descriptions|roles|titles)$/ },
  // Interactive tool shells
  { name: 'free-tools', tier: 'editorial', pattern: /^free-tools$/ },
  { name: 'generators', tier: 'editorial', pattern: /^generators?$/ },
  { name: 'calculators', tier: 'editorial', pattern: /^calculators?$/ },
  { name: 'help', tier: 'editorial', pattern: /^(?:knowledge|kb|help|support)$/ },
  // Archive and pagination views, first segment only.
  {
    name: 'archive',
    tier: 'editorial',
    pattern: /^(?:author|authors|tag|tags|category|categories|topics|archive|page)$/,
    firstSegmentOnly: true,
  },

  // ---- Other: quota sections only. They never classify. ----
  // App / integration catalogues
  { name: 'apps', tier: 'other', pattern: /^apps$/ },
  { name: 'connectors', tier: 'other', pattern: /^connectors$/ },
  { name: 'plugins', tier: 'other', pattern: /^plugins$/ },
  { name: 'marketplace', tier: 'other', pattern: /^marketplace$/ },
  // Tool pages carry partner/vendor links, which is what HarvestTools reads from the anchors under
  // a heading. Capping them at 10 starved the grounding.
  { name: 'tools', tier: 'other', pattern: /^tools$/ },
  // Generated reference tables -- the avalara case. A rate table per county, per city and per ZIP
  // is one template rendered over a government dataset: thousands of near-identical pages, each a
  // heading plus a percentage plus a state dropdown serialised as body text. Not editorial, so the
  // EDITORIAL_SHARE gate never saw them, and that is what left them unbounded.
  //
  // Generated jurisdiction reference -- one page per country, state, county or city, rendered from
  // a dataset. avalara.com ships TWO of these and the second was the gap: the US side is
  // /us/en/taxrates/state-rates/<state>/counties/<county>.html (1,672 URLs in the frontier, caught
  // by tax-rates) and the EU side is /us/en/vatlive/country-guides/<region>/<country> (287 URLs,
  // caught by nothing). Same template, same fan-out, different jurisdiction vocabulary -- which is
  // the whole argument for matching a pattern rather than enumerating directory names.
  {
    name: 'jurisdiction-guides',
    tier: 'other',
    pattern:
      /^(?:countr(?:y|ies)|states?|provinces?|regions?|cities|city|count(?:y|ies)|municipalit(?:y|ies)|jurisdictions?)-(?:guides?|profiles?|pages?|rates?|rules?|tables?|reference)$/,
  },
  // Tax reference tables by regime. The optional two-letter prefix is what catches `eu-vat-rules`
  // next to `vat-rules`; it is the same shape as the locale prefix that hid `taxrates`.
  {
    name: 'tax-reference',
    tier: 'other',
    pattern:
      /^(?:[a-z]{2}-)?(?:vat|gst|hst|pst|sales-tax|use-tax|excise|duty)-(?:rules?|rates?|guides?|tables?|info|compliance)$/,
  },
  { name: 'tax-rates', tier: 'other', pattern: /^tax-?rates?$/ },
  { name: 'rate-tables', tier: 'other', pattern: /^(?:state|city|county|local|zip|sales-tax)-rates?$/ },
  { name: 'localities', tier: 'other', pattern: /^(?:count(?:y|ies)|cities|states|municipalities|districts)$/ },
  { name: 'zip-codes', tier: 'other', pattern: /^zip-?codes?$/ },
];

/** Classifying precedence within one segment: the more specific tier wins. */
const CLASSIFY_ORDER: readonly PageTier[] = ['product', 'evidence', 'editorial'];

/** The entry a segment matches at a position, or undefined. Consumers pick which tiers to accept. */
function matchAt(
  segment: string,
  index: number,
  accept: (entry: SectionEntry) => boolean,
): SectionEntry | undefined {
  return SECTIONS.find(
    (e) => accept(e) && (!e.firstSegmentOnly || index === 0) && e.pattern.test(segment),
  );
}

/** The tier of the leftmost classifying segment, or undefined when none classifies. */
export function segmentTier(segments: readonly string[]): PageTier | undefined {
  for (const [index, segment] of segments.entries()) {
    for (const tier of CLASSIFY_ORDER) {
      if (matchAt(segment, index, (e) => e.tier === tier)) return tier;
    }
  }
  return undefined;
}

/** The name of the leftmost non-product section, or '' when none matches. */
export function segmentSection(segments: readonly string[]): string {
  for (const [index, segment] of segments.entries()) {
    const entry = matchAt(segment, index, (e) => e.tier !== 'product');
    if (entry) return entry.name;
  }
  return '';
}
