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

export type SectionQuota = {
  /** True when the URL may be enqueued. Mutates admission state. */
  admit(url: string): boolean;
  /** Admitted count per capped section. */
  admittedBySection(): Map<string, number>;
  /** Suppressed count per capped section. */
  suppressedBySection(): Map<string, number>;
  /** Total URLs refused because their section was full. */
  totalSuppressed(): number;
};

export function createSectionQuota(
  limits: ReadonlyMap<string, number> = resolveSectionQuotas(),
): SectionQuota {
  const admitted = new Map<string, number>();
  const suppressed = new Map<string, number>();

  return {
    admit(url: string): boolean {
      const key = sectionKey(url);
      const limit = limits.get(key);
      if (limit === undefined) return true;
      const used = admitted.get(key) ?? 0;
      if (used >= limit) {
        suppressed.set(key, (suppressed.get(key) ?? 0) + 1);
        return false;
      }
      admitted.set(key, used + 1);
      return true;
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
