import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_SECTION_QUOTAS,
  createSectionQuota,
  parseSectionQuotas,
  resolveSectionQuotas,
  sectionKey,
} from './section-quota.js';

describe('sectionKey', () => {
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
