import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { crawlProfileFor, sectionQuotasFor } from './crawl-profile.js';
import { CrawlTypes } from './types.js';
import { MAX_PAGES_PER_SITE } from './crawl-limits.js';

describe('crawlProfileFor', () => {
  it('disables section quotas for project-site', () => {
    // Quotas exist to stop a third party's page farm eating the budget. On the operator's own
    // site they would starve /tools and /use-case*, which is where the heading hierarchy and the
    // partner anchors under it come from.
    assert.equal(crawlProfileFor(CrawlTypes.ProjectSite).sectionQuotas, null);
    assert.equal(sectionQuotasFor(CrawlTypes.ProjectSite), null);
  });

  it('keeps section quotas for third-party crawls', () => {
    for (const t of [CrawlTypes.Partner, CrawlTypes.Competitors, CrawlTypes.Local]) {
      assert.notEqual(crawlProfileFor(t).sectionQuotas, null, `${t} must keep quotas`);
      const limits = sectionQuotasFor(t);
      assert.ok(limits, `${t} must resolve a quota map`);
      // /tools is evidence on any site — 100, not the old 10 that starved it.
      assert.equal(limits.get('tools'), 100);
    }
  });

  it('caps depth for project-site only', () => {
    assert.equal(crawlProfileFor(CrawlTypes.ProjectSite).maxDepth, 3);
    assert.equal(crawlProfileFor(CrawlTypes.Partner).maxDepth, null);
  });

  it('never proposes a budget above the per-site cap', () => {
    for (const t of Object.values(CrawlTypes)) {
      assert.ok(
        crawlProfileFor(t).defaultMaxPages <= MAX_PAGES_PER_SITE,
        `${t} budget must respect MAX_PAGES_PER_SITE`,
      );
    }
  });
});
