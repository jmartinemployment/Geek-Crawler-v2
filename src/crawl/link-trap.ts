/**
 * Link-trap defence for discovered links.
 *
 * Until 2026-10-04 the sitemap allowlist was the only thing between a crawl and a link trap: a
 * same-origin link the sitemap did not list was dropped, so an infinite calendar or a faceted
 * listing could never be entered. It also dropped ramp.com's /products, bill.com's /pricing and
 * lightyear.cloud's /features/*, because the sitemap omitted them. Lifting the allowlist removes
 * the defence with it, so these rules replace it.
 *
 * Scope: links found on crawled pages that the sitemap does not list. A URL the site declares in
 * its sitemap is admitted as declared; the site published it, and these rules exist for the URLs
 * nobody published. With no sitemap at all, every discovered link is in scope.
 *
 * Three rules, cheapest first:
 *   1. A path or query pattern that names a listing view rather than a page: pagination, facets,
 *      on-site search, calendar navigation.
 *   2. A per-directory cap on admitted other-tier pages, so a directory of generated records
 *      (job ids, profile pages) cannot take the budget. Product, evidence and editorial pages are
 *      not capped here: product and evidence are what the crawl is for, and editorial is already
 *      bounded by EDITORIAL_SHARE and the section quotas.
 *   3. Profile maxDepth, applied in the runner, counted per URL here.
 *
 * The thresholds are NOT measured. The plan asked for them to be measured on ramp, bill and
 * lightyear before shipping; no corpus access was available when this was written. Every refusal
 * is counted by rule in the discovery report, so the first re-crawl of each site is that
 * measurement.
 */

/** A listing view, never a page. */
export type TrapRule = 'pagination' | 'facet' | 'search' | 'calendar';

/**
 * Query keys that page through a listing. Only refused with a numeric value. Not p: WordPress
 * uses ?p=123 as a post id, and that URL is the post.
 */
const PAGINATION_KEYS = new Set(['page', 'paged', 'pg', 'offset', 'start']);

/** Query keys that filter or reorder a listing. Any value. */
const FACET_KEYS = new Set([
  'filter',
  'filters',
  'facet',
  'facets',
  'sort',
  'sortby',
  'sort_by',
  'order',
  'orderby',
  'order_by',
  'view',
  'layout',
  'display',
  'per_page',
  'perpage',
  'limit',
  'min_price',
  'max_price',
  'price',
  'color',
  'colour',
  'size',
  'tag',
  'tags',
  'category',
  'categories',
]);

/** Query keys that run an on-site search. Any value. Not term: glossaries key entries by it. */
const SEARCH_KEYS = new Set(['q', 'query', 'search', 's', 'keyword', 'keywords']);

/** Query keys that step a calendar. Any value. */
const CALENDAR_KEYS = new Set([
  'date',
  'day',
  'week',
  'month',
  'year',
  'calendar',
  'ical',
  'tribe-bar-date',
  'eventdisplay',
]);

/**
 * A segment that is a date on its own: 2026, 2026-10, 2026-10-04. Anchored, so a dated slug
 * (2026-10-04-launch-notes) is an article and passes. The year is 19xx or 20xx, because the
 * accounting sites this crawls publish pages named for tax forms -- /1099, /1096 -- and a bare
 * four-digit test would refuse them as calendar cells.
 */
const DATE_SEGMENT = /^(?:19|20)\d{2}(?:-\d{1,2}){0,2}$/;

/**
 * Faceted combinations are built from several keys at once. A URL carrying more than this many
 * distinct query keys is a facet combination even when no single key is in FACET_KEYS.
 */
const MAX_QUERY_KEYS = 2;

/** A month or a day: one or two digits. */
const DATE_PART = /^\d{1,2}$/;

/** The path ends in a date: a date segment, or a year followed by a month and optionally a day. */
function endsInDate(segs: string[]): boolean {
  const n = segs.length;
  const last = segs[n - 1];
  if (last === undefined) return false;
  if (DATE_SEGMENT.test(last)) return true;
  if (!DATE_PART.test(last)) return false;
  const year = /^(?:19|20)\d{2}$/;
  if (year.test(segs[n - 2] ?? '')) return true;
  return DATE_PART.test(segs[n - 2] ?? '') && year.test(segs[n - 3] ?? '');
}

/** Path segments, lowercased, empties dropped. */
function segments(pathname: string): string[] {
  return pathname.toLowerCase().split('/').filter(Boolean);
}

/**
 * The trap rule a discovered URL matches, or null when it reads as a page.
 *
 * A query key is matched on its base name, so filter[color] is filter.
 */
export function trapRuleFor(url: string): TrapRule | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }

  const segs = segments(u.pathname);

  // /page/2, /blog/page/3 -- WordPress and most static generators.
  for (let i = 0; i < segs.length - 1; i += 1) {
    if (segs[i] === 'page' && /^\d+$/.test(segs[i + 1] ?? '')) return 'pagination';
  }

  // Rooted only: /search/results is a search page, /features/search is a product page about search.
  if (segs[0] === 'search') return 'search';

  // A path that ENDS in a date is a date archive or a calendar cell: /2026, /blog/2024/05,
  // /events/2026-10-04. A date followed by a slug is a dated article and passes. There is no rule
  // for a calendar segment: /features/calendar is a scheduling product's feature page.
  if (endsInDate(segs)) return 'calendar';

  const keys = new Set<string>();
  for (const [rawKey, value] of u.searchParams.entries()) {
    const key = rawKey.toLowerCase().replace(/\[.*$/, '');
    keys.add(key);
    if (PAGINATION_KEYS.has(key) && /^\d+$/.test(value.trim())) return 'pagination';
    if (SEARCH_KEYS.has(key)) return 'search';
    if (CALENDAR_KEYS.has(key)) return 'calendar';
    if (FACET_KEYS.has(key)) return 'facet';
  }
  if (keys.size > MAX_QUERY_KEYS) return 'facet';

  return null;
}

/**
 * Admitted off-sitemap other-tier pages allowed per top-level directory.
 *
 * Unmeasured; see the module comment. 50 is a ceiling, not a target: the largest other-tier
 * directories seen so far are company pages (about, careers, legal), which run to tens, and a
 * directory that needs more than 50 pages the sitemap does not list is far more likely a generated
 * record set than a section anyone wrote.
 */
export const OFF_SITEMAP_OTHER_DIRECTORY_CAP = 50;

/** The directory a URL is capped under: its first path segment, or '' at the root. */
export function directoryKey(url: string): string {
  try {
    return segments(new URL(url).pathname)[0] ?? '';
  } catch {
    return '';
  }
}

/**
 * Run-wide count of admitted off-sitemap other-tier pages per directory.
 *
 * Split into check and commit so the caller can run the section quota between them: the quota
 * mutates its own state on admission, so this cap has to be checked before it and charged only
 * after it admits. Idempotent per URL, like the quota, so a page linked from many pages holds one
 * slot.
 */
export type DirectoryCap = {
  hasRoom(url: string): boolean;
  commit(url: string): void;
};

export function createDirectoryCap(cap: number = OFF_SITEMAP_OTHER_DIRECTORY_CAP): DirectoryCap {
  const used = new Map<string, number>();
  const charged = new Set<string>();
  return {
    hasRoom(url) {
      if (charged.has(url)) return true;
      return (used.get(directoryKey(url)) ?? 0) < cap;
    },
    commit(url) {
      if (charged.has(url)) return;
      charged.add(url);
      const key = directoryKey(url);
      used.set(key, (used.get(key) ?? 0) + 1);
    },
  };
}
