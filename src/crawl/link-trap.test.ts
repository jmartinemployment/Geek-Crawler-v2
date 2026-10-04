import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDirectoryCap, directoryKey, trapRuleFor } from './link-trap.js';

describe('trapRuleFor — listing views, not pages', () => {
  it('refuses pagination by path and by numeric query', () => {
    assert.equal(trapRuleFor('https://x.com/blog/page/3'), 'pagination');
    assert.equal(trapRuleFor('https://x.com/page/2/'), 'pagination');
    assert.equal(trapRuleFor('https://x.com/blog?page=2'), 'pagination');
    assert.equal(trapRuleFor('https://x.com/news?offset=40'), 'pagination');
  });

  it('admits a page named page, and a WordPress post id', () => {
    assert.equal(trapRuleFor('https://x.com/page/about-us'), null);
    assert.equal(trapRuleFor('https://x.com/?p=123'), null);
    assert.equal(trapRuleFor('https://x.com/docs?page=intro'), null);
  });

  it('refuses facets, including bracketed keys and wide key combinations', () => {
    assert.equal(trapRuleFor('https://x.com/integrations?sort=name'), 'facet');
    assert.equal(trapRuleFor('https://x.com/templates?filter[type]=invoice'), 'facet');
    assert.equal(trapRuleFor('https://x.com/apps?a=1&b=2&c=3'), 'facet');
  });

  it('admits a page with one or two content query keys', () => {
    assert.equal(trapRuleFor('https://x.com/product?id=7'), null);
    assert.equal(trapRuleFor('https://x.com/product?id=7&variant=blue'), null);
  });

  it('refuses rooted search and search queries, not a feature page about search', () => {
    assert.equal(trapRuleFor('https://x.com/search/ap-automation'), 'search');
    assert.equal(trapRuleFor('https://x.com/resources?q=invoices'), 'search');
    assert.equal(trapRuleFor('https://x.com/?s=bill'), 'search');
    assert.equal(trapRuleFor('https://x.com/features/search'), null);
    assert.equal(trapRuleFor('https://x.com/glossary?term=accrual'), null);
  });

  it('refuses calendar cells and date archives, not dated articles', () => {
    assert.equal(trapRuleFor('https://x.com/events/2026-10-04'), 'calendar');
    assert.equal(trapRuleFor('https://x.com/blog/2024/05'), 'calendar');
    assert.equal(trapRuleFor('https://x.com/2026'), 'calendar');
    assert.equal(trapRuleFor('https://x.com/events?month=2026-11'), 'calendar');
    assert.equal(trapRuleFor('https://x.com/blog/2024/05/close-the-books'), null);
    assert.equal(trapRuleFor('https://x.com/blog/2026-10-04-launch-notes'), null);
    assert.equal(trapRuleFor('https://x.com/features/calendar'), null);
  });

  it('admits pages named for tax forms -- the accounting-site case', () => {
    assert.equal(trapRuleFor('https://x.com/1099'), null);
    assert.equal(trapRuleFor('https://x.com/resources/1096'), null);
  });

  it('is null for an unparseable url', () => {
    assert.equal(trapRuleFor('not a url'), null);
  });
});

describe('directoryKey', () => {
  it('is the lowercased first segment, or empty at the root', () => {
    assert.equal(directoryKey('https://x.com/Careers/job/1'), 'careers');
    assert.equal(directoryKey('https://x.com/'), '');
    assert.equal(directoryKey('nope'), '');
  });
});

describe('createDirectoryCap', () => {
  it('holds each directory to the cap, independently', () => {
    const cap = createDirectoryCap(2);
    for (const u of ['https://x.com/jobs/1', 'https://x.com/jobs/2']) {
      assert.equal(cap.hasRoom(u), true);
      cap.commit(u);
    }
    assert.equal(cap.hasRoom('https://x.com/jobs/3'), false);
    assert.equal(cap.hasRoom('https://x.com/team/a'), true);
  });

  it('charges a url once, and keeps room for a url already charged', () => {
    const cap = createDirectoryCap(1);
    cap.commit('https://x.com/jobs/1');
    cap.commit('https://x.com/jobs/1');
    assert.equal(cap.hasRoom('https://x.com/jobs/1'), true);
    assert.equal(cap.hasRoom('https://x.com/jobs/2'), false);
  });
});
