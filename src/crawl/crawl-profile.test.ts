import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { crawlProfileFor, sectionQuotasFor } from './crawl-profile.js';
import { CrawlTypes, type CrawlType } from './types.js';
import { MAX_PAGES_PER_SITE } from './crawl-limits.js';

const ALL = Object.values(CrawlTypes) as CrawlType[];

describe('crawlProfileFor', () => {
  it('gives partner, competitors and local one identical profile', () => {
    // Reversed deliberately on 2026-09-30. The previous rule was that each type must be configured
    // for its own purpose, because an earlier version had collapsed them behind a ternary by
    // accident. Jeff: "All three Content Types are to be the same across the board. No thin slices."
    // A competitor is a partner you are not affiliated with, so it gets a partner's crawl.
    //
    // Composition is controlled by EDITORIAL_SHARE now, not by shrinking a type's page budget.
    const third = [CrawlTypes.Partner, CrawlTypes.Competitors, CrawlTypes.Local].map((t) =>
      JSON.stringify(crawlProfileFor(t)),
    );
    assert.equal(new Set(third).size, 1, 'the three third-party types must share one profile');
  });

  it('still refuses to let project-site inherit the third-party profile', () => {
    // The structural guarantee survives the collapse: sharing a value is deliberate, inheriting one
    // by accident is what the Record-with-no-fallback exists to prevent.
    assert.notEqual(
      JSON.stringify(crawlProfileFor(CrawlTypes.ProjectSite)),
      JSON.stringify(crawlProfileFor(CrawlTypes.Partner)),
    );
  });

  it('disables section quotas for project-site only', () => {
    assert.equal(sectionQuotasFor(CrawlTypes.ProjectSite), null);
    for (const t of [CrawlTypes.Partner, CrawlTypes.Competitors, CrawlTypes.Local]) {
      const limits = sectionQuotasFor(t);
      assert.ok(limits, `${t} must keep quotas`);
      // /tools is evidence on any site — operator-set to 100.
      assert.equal(limits.get('tools'), 100);
    }
  });

  it('budgets competitors and local exactly like partner', () => {
    // Was: "thin slice, must not be budgeted like partner evidence". The 150 and 100 were marked
    // PROPOSED pending operator confirmation and were never confirmed; this is the confirmation,
    // in the other direction.
    const partner = crawlProfileFor(CrawlTypes.Partner).defaultMaxPages;
    for (const t of [CrawlTypes.Competitors, CrawlTypes.Local]) {
      assert.equal(crawlProfileFor(t).defaultMaxPages, partner, `${t} must match partner`);
    }
  });

  it('leaves depth unlimited where the whole site is the point', () => {
    // project-site means the whole of your own site. A depth cap truncated it to 24% on a real
    // site, because depth is link hops from the seed rather than path segments.
    assert.equal(crawlProfileFor(CrawlTypes.ProjectSite).maxDepth, null);
    assert.equal(crawlProfileFor(CrawlTypes.Partner).maxDepth, null);
  });

  it('caps depth on no crawl type', () => {
    // maxDepth counts link hops from the seed, not path segments, so a cap of 2 dropped exactly the
    // nested product pages this work exists to reach -- /solutions/category/product is three hops
    // behind a nav. The page budget is the guardrail; depth was never the right one.
    for (const t of ALL) {
      assert.equal(crawlProfileFor(t).maxDepth, null, `${t} must not cap depth`);
    }
  });

  it('never proposes a budget above the per-site cap', () => {
    for (const t of ALL) {
      assert.ok(crawlProfileFor(t).defaultMaxPages <= MAX_PAGES_PER_SITE, `${t} exceeds the cap`);
    }
  });

  it('refuses an unknown crawl type rather than inheriting a profile', () => {
    assert.throws(() => crawlProfileFor('made-up' as CrawlType), /No crawl profile/);
  });
});
