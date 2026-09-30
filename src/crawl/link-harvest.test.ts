import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { STATIC_LINK_FLOOR, harvestLinks, needsBrowserDiscovery } from './link-harvest.js';

/**
 * The network cases are in tests/ (integration). These pin the decision logic and the failure
 * contract, which are what decide whether a browser runs at all and what happens when it cannot.
 */

describe('needsBrowserDiscovery', () => {
  it('never launches a browser when a sitemap exists', () => {
    // bill.com and medius.com: the map already is the url list, whatever the homepage links.
    assert.equal(needsBrowserDiscovery({ hasSiteMap: true, staticSameOriginLinks: 0 }), false);
    assert.equal(needsBrowserDiscovery({ hasSiteMap: true, staticSameOriginLinks: 6 }), false);
  });

  it('launches when there is no sitemap and the static HTML yields almost nothing', () => {
    // lightyear.cloud: sitemap.xml returns 500 and the homepage carries six static links, one of
    // them a stylesheet. "pricing", "features" and "industries" appear 8, 16 and 20 times in that
    // HTML and zero times inside an href.
    assert.equal(needsBrowserDiscovery({ hasSiteMap: false, staticSameOriginLinks: 6 }), true);
    assert.equal(needsBrowserDiscovery({ hasSiteMap: false, staticSameOriginLinks: 0 }), true);
  });

  it('does not launch for a site that exposes its links statically', () => {
    assert.equal(needsBrowserDiscovery({ hasSiteMap: false, staticSameOriginLinks: 345 }), false);
  });

  it('treats the floor as the boundary', () => {
    const at = { hasSiteMap: false, staticSameOriginLinks: STATIC_LINK_FLOOR };
    const below = { hasSiteMap: false, staticSameOriginLinks: STATIC_LINK_FLOOR - 1 };
    assert.equal(needsBrowserDiscovery(at), false);
    assert.equal(needsBrowserDiscovery(below), true);
  });
});

describe('harvestLinks — the failure contract', () => {
  it('reports a bad seed rather than throwing', () => {
    // The caller decides what a failure means. Throwing from here would make a malformed seed
    // indistinguishable from a browser that could not start.
    return harvestLinks('not-a-url').then((r) => {
      assert.equal(r.ok, false);
      if (!r.ok) assert.match(r.reason, /not a url/);
    });
  });

  it('reports rather than returning an empty list on failure', async () => {
    // The distinction that matters. { ok: true, urls: [] } would read as "this site has no links"
    // and the crawl would proceed on its six static urls and report complete -- the silent success
    // plans/rules §3a forbids. Unreachable host, one attempt, no retry.
    const r = await harvestLinks('https://this-host-does-not-resolve.invalid/', {
      timeoutMs: 5_000,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.reason.length > 0, 'a failure must carry a diagnosable reason');
  });
});
