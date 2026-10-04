/**
 * Every URL a crawl discovered, and what became of it.
 *
 * Before this, the crawl report could say how many pages were saved and why fetched pages were
 * rejected, but not what happened to the URLs that were never fetched. A link the sitemap did not
 * list was dropped without a count; a URL refused by a section quota was counted once per page that
 * linked to it, so one URL refused from 40 pages read as 40 refusals.
 *
 * One entry per distinct URL, holding its CURRENT state. A URL can be refused and later admitted --
 * the editorial allowance grows as product pages are admitted, and a link refused for depth can be
 * met again on a shallower page -- so the state is overwritten until the URL is enqueued, and the
 * report counts each URL once, under the state it finished in.
 *
 * The report balances by construction:
 *   discovered = enqueued + refused (summed over rules)
 *   enqueued   = fetched + enqueuedNotFetched
 */

import type { TrapRule } from './link-trap.js';
import { quotaKey } from './section-quota.js';

/** Where an enqueued URL came from. */
export type DiscoverySource = 'seed' | 'sitemap' | 'harvest' | 'link';

/**
 * Why a discovered URL was not enqueued.
 *
 *   locale        a non-English locale variant
 *   invalid       not a fetchable http(s) URL
 *   depth         beyond the profile's maxDepth
 *   share         the editorial share was met
 *   section       its section quota was full
 *   directoryCap  its directory hit the off-sitemap other-tier cap
 *   TrapRule      a listing view, not a page
 */
export type RefusalRule =
  | 'locale'
  | 'invalid'
  | 'depth'
  | 'share'
  | 'section'
  | 'directoryCap'
  | TrapRule;

const REFUSAL_RULES: readonly RefusalRule[] = [
  'locale',
  'invalid',
  'depth',
  'share',
  'section',
  'directoryCap',
  'pagination',
  'facet',
  'search',
  'calendar',
];

type Entry =
  | { url: string; offSitemap: boolean; state: 'enqueued'; source: DiscoverySource }
  | { url: string; offSitemap: boolean; state: 'refused'; rule: RefusalRule; section: string };

export type DiscoveryReport = {
  /** Distinct URLs offered for enqueue, from any source. */
  discovered: number;
  enqueued: {
    total: number;
    bySource: Record<DiscoverySource, number>;
  };
  /** Enqueued and handed to a handler: saved, rejected, failed or robots-skipped. */
  fetched: number;
  /**
   * Enqueued and never handled. The budget ran out, the run stopped early, or the queue collapsed
   * two URLs onto one key after a redirect alias was learned.
   */
  enqueuedNotFetched: number;
  /** The request budget the crawl ran with, and whether it was spent. */
  maxRequestsPerCrawl: number;
  budgetExhausted: boolean;
  /** Distinct URLs refused, by the rule that refused them last. */
  refused: Record<RefusalRule, number>;
  /** Links the sitemap did not list: admitted, and refused by any rule. */
  offSitemapAdmitted: number;
  offSitemapSuppressed: number;
  /** Enqueued URLs per quota section, and URLs refused because that section was full. */
  sectionAdmitted: Record<string, number>;
  sectionSuppressed: Record<string, number>;
  sitemap: {
    present: boolean;
    urls: number;
    /** The loader hit its URL or sitemap-file ceiling, so the map is incomplete. */
    truncated: boolean;
  };
};

export type DiscoveryLedger = {
  /** The entry's state for a comparison key, or undefined when the key is new. */
  stateOf(key: string): 'enqueued' | 'refused' | undefined;
  enqueue(key: string, url: string, source: DiscoverySource, offSitemap: boolean): void;
  /** Ignored when the key is already enqueued: a URL in the queue is never un-queued. */
  refuse(key: string, url: string, rule: RefusalRule, offSitemap: boolean): void;
  /** A request reached a handler. Keyed by the URL that was enqueued. */
  markFetched(url: string): void;
  setSitemap(present: boolean, urls: number, truncated: boolean): void;
  setBudget(maxRequestsPerCrawl: number): void;
  report(): DiscoveryReport;
};

function zeroRefusals(): Record<RefusalRule, number> {
  const out = {} as Record<RefusalRule, number>;
  for (const rule of REFUSAL_RULES) out[rule] = 0;
  return out;
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

export function createDiscoveryLedger(): DiscoveryLedger {
  const byKey = new Map<string, Entry>();
  const keyByUrl = new Map<string, string>();
  const fetchedKeys = new Set<string>();
  let sitemap = { present: false, urls: 0, truncated: false };
  let budget = 0;

  return {
    stateOf(key) {
      return byKey.get(key)?.state;
    },

    enqueue(key, url, source, offSitemap) {
      if (byKey.get(key)?.state === 'enqueued') return;
      byKey.set(key, { url, offSitemap, state: 'enqueued', source });
      keyByUrl.set(url, key);
    },

    refuse(key, url, rule, offSitemap) {
      if (byKey.get(key)?.state === 'enqueued') return;
      byKey.set(key, {
        url,
        offSitemap,
        state: 'refused',
        rule,
        section: rule === 'section' ? quotaKey(url) : '',
      });
    },

    markFetched(url) {
      const key = keyByUrl.get(url);
      if (key !== undefined) fetchedKeys.add(key);
    },

    setSitemap(present, urls, truncated) {
      sitemap = { present, urls, truncated };
    },

    setBudget(maxRequestsPerCrawl) {
      budget = maxRequestsPerCrawl;
    },

    report() {
      const bySource: Record<DiscoverySource, number> = { seed: 0, sitemap: 0, harvest: 0, link: 0 };
      const refused = zeroRefusals();
      const sectionAdmitted: Record<string, number> = {};
      const sectionSuppressed: Record<string, number> = {};
      let enqueued = 0;
      let offSitemapAdmitted = 0;
      let offSitemapSuppressed = 0;

      for (const entry of byKey.values()) {
        if (entry.state === 'enqueued') {
          enqueued += 1;
          bySource[entry.source] += 1;
          if (entry.offSitemap) offSitemapAdmitted += 1;
          const section = quotaKey(entry.url);
          if (section !== '') bump(sectionAdmitted, section);
        } else {
          refused[entry.rule] += 1;
          if (entry.offSitemap) offSitemapSuppressed += 1;
          if (entry.rule === 'section' && entry.section !== '') {
            bump(sectionSuppressed, entry.section);
          }
        }
      }

      let fetched = 0;
      for (const key of fetchedKeys) {
        if (byKey.get(key)?.state === 'enqueued') fetched += 1;
      }

      return {
        discovered: byKey.size,
        enqueued: { total: enqueued, bySource },
        fetched,
        enqueuedNotFetched: enqueued - fetched,
        maxRequestsPerCrawl: budget,
        budgetExhausted: budget > 0 && fetched >= budget,
        refused,
        offSitemapAdmitted,
        offSitemapSuppressed,
        sectionAdmitted,
        sectionSuppressed,
        sitemap: { ...sitemap },
      };
    },
  };
}
