import { classifyPath, type PageTier } from './classify-path.js';
import { segmentSection } from './section-vocabulary.js';
/**
 * Per-section page quotas, applied at enqueue admission.
 *
 * A section is the FIRST PATH SEGMENT THAT MATCHES the vocabulary in section-vocabulary.ts,
 * scanning left to right -- not path segment one. Known page farms carry a cap so one programmatic
 * directory cannot consume the crawl budget. A quota of 0 excludes the section entirely; a URL
 * matching nothing is uncapped.
 *
 * Quota is budget allocation, not content judgement: it decides how many pages a section may
 * contribute, never which page is better. It is also the SECONDARY control -- `EDITORIAL_SHARE`
 * in `admit()` governs composition, and these caps are ceilings behind it.
 */


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
 * Read off the vocabulary the classifier also reads (section-vocabulary.ts): leftmost non-product
 * match wins, and the result is a canonical NAME, not the matched segment, so company-blog and
 * blog share one budget rather than each getting its own 250.
 *
 * Every segment is eligible, not just the first (2026-09-30). sectionKey returned path segment
 * one, which on a locale-prefixed site is the locale. avalara.com serves its entire site under
 * /us/en/, so every URL on it resolved to section us, which has no entry, so ALL of these caps
 * were dead for the whole site -- and 475 of 572 crawled pages were county tax-rate tables under
 * /us/en/taxrates/state-rates/<state>/counties/<county>.html.
 *
 * Leftmost wins, so /blog/category/accounting is blog and not category: the section a page
 * lives in is the outermost one that matches, not the innermost.
 */
export function quotaKey(url: string): string {
  return segmentSection(segmentsOf(url));
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
  /** As admit, naming the gate when the URL is refused. */
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
    // table has no key for is uncapped entirely -- which is how learning contributed 510 pages
    // and press-releases 254.
    if (tier === 'editorial') {
      // Expressed against NON-editorial pages, not the total, because the total includes the
      // editorial already admitted and the equation then chases itself. For a share s, admitting
      // e editorial alongside n others gives e/(e+n) = s, so e = n * s/(1-s) -- at 0.2 that is a
      // quarter of the non-editorial count, which lands the finished crawl at exactly 20%.
      // byTier.evidence is deliberately NOT in this sum, and nothing in the type system says so.
      //
      // Evidence pages are exempt from this gate (the tier === 'editorial' test above), which is
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
    // so a locale prefix like /us/en/ cannot hide the real one. See quotaKey.
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
