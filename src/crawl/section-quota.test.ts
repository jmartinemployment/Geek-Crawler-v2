import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_SECTION_QUOTAS,
  createSectionQuota,
  parseSectionQuotas,
  quotaKey,
  resolveSectionQuotas,
  sectionKey,
} from './section-quota.js';

describe('sectionKey — reporting only, no longer the quota key', () => {
  it('returns the lowercased first path segment', () => {
    assert.equal(sectionKey('https://x.com/Templates/abc'), 'templates');
    assert.equal(sectionKey('https://x.com/blog/2024/post/'), 'blog');
    assert.equal(sectionKey('https://x.com/blog?a=1'), 'blog');
  });

  it('returns empty for root and unparseable URLs', () => {
    assert.equal(sectionKey('https://x.com/'), '');
    assert.equal(sectionKey('https://x.com'), '');
    assert.equal(sectionKey('not a url'), '');
  });
});

describe('quotaKey — the section is the leftmost MATCHING segment', () => {
  it('resolves the canonical name, not the matched segment', () => {
    // company-blog and blog share one 250 budget rather than each getting its own.
    assert.equal(quotaKey('https://x.com/company-blog/a-post'), 'blog');
    assert.equal(quotaKey('https://x.com/blog/a-post'), 'blog');
    assert.equal(quotaKey('https://x.com/security-blog/a-post'), 'blog');
    assert.equal(quotaKey('https://x.com/case-study/acme'), 'case-studies');
    assert.equal(quotaKey('https://x.com/case-studies/acme'), 'case-studies');
    assert.equal(quotaKey('https://x.com/press-releases/x'), 'press');
  });

  it('sees past a locale prefix — the avalara.com case', () => {
    // The whole site is served under /us/en/, so segment one is the locale. Keying on segment one
    // resolved every URL to `us`, which has no entry, so every cap in the table was dead for the
    // entire site and 475 of 572 pages were county rate tables.
    assert.equal(
      quotaKey('https://www.avalara.com/us/en/taxrates/state-rates/alabama/counties/mobile-county.html'),
      'tax-rates',
    );
    assert.equal(quotaKey('https://www.avalara.com/us/en/blog/2026/01/post.html'), 'blog');
    assert.equal(quotaKey('https://www.avalara.com/us/en/learn/guides/paper.html'), 'learn');
    assert.equal(quotaKey('https://shop.example.com/en-gb/templates/invoice'), 'templates');
  });

  it('takes the LEFTMOST match, so the outer section owns the page', () => {
    // /blog/category/accounting is a blog archive, not an archive that happens to be under a blog.
    assert.equal(quotaKey('https://x.com/blog/category/accounting'), 'blog');
    assert.equal(quotaKey('https://x.com/category/accounting'), 'archive');
  });

  it('matches archive segments ONLY at position 0', () => {
    // archive carries quota 0, so matching `category` at depth would have excluded product
    // taxonomy outright. classify-path.ts draws the same line for the same URLs.
    assert.equal(quotaKey('https://x.com/solutions/category/enterprise'), '');
    assert.equal(quotaKey('https://x.com/products/tags/erp'), '');
    assert.equal(quotaKey('https://x.com/platform/topics/compliance'), '');
    // Still excluded when it really is the site's archive.
    assert.equal(quotaKey('https://x.com/tags/erp'), 'archive');
    assert.equal(quotaKey('https://x.com/author/jane'), 'archive');
  });

  it('returns empty when no segment matches, leaving the URL uncapped', () => {
    assert.equal(quotaKey('https://x.com/'), '');
    assert.equal(quotaKey('https://x.com/pricing'), '');
    assert.equal(quotaKey('https://x.com/solutions/erp'), '');
    assert.equal(quotaKey('not a url'), '');
  });

  it('does not cap product evidence', () => {
    // integrations / alternatives / vs were dropped from the defaults: classify-path calls all of
    // them PRODUCT, and any-segment matching would have throttled exactly the comparison evidence
    // these crawls exist to collect.
    assert.equal(DEFAULT_SECTION_QUOTAS.has('integrations'), false);
    assert.equal(DEFAULT_SECTION_QUOTAS.has('alternatives'), false);
    assert.equal(DEFAULT_SECTION_QUOTAS.has('vs'), false);
    assert.equal(quotaKey('https://x.com/solutions/integrations/netsuite'), '');
    assert.equal(quotaKey('https://x.com/alternatives/bill-com'), '');
  });
});

describe('createSectionQuota — a generated rate-table farm cannot take the budget', () => {
  it('caps avalara county pages at the tax-rates quota', () => {
    const q = createSectionQuota(resolveSectionQuotas(undefined));
    const counties = ['mobile', 'baldwin', 'shelby', 'madison', 'jefferson'];
    let admitted = 0;
    for (let i = 0; i < 200; i++) {
      const county = `${counties[i % counties.length]}-${i}`;
      const url = `https://www.avalara.com/us/en/taxrates/state-rates/alabama/counties/${county}.html`;
      if (q.admit(url)) admitted++;
    }
    assert.equal(admitted, DEFAULT_SECTION_QUOTAS.get('tax-rates'));
    assert.equal(q.suppressedBySection().get('tax-rates'), 200 - admitted);
  });

  it('excludes locality index pages entirely', () => {
    const q = createSectionQuota(resolveSectionQuotas(undefined));
    assert.equal(q.admit('https://www.avalara.com/us/en/counties/alabama'), false);
    assert.equal(q.admit('https://www.avalara.com/us/en/zip-codes/36601'), false);
  });

  it('still admits the same site\'s real pages', () => {
    const q = createSectionQuota(resolveSectionQuotas(undefined));
    assert.equal(q.admit('https://www.avalara.com/us/en/index.html'), true);
    assert.equal(q.admit('https://www.avalara.com/us/en/products/sales-tax.html'), true);
    assert.equal(q.admit('https://www.avalara.com/us/en/solutions/ecommerce.html'), true);
  });
});

describe('parseSectionQuotas', () => {
  it('parses name:value pairs and ignores malformed entries', () => {
    const m = parseSectionQuotas('blog:500, templates:0,bad,nope:x,neg:-4');
    assert.equal(m.get('blog'), 500);
    assert.equal(m.get('templates'), 0);
    assert.equal(m.has('bad'), false);
    assert.equal(m.has('nope'), false);
    assert.equal(m.has('neg'), false);
  });

  it('never throws on empty or undefined input', () => {
    assert.equal(parseSectionQuotas(undefined).size, 0);
    assert.equal(parseSectionQuotas('').size, 0);
  });
});

describe('resolveSectionQuotas', () => {
  it('overrides defaults per section and keeps the rest', () => {
    const m = resolveSectionQuotas('blog:1000');
    assert.equal(m.get('blog'), 1000);
    assert.equal(m.get('templates'), DEFAULT_SECTION_QUOTAS.get('templates'));
    assert.equal(m.get('tax-rates'), DEFAULT_SECTION_QUOTAS.get('tax-rates'));
  });
});

describe('createSectionQuota', () => {
  it('admits up to the limit then suppresses', () => {
    const q = createSectionQuota(new Map([['blog', 2]]));
    assert.equal(q.admit('https://x.com/blog/a'), true);
    assert.equal(q.admit('https://x.com/blog/b'), true);
    assert.equal(q.admit('https://x.com/blog/c'), false);
    assert.equal(q.totalSuppressed(), 1);
    assert.equal(q.suppressedBySection().get('blog'), 1);
    assert.equal(q.admittedBySection().get('blog'), 2);
  });

  it('treats a quota of 0 as full exclusion', () => {
    const q = createSectionQuota(new Map([['events', 0]]));
    assert.equal(q.admit('https://x.com/events/x'), false);
    assert.equal(q.totalSuppressed(), 1);
  });

  it('leaves unnamed sections uncapped', () => {
    const q = createSectionQuota(new Map([['blog', 1]]));
    for (let i = 0; i < 50; i++) {
      assert.equal(q.admit(`https://x.com/features/${i}`), true);
    }
    assert.equal(q.totalSuppressed(), 0);
  });

  it('counts sections independently', () => {
    const q = createSectionQuota(new Map([['blog', 1], ['templates', 1]]));
    assert.equal(q.admit('https://x.com/blog/a'), true);
    assert.equal(q.admit('https://x.com/templates/a'), true);
    assert.equal(q.admit('https://x.com/blog/b'), false);
    assert.equal(q.admit('https://x.com/templates/b'), false);
    assert.equal(q.totalSuppressed(), 2);
  });
});

describe('createSectionQuota — admission is idempotent per url', () => {
  it('counts a url once however many times it is offered', () => {
    // A url arrives twice: from the sitemap, then again as a link from a crawled page. Counting it
    // twice inflates the non-editorial total and the editorial share is derived from that total.
    const q = createSectionQuota(new Map());
    for (let i = 0; i < 10; i++) assert.equal(q.admit('https://x.com/pricing'), true);
    assert.equal(q.admittedByTier().product, 1);
  });

  it('does not let re-encounters buy extra editorial slots', () => {
    // lightyear.cloud: 20 non-editorial in the sitemap permits 5 editorial. Re-offering those 20
    // took it to 25 admitted blog posts against 19 product pages.
    const q = createSectionQuota(new Map());
    for (let i = 0; i < 20; i++) q.admit(`https://x.com/pricing/${i}`);
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 20; i++) q.admit(`https://x.com/pricing/${i}`);
    }
    let editorial = 0;
    for (let i = 0; i < 100; i++) if (q.admit(`https://x.com/blog/post-${i}`)) editorial++;
    assert.equal(editorial, 5, 'allowance must follow distinct non-editorial pages, not offers');
  });
});
