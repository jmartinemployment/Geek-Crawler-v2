/**
 * Same-site scope must anchor to the seed, not the post-redirect page URL.
 * Run: npx tsx --test src/crawl/links-scope.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractHrefs, isSameSite, sameOriginUrls } from './links.js';

/** Minimal cheerio stand-in: $('a[href]').each(cb) over fixed hrefs. */
function fakeCheerio(hrefs: string[]) {
  const $ = ((el: unknown) => ({
    attr: (_name: string) => el as string,
  })) as never as (sel: unknown) => {
    each: (cb: (i: number, el: unknown) => void) => void;
    attr: (n: string) => string | undefined;
  };
  const fn = (sel: unknown) => {
    if (sel === 'a[href]') {
      return {
        each: (cb: (i: number, el: unknown) => void) => {
          hrefs.forEach((h, i) => cb(i, h));
        },
        attr: () => undefined,
      };
    }
    return { each: () => {}, attr: () => sel as string };
  };
  return fn as never;
}

describe('crawl scope anchoring', () => {
  it('drops off-host links when the page was reached via an off-host redirect', () => {
    // Seed is leadsquared; a redirect landed us on forbesindia.
    const landed = 'https://www.forbesindia.com/article/x';
    const links = extractHrefs(
      fakeCheerio([
        'https://www.forbesindia.com/article/y',
        'https://m.youtube.com/watch?v=1',
      ]),
      landed,
      'https://www.leadsquared.com/us/',
    );
    assert.equal(sameOriginUrls(links).length, 0, 'off-seed links must not enqueue');
  });

  it('without a scope it adopts the landing host — the old behaviour', () => {
    const landed = 'https://www.forbesindia.com/article/x';
    const links = extractHrefs(
      fakeCheerio(['https://www.forbesindia.com/article/y']),
      landed,
    );
    assert.equal(sameOriginUrls(links).length, 1, 'documents the drift this fixes');
  });

  it('still follows the seed host, and tolerates www redirects', () => {
    const links = extractHrefs(
      fakeCheerio(['https://www.leadsquared.com/us/sales/']),
      'https://leadsquared.com/us/',
      'https://www.leadsquared.com/us/',
    );
    assert.equal(sameOriginUrls(links).length, 1);
    assert.equal(isSameSite('https://make.com/a', 'https://www.make.com/b'), true);
  });

  it('falls back to pageUrl when scopeUrl is unparseable', () => {
    const links = extractHrefs(
      fakeCheerio(['https://n8n.io/b']),
      'https://n8n.io/a',
      'not-a-url',
    );
    assert.equal(sameOriginUrls(links).length, 1);
  });
});
