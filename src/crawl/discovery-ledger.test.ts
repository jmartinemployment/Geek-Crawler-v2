import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDiscoveryLedger, type DiscoveryReport } from './discovery-ledger.js';

function refusedTotal(report: DiscoveryReport): number {
  return Object.values(report.refused).reduce((a, b) => a + b, 0);
}

describe('createDiscoveryLedger — every discovered URL, counted once', () => {
  it('balances: discovered = enqueued + refused, enqueued = fetched + not fetched', () => {
    const ledger = createDiscoveryLedger();
    ledger.enqueue('k1', 'https://x.com/', 'seed', false);
    ledger.enqueue('k2', 'https://x.com/pricing', 'sitemap', false);
    ledger.enqueue('k3', 'https://x.com/products', 'link', true);
    ledger.refuse('k4', 'https://x.com/blog?page=2', 'pagination', true);
    ledger.refuse('k5', 'https://x.com/blog/a', 'share', false);
    ledger.markFetched('https://x.com/');
    ledger.markFetched('https://x.com/products');

    const r = ledger.report();
    assert.equal(r.discovered, 5);
    assert.equal(r.discovered, r.enqueued.total + refusedTotal(r));
    assert.equal(r.enqueued.total, r.fetched + r.enqueuedNotFetched);
    assert.deepEqual(r.enqueued.bySource, { seed: 1, sitemap: 1, harvest: 0, link: 1 });
    assert.equal(r.fetched, 2);
    assert.equal(r.offSitemapAdmitted, 1);
    assert.equal(r.offSitemapSuppressed, 1);
  });

  it('counts a URL under the state it finished in, not every state it passed through', () => {
    const ledger = createDiscoveryLedger();
    ledger.refuse('k', 'https://x.com/blog/a', 'share', false);
    ledger.refuse('k', 'https://x.com/blog/a', 'share', false);
    ledger.enqueue('k', 'https://x.com/blog/a', 'link', false);
    const r = ledger.report();
    assert.equal(r.discovered, 1);
    assert.equal(r.refused.share, 0);
    assert.equal(r.enqueued.total, 1);
  });

  it('never un-queues a URL that is already enqueued', () => {
    const ledger = createDiscoveryLedger();
    ledger.enqueue('k', 'https://x.com/pricing', 'sitemap', false);
    ledger.refuse('k', 'https://x.com/pricing', 'depth', false);
    ledger.enqueue('k', 'https://x.com/pricing', 'link', true);
    const r = ledger.report();
    assert.equal(r.enqueued.bySource.sitemap, 1);
    assert.equal(r.enqueued.bySource.link, 0);
    assert.equal(r.refused.depth, 0);
    assert.equal(r.offSitemapAdmitted, 0);
  });

  it('ignores a fetch of a URL it never enqueued', () => {
    const ledger = createDiscoveryLedger();
    ledger.markFetched('https://x.com/unknown');
    assert.equal(ledger.report().fetched, 0);
  });

  it('groups enqueued and section-refused URLs by quota section', () => {
    const ledger = createDiscoveryLedger();
    ledger.enqueue('a', 'https://x.com/blog/a', 'sitemap', false);
    ledger.enqueue('b', 'https://x.com/company-blog/b', 'link', true);
    ledger.refuse('c', 'https://x.com/zip-codes/1', 'section', true);
    ledger.refuse('d', 'https://x.com/blog/d', 'share', false);
    const r = ledger.report();
    assert.deepEqual(r.sectionAdmitted, { blog: 2 });
    assert.deepEqual(r.sectionSuppressed, { 'zip-codes': 1 });
  });

  it('reports the budget as spent once fetches reach it', () => {
    const ledger = createDiscoveryLedger();
    ledger.setBudget(2);
    ledger.enqueue('a', 'https://x.com/a', 'seed', false);
    ledger.enqueue('b', 'https://x.com/b', 'link', false);
    ledger.enqueue('c', 'https://x.com/c', 'link', false);
    ledger.markFetched('https://x.com/a');
    assert.equal(ledger.report().budgetExhausted, false);
    ledger.markFetched('https://x.com/b');
    const r = ledger.report();
    assert.equal(r.budgetExhausted, true);
    assert.equal(r.maxRequestsPerCrawl, 2);
    assert.equal(r.enqueuedNotFetched, 1);
  });

  it('carries the sitemap as loaded', () => {
    const ledger = createDiscoveryLedger();
    ledger.setSitemap(true, 812, true);
    assert.deepEqual(ledger.report().sitemap, { present: true, urls: 812, truncated: true });
  });
});
