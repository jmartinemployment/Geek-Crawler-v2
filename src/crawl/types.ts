/** Crawl type labels — same values as Geek-Crawler v1; this repo does not call v1. */
export const CrawlTypes = {
  Competitors: 'competitors',
  Partner: 'partner',
  Local: 'local',
} as const;

export type CrawlType = (typeof CrawlTypes)[keyof typeof CrawlTypes];

const ALLOWED = new Set<string>(Object.values(CrawlTypes));

export function parseCrawlType(value: string | undefined): CrawlType {
  const v = (value ?? CrawlTypes.Partner).toLowerCase();
  if (!ALLOWED.has(v)) {
    throw new Error(`Invalid crawlType "${value}". Use: competitors | partner | local`);
  }
  return v as CrawlType;
}
