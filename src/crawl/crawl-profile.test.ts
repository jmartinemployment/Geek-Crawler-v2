import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { crawlProfileFor, sectionQuotasFor } from './crawl-profile.js';
import { CrawlTypes, type CrawlType } from './types.js';
import { MAX_PAGES_PER_SITE } from './crawl-limits.js';

const ALL = Object.values(CrawlTypes) as CrawlType[];

describe('crawlProfileFor', () => {
  it('gives every crawl type its own configuration', () => {
    // The defect this guards: partner, competitors and local were collapsed into one shared
    // THIRD_PARTY profile behind a ternary, so competitors was budgeted like a partner despite
    // being a thin slice. Each type answers a different question and must be configured for it.
    const seen = new Map<string, CrawlType>();
    for (const t of ALL) {
      const key = JSON.stringify(crawlProfileFor(t));
      const clash = seen.get(key);
      assert.equal(
        clash,
        undefined,
        `${t} and ${clash} share an identical profile — configure ${t} for its own purpose`,
      );
      seen.set(key, t);
    }
    assert.equal(seen.size, ALL.length);
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

  it('budgets competitors and local far below partner', () => {
    const partner = crawlProfileFor(CrawlTypes.Partner).defaultMaxPages;
    for (const thin of [CrawlTypes.Competitors, CrawlTypes.Local]) {
      assert.ok(
        crawlProfileFor(thin).defaultMaxPages < partner,
        `${thin} is a thin slice and must not be budgeted like partner evidence`,
      );
    }
  });

  it('leaves depth unlimited where the whole site is the point', () => {
    // project-site means the whole of your own site. A depth cap truncated it to 24% on a real
    // site, because depth is link hops from the seed rather than path segments.
    assert.equal(crawlProfileFor(CrawlTypes.ProjectSite).maxDepth, null);
    assert.equal(crawlProfileFor(CrawlTypes.Partner).maxDepth, null);
  });

  it('keeps a depth cap on the thin third-party slices', () => {
    // These are deliberately shallow: a rival's positioning is a handful of pages, and geography
    // pages are few by nature. Depth is the scope policy for them, not a truncation.
    assert.equal(crawlProfileFor(CrawlTypes.Competitors).maxDepth, 2);
    assert.equal(crawlProfileFor(CrawlTypes.Local).maxDepth, 2);
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
