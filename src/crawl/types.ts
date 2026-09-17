/** Crawl type labels — same values as Geek-Crawler v1; this repo does not call v1. */
export const CrawlTypes = {
  Competitors: 'competitors',
  Partner: 'partner',
  /** Geography — local SEO pages. NOT the operator's own site; that is ProjectSite. */
  Local: 'local',
  /** The operator's own site. Source of the site hierarchy that grounds generation. */
  ProjectSite: 'project-site',
} as const;

export type CrawlType = (typeof CrawlTypes)[keyof typeof CrawlTypes];

const ALLOWED = new Set<string>(Object.values(CrawlTypes));

/** Accepted values, for error messages and UI lists. Derived, never hand-written. */
export const CRAWL_TYPE_VALUES: readonly CrawlType[] = Object.values(CrawlTypes);

export function parseCrawlType(value: string | undefined): CrawlType {
  const v = (value ?? CrawlTypes.Partner).toLowerCase();
  if (!ALLOWED.has(v)) {
    throw new Error(`Invalid crawlType "${value}". Use: ${CRAWL_TYPE_VALUES.join(' | ')}`);
  }
  return v as CrawlType;
}
