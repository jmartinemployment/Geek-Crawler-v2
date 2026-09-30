import { classifyPath, type PageTier } from './classify-path.js';
/**
 * Per-directory page quotas, applied at enqueue admission.
 *
 * A section is the first path segment of a URL. Known low-quality directories
 * carry a page cap so one programmatic page farm cannot consume the crawl
 * budget. A quota of 0 excludes the directory entirely. Sections absent from
 * the table are uncapped.
 *
 * Quota is budget allocation, not content judgement: it decides how many pages
 * a directory may contribute, never which page is better.
 */

/** Known low-quality directories and their per-run page caps. */
export const DEFAULT_SECTION_QUOTAS: ReadonlyMap<string, number> = new Map([
  // Programmatic template farms
  ['templates', 10],
  ['template', 10],
  // App / integration catalogues
  ['apps', 10],
  ['connectors', 10],
  ['plugins', 10],
  ['marketplace', 10],
  ['integrations', 25],
  // Competitor comparison pages
  ['alternatives', 250],
  ['vs', 250],
  ['versus', 250],
  // Dictionary-style thin pages
  ['glossary', 10],
  ['definitions', 10],
  ['what-is', 10],
  ['dictionary', 10],
  // Title-substitution pages
  ['job-descriptions', 10],
  ['roles', 10],
  ['titles', 10],
  // Archive / pagination views — excluded
  ['author', 0],
  ['tag', 0],
  ['tags', 0],
  ['category', 0],
  ['categories', 0],
  ['topics', 0],
  // Interactive tool shells
  ['free-tools', 10],
  // Tool pages carry partner/vendor links, which is what HarvestTools reads from the
  // anchors under a heading. Capping them at 10 starved the grounding. One number for
  // every crawl type - own site, partner and competitor - since tool pages are evidence
  // on any of them.
  ['tools', 100],
  ['generators', 10],
  ['calculators', 10],
  // Editorial — real content, capped by volume
  ['blog', 250],
  ['news', 250],
  ['insights', 250],
  ['articles', 250],
  // Listing / registration pages — excluded
  ['events', 0],
  ['webinar', 0],
  ['webinars', 0],
  // User-generated
  ['community', 10],
  ['forum', 10],
  ['answers', 10],
  ['questions', 10],
  // Case studies
  ['customers', 250],
  ['case-studies', 250],
  ['stories', 250],
  // Mixed resource libraries
  ['resources', 250],
  ['general-resources', 250],
  ['guides', 250],
  ['ebooks', 250],
]);

/** First path segment, lowercased. Root and unparseable URLs yield ''. */
export function sectionKey(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return '';
  }
  const first = u.pathname.split('/').filter(Boolean)[0];
  return first ? first.toLowerCase() : '';
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

export type SectionQuota = {
  /** True when the URL may be enqueued. Mutates admission state. */
  admit(url: string): boolean;
  /** Admitted count per capped section. */
  admittedBySection(): Map<string, number>;
  /** Suppressed count per capped section. */
  suppressedBySection(): Map<string, number>;
  /** Total URLs refused because their section was full. */
  totalSuppressed(): number;
  /** Admitted counts by tier, for the crawl report. */
  admittedByTier(): Record<PageTier, number>;
  /** URLs refused because the editorial share was already met. */
  suppressedByShare(): number;
};

export function createSectionQuota(
  limits: ReadonlyMap<string, number> = resolveSectionQuotas(),
): SectionQuota {
  const admitted = new Map<string, number>();
  const suppressed = new Map<string, number>();

  const byTier: Record<PageTier, number> = { product: 0, other: 0, editorial: 0 };
  const alreadyAdmitted = new Set<string>();
  let shareSuppressed = 0;

  return {
    admit(url: string): boolean {
      // Idempotent per url, and it has to be. A url is offered twice: once from the sitemap in
      // initialCrawlUrls, and again when a crawled page links to it. Counting it both times
      // inflates the non-editorial total, which raises the editorial allowance derived from it --
      // measured on lightyear.cloud, a 155-url sitemap admitting 20 non-editorial pages permitted 5
      // editorial at enqueue and then let 25 through as re-encounters re-counted the same pages.
      //
      // The old per-section caps hid this: they were large and per-section, so a double count cost
      // one slot out of 250. A share is derived from the totals, so a double count moves the budget.
      if (alreadyAdmitted.has(url)) return true;

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
          shareSuppressed += 1;
          return false;
        }
      }

      const key = sectionKey(url);
      const limit = limits.get(key);
      if (limit !== undefined) {
        const used = admitted.get(key) ?? 0;
        if (used >= limit) {
          suppressed.set(key, (suppressed.get(key) ?? 0) + 1);
          return false;
        }
        admitted.set(key, used + 1);
      }

      byTier[tier] += 1;
      alreadyAdmitted.add(url);
      return true;
    },
    admittedByTier() {
      return { ...byTier };
    },
    suppressedByShare() {
      return shareSuppressed;
    },
    admittedBySection() {
      return new Map(admitted);
    },
    suppressedBySection() {
      return new Map(suppressed);
    },
    totalSuppressed() {
      let n = 0;
      for (const v of suppressed.values()) n += v;
      return n;
    },
  };
}
