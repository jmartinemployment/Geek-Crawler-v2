import { classifyPath, type PageTier } from './classify-path.js';
/**
 * Per-section page quotas, applied at enqueue admission.
 *
 * A section is the FIRST PATH SEGMENT THAT MATCHES the vocabulary in `SECTION_PATTERNS`, scanning
 * left to right -- not path segment one. Known page farms carry a cap so one programmatic
 * directory cannot consume the crawl budget. A quota of 0 excludes the section entirely; a URL
 * matching nothing is uncapped.
 *
 * Quota is budget allocation, not content judgement: it decides how many pages a section may
 * contribute, never which page is better. It is also the SECONDARY control -- `EDITORIAL_SHARE`
 * in `admit()` governs composition, and these caps are ceilings behind it.
 */


/**
 * Canonical section names and the segment patterns that resolve to them.
 *
 * Two things changed here on 2026-09-30, both because avalara.com exposed them.
 *
 * **Patterns, not exact strings.** `classify-path.ts` had already moved its vocabulary to anchored
 * segment regexes for precisely this reason -- exact keys missed `company-blog` next to `blog` and
 * `case-study` next to `case-studies`. Quotas kept matching by exact string, so the two mechanisms
 * disagreed about what a section even was.
 *
 * **Every segment is eligible, not just the first.** `sectionKey` returned path segment one, which
 * on a locale-prefixed site is the locale. avalara.com serves its entire site under `/us/en/`, so
 * every URL on it resolved to section `us`, which has no entry, so ALL of these caps were dead for
 * the whole site -- and 475 of 572 crawled pages were county tax-rate tables under
 * `/us/en/taxrates/state-rates/<state>/counties/<county>.html`. Scanning segments left to right and
 * taking the first that matches makes the locale prefix irrelevant, the same way it already is for
 * classification.
 *
 * Leftmost wins, so `/blog/category/accounting` is `blog` and not `category`: the section a page
 * lives in is the outermost one that classifies, not the innermost.
 */
type SectionPattern = {
  /** Canonical section name; the key looked up in the quota map. */
  readonly name: string;
  /** Matched against one lowercased path segment, anchored. */
  readonly pattern: RegExp;
  /**
   * Only match as the first path segment.
   *
   * `classify-path.ts` makes the same distinction for the same reason: `/category/accounting` is a
   * blog archive, but `/solutions/category/enterprise` is product taxonomy and `/products/tags/erp`
   * is a product tag page. Matching `category` at any depth resolved both to `archive`, whose quota
   * is 0, so any-segment matching would have silently excluded product pages -- the opposite of
   * what these caps are for. Position carries the meaning, so position is what is checked.
   */
  readonly firstSegmentOnly?: true;
};

const SECTION_PATTERNS: readonly SectionPattern[] = [
  // Programmatic template farms
  { name: 'templates', pattern: /^(?:[a-z0-9]+-)?templates?$/ },
  // App / integration catalogues. `integrations` is deliberately NOT here -- see DEFAULT_SECTION_QUOTAS.
  { name: 'apps', pattern: /^apps$/ },
  { name: 'connectors', pattern: /^connectors$/ },
  { name: 'plugins', pattern: /^plugins$/ },
  { name: 'marketplace', pattern: /^marketplace$/ },
  // Dictionary-style thin pages
  { name: 'glossary', pattern: /^(?:glossary|definitions|dictionary|what-is)$/ },
  // Title-substitution pages
  { name: 'job-descriptions', pattern: /^(?:job-descriptions|roles|titles)$/ },
  // Archive / pagination views
  { name: 'archive', pattern: /^(?:author|authors|tag|tags|category|categories|topics|archive)$/, firstSegmentOnly: true },
  // Interactive tool shells
  { name: 'free-tools', pattern: /^free-tools$/ },
  { name: 'generators', pattern: /^generators?$/ },
  { name: 'calculators', pattern: /^calculators?$/ },
  // Tool pages carry partner/vendor links, which is what HarvestTools reads from the anchors under
  // a heading. Capping them at 10 starved the grounding.
  { name: 'tools', pattern: /^tools$/ },
  // Generated reference tables -- the avalara case. A rate table per county, per city and per ZIP
  // is one template rendered over a government dataset: thousands of near-identical pages, each a
  // heading plus a percentage plus a state dropdown serialised as body text. Not editorial, so the
  // EDITORIAL_SHARE gate never saw them, and that is what left them unbounded.
  // Generated jurisdiction reference -- one page per country, state, county or city, rendered from
  // a dataset. avalara.com ships TWO of these and the second was the gap: the US side is
  // /us/en/taxrates/state-rates/<state>/counties/<county>.html (1,672 URLs in the frontier, caught
  // by tax-rates) and the EU side is /us/en/vatlive/country-guides/<region>/<country> (287 URLs,
  // caught by nothing). Same template, same fan-out, different jurisdiction vocabulary -- which is
  // the whole argument for matching a pattern rather than enumerating directory names.
  { name: 'jurisdiction-guides', pattern: /^(?:countr(?:y|ies)|states?|provinces?|regions?|cities|city|count(?:y|ies)|municipalit(?:y|ies)|jurisdictions?)-(?:guides?|profiles?|pages?|rates?|rules?|tables?|reference)$/ },
  // Tax reference tables by regime. The optional two-letter prefix is what catches `eu-vat-rules`
  // next to `vat-rules`; it is the same shape as the locale prefix that hid `taxrates`.
  { name: 'tax-reference', pattern: /^(?:[a-z]{2}-)?(?:vat|gst|hst|pst|sales-tax|use-tax|excise|duty)-(?:rules?|rates?|guides?|tables?|info|compliance)$/ },
  { name: 'tax-rates', pattern: /^tax-?rates?$/ },
  { name: 'rate-tables', pattern: /^(?:state|city|county|local|zip|sales-tax)-rates?$/ },
  { name: 'localities', pattern: /^(?:count(?:y|ies)|cities|states|municipalities|districts)$/ },
  { name: 'zip-codes', pattern: /^zip-?codes?$/ },
  // Editorial -- real content, capped by volume. The EDITORIAL_SHARE gate is the primary control on
  // these; the cap is a ceiling for the case where a site is almost entirely one editorial section.
  { name: 'blog', pattern: /^(?:[a-z0-9]+-)?blogs?$/ },
  { name: 'news', pattern: /^(?:[a-z0-9]+-)?news$/ },
  { name: 'press', pattern: /^press(?:-releases?|-room|-centre?|-center)?$/ },
  { name: 'insights', pattern: /^insights?$/ },
  { name: 'articles', pattern: /^articles?$/ },
  { name: 'guides', pattern: /^guides?$/ },
  { name: 'ebooks', pattern: /^ebooks?$/ },
  { name: 'learn', pattern: /^learn(?:ing)?$/ },
  { name: 'academy', pattern: /^academy$/ },
  // Listing / registration pages
  { name: 'events', pattern: /^events?$/ },
  { name: 'webinars', pattern: /^webinars?$/ },
  // User-generated
  { name: 'community', pattern: /^(?:community|forum|answers|questions)$/ },
  // Case studies
  { name: 'customers', pattern: /^customers$/ },
  { name: 'case-studies', pattern: /^case-stud(?:y|ies)$/ },
  { name: 'stories', pattern: /^(?:[a-z0-9]+-)?stor(?:y|ies)$/ },
  // Mixed resource libraries
  { name: 'resources', pattern: /^(?:[a-z0-9]+-)?resources?$/ },
];

/**
 * Per-section page caps. A quota of 0 excludes the section entirely; a section with no entry is
 * uncapped.
 *
 * Quota is budget allocation, not content judgement: it decides how many pages a section may
 * contribute, never which page is better.
 *
 * **`integrations`, `alternatives`, `vs` and `versus` were removed on 2026-09-30.** They were here
 * from before `classify-path.ts` existed, which now classifies all four as PRODUCT -- "a competitor
 * comparison is exactly the evidence these crawls exist to collect". Matching any segment rather
 * than only the first would have made those caps bite far harder than they ever did (every
 * `/solutions/integrations/*` page, not just a site rooted at `/integrations/`), so keeping them
 * would have quietly throttled the evidence the crawl is for. Composition for product pages is the
 * tier order's job, not a cap's.
 */
export const DEFAULT_SECTION_QUOTAS: ReadonlyMap<string, number> = new Map([
  ['templates', 10],
  ['apps', 10],
  ['connectors', 10],
  ['plugins', 10],
  ['marketplace', 10],
  ['glossary', 10],
  ['job-descriptions', 10],
  ['archive', 0],
  ['free-tools', 10],
  ['generators', 10],
  ['calculators', 10],
  ['tools', 100],
  ['tax-rates', 25],
  ['jurisdiction-guides', 25],
  ['tax-reference', 25],
  ['rate-tables', 25],
  ['localities', 0],
  ['zip-codes', 0],
  ['blog', 250],
  ['news', 250],
  ['press', 100],
  ['insights', 250],
  ['articles', 250],
  ['guides', 250],
  ['ebooks', 250],
  ['learn', 250],
  ['academy', 250],
  ['events', 0],
  ['webinars', 0],
  ['community', 10],
  ['customers', 250],
  ['case-studies', 250],
  ['stories', 250],
  ['resources', 250],
]);

/** Path segments, lowercased, empties dropped. Root and unparseable URLs yield []. */
function segmentsOf(url: string): string[] {
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return [];
  }
  return pathname.toLowerCase().split('/').filter(Boolean);
}

/** First path segment, lowercased. Root and unparseable URLs yield ''. Reporting only. */
export function sectionKey(url: string): string {
  return segmentsOf(url)[0] ?? '';
}

/**
 * The canonical section a URL belongs to, or '' when no segment matches the vocabulary.
 *
 * Leftmost match wins. Returns a canonical NAME, not the matched segment, so `company-blog` and
 * `blog` share one budget rather than each getting its own 250.
 */
export function quotaKey(url: string): string {
  const segments = segmentsOf(url);
  for (const [index, segment] of segments.entries()) {
    for (const { name, pattern, firstSegmentOnly } of SECTION_PATTERNS) {
      if (firstSegmentOnly && index !== 0) continue;
      if (pattern.test(segment)) return name;
    }
  }
  return '';
}


/**
 * Parse `SECTION_PAGE_QUOTA` overrides: "blog:500,templates:0".
 * Malformed entries are dropped; the value never throws.
 */
export function parseSectionQuotas(raw: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!raw) return out;
  for (const part of raw.split(',')) {
    const [name, value] = part.split(':');
    if (!name || value === undefined) continue;
    const key = name.trim().toLowerCase();
    const n = Number(value.trim());
    if (!key || !Number.isFinite(n) || n < 0) continue;
    out.set(key, Math.floor(n));
  }
  return out;
}

/** Defaults, with `SECTION_PAGE_QUOTA` entries overriding per section. */
export function resolveSectionQuotas(
  raw: string | undefined = process.env.SECTION_PAGE_QUOTA,
): Map<string, number> {
  const merged = new Map(DEFAULT_SECTION_QUOTAS);
  for (const [k, v] of parseSectionQuotas(raw)) merged.set(k, v);
  return merged;
}

/**
 * Share of admitted pages that may be editorial.
 *
 * A share of pages ADMITTED, not of the budget, and the difference decides the outcome. As a share
 * of a 2,500 budget, a site with 100 product pages and 800 blog posts yields 100 product + 500
 * editorial -- 83% editorial, the exact problem this exists to fix. As a share of admitted, the same
 * site yields 100 product + 25 editorial and holds the ratio.
 *
 * The consequence, stated rather than discovered: a thin site produces fewer pages. That is a fact
 * about the site having few product pages, not a per-type budget -- partner, competitors and local
 * all carry the same 2,500 ceiling and the same rules.
 */
export const EDITORIAL_SHARE = 0.2;

/**
 * Editorial pages a site may contribute even with no product pages at all.
 *
 * Applies only when the crawl found NO product or other pages at all. At a 0.2 share the ratio is
 * degenerate at zero -- a site that is entirely blog would yield nothing rather than a small sample,
 * and a crawl that silently did nothing is not composition control.
 *
 * Deliberately not a Math.max against the ratio. As a floor on every site it overrode the ratio on
 * small ones: 19 non-editorial pages allow 4 editorial, and a floor of 25 took lightyear.cloud to
 * 57% editorial.
 */
export const MIN_EDITORIAL_PAGES = 25;

/** Which gate refused a URL. */
export type QuotaRefusal = 'share' | 'section';

export type QuotaDecision = { admitted: true } | { admitted: false; refusal: QuotaRefusal };

/**
 * Refusal counts are distinct URLs, by the gate that refused each one last. A URL is offered once
 * from the sitemap and again from every page that links to it; counting each offer made one refused
 * URL linked from 40 pages read as 40 refusals. A URL refused and later admitted -- the editorial
 * allowance grows as product pages arrive -- leaves the refusal counts.
 */
export type SectionQuota = {
  /** True when the URL may be enqueued. Mutates admission state. */
  admit(url: string): boolean;
  /** As `admit`, naming the gate when the URL is refused. */
  decide(url: string): QuotaDecision;
  /** Admitted count per capped section. */
  admittedBySection(): Map<string, number>;
  /** Distinct URLs refused per capped section because it was full. */
  suppressedBySection(): Map<string, number>;
  /** Distinct URLs refused because their section was full. */
  totalSuppressed(): number;
  /** Admitted counts by tier, for the crawl report. */
  admittedByTier(): Record<PageTier, number>;
  /** Distinct URLs refused because the editorial share was already met. */
  suppressedByShare(): number;
};

export function createSectionQuota(
  limits: ReadonlyMap<string, number> = resolveSectionQuotas(),
): SectionQuota {
  const admitted = new Map<string, number>();
  // Current refusal per url, by gate. A url leaves both once admitted; refusedBySection maps the
  // url to the section that was full.
  const refusedByShare = new Set<string>();
  const refusedBySection = new Map<string, string>();

  const byTier: Record<PageTier, number> = { product: 0, evidence: 0, other: 0, editorial: 0 };
  const alreadyAdmitted = new Set<string>();

  const decide = (url: string): QuotaDecision => {
    // Idempotent per url, and it has to be. A url is offered twice: once from the sitemap in
    // initialCrawlUrls, and again when a crawled page links to it. Counting it both times
    // inflates the non-editorial total, which raises the editorial allowance derived from it --
    // measured on lightyear.cloud, a 155-url sitemap admitting 20 non-editorial pages permitted 5
    // editorial at enqueue and then let 25 through as re-encounters re-counted the same pages.
    //
    // The old per-section caps hid this: they were large and per-section, so a double count cost
    // one slot out of 250. A share is derived from the totals, so a double count moves the budget.
    if (alreadyAdmitted.has(url)) return { admitted: true };

    const tier = classifyPath(url);

    // The share gate, before the per-section caps. Per-section caps cannot control composition on
    // their own: six sections at 250 each still admits 1,500 editorial pages, and any section the
    // table has no key for is uncapped entirely -- which is how `learning` contributed 510 pages
    // and `press-releases` 254.
    if (tier === 'editorial') {
      // Expressed against NON-editorial pages, not the total, because the total includes the
      // editorial already admitted and the equation then chases itself. For a share s, admitting
      // e editorial alongside n others gives e/(e+n) = s, so e = n * s/(1-s) -- at 0.2 that is a
      // quarter of the non-editorial count, which lands the finished crawl at exactly 20%.
      // byTier.evidence is deliberately NOT in this sum, and nothing in the type system says so.
      //
      // Evidence pages are exempt from this gate (the `tier === 'editorial'` test above), which is
      // the whole point of the tier. Counting them here as well would also RAISE the editorial
      // allowance -- roughly 25 extra blog posts per 100 case studies admitted -- so the change
      // intended to buy evidence would quietly buy blog too. The allowance stays tied to
      // product + other exactly as it was before the tier existed.
      const nonEditorial = byTier.product + byTier.other;
      // The floor applies ONLY when there is nothing else to hold a ratio against. Used as a
      // Math.max it swamped small sites: lightyear.cloud has 19 non-editorial pages, the ratio
      // allows 4, and a floor of 25 took the crawl to 57% editorial -- the floor overriding the
      // rule it exists to make survivable.
      const allowed =
        nonEditorial === 0
          ? MIN_EDITORIAL_PAGES
          : Math.floor(nonEditorial * (EDITORIAL_SHARE / (1 - EDITORIAL_SHARE)));
      if (byTier.editorial >= allowed) {
        refusedBySection.delete(url);
        refusedByShare.add(url);
        return { admitted: false, refusal: 'share' };
      }
    }

    // quotaKey, not sectionKey: the section is the leftmost segment that matches the vocabulary,
    // so a locale prefix like /us/en/ cannot hide the real one. See SECTION_PATTERNS.
    const key = quotaKey(url);
    const limit = key === '' ? undefined : limits.get(key);
    if (limit !== undefined) {
      const used = admitted.get(key) ?? 0;
      if (used >= limit) {
        refusedByShare.delete(url);
        refusedBySection.set(url, key);
        return { admitted: false, refusal: 'section' };
      }
      admitted.set(key, used + 1);
    }

    byTier[tier] += 1;
    alreadyAdmitted.add(url);
    refusedByShare.delete(url);
    refusedBySection.delete(url);
    return { admitted: true };
  };

  return {
    admit(url: string): boolean {
      return decide(url).admitted;
    },
    decide,
    admittedByTier() {
      return { ...byTier };
    },
    suppressedByShare() {
      return refusedByShare.size;
    },
    admittedBySection() {
      return new Map(admitted);
    },
    suppressedBySection() {
      const out = new Map<string, number>();
      for (const key of refusedBySection.values()) out.set(key, (out.get(key) ?? 0) + 1);
      return out;
    },
    totalSuppressed() {
      return refusedBySection.size;
    },
  };
}
