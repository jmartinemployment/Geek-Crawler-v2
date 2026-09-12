/**
 * The persist-time / enqueue dedup key helpers.
 * Run: npx tsx --test src/crawl/url-dedup.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { crawlDedupKey } from './dedup.js';
import { normalizeCrawlUrl } from './sitemap.js';

/** Mirrors enqueue+handler comparison key (default, non-aggressive). */
function dedupKey(finalUrl: string): string {
  return crawlDedupKey(finalUrl) ?? finalUrl;
}

describe('final-url dedup key', () => {
  it('collapses tracking-param variants of the same page', () => {
    const a = dedupKey('https://n8n.io/integrations/set/?utm_source=x');
    const b = dedupKey('https://n8n.io/integrations/set/?utm_source=y');
    const c = dedupKey('https://n8n.io/integrations/set/');
    assert.equal(a, b);
    assert.equal(a, c);
  });

  it('collapses fragment-only variants', () => {
    assert.equal(
      dedupKey('https://n8n.io/integrations/set/#params'),
      dedupKey('https://n8n.io/integrations/set/'),
    );
  });

  it('keeps genuinely different pages apart', () => {
    assert.notEqual(
      dedupKey('https://n8n.io/integrations/set/'),
      dedupKey('https://n8n.io/integrations/webhook/'),
    );
  });

  it('simulates the n8n case: six requests, one comparison key', () => {
    const requests = [
      'https://n8n.io/integrations/set/',
      'https://n8n.io/integrations/set/?utm_source=a',
      'https://n8n.io/integrations/set/?utm_campaign=b',
      'https://n8n.io/integrations/set/#top',
      'https://n8n.io/integrations/set/?gclid=c',
      'https://n8n.io/integrations/set/',
    ];
    const saved = new Set<string>();
    let skipped = 0;
    for (const r of requests) {
      const k = dedupKey(r);
      if (saved.has(k)) {
        skipped += 1;
        continue;
      }
      saved.add(k);
    }
    assert.equal(saved.size, 1, 'should store one row');
    assert.equal(skipped, 5, 'should skip the other five');
  });

  it('filter key is never the fetch URL when aggressive would rewrite host', () => {
    const fetchable = normalizeCrawlUrl('https://www.example.com/path/?utm_source=x');
    const compare = crawlDedupKey('https://www.example.com/path/?utm_source=x', {
      aggressive: true,
    });
    assert.ok(fetchable);
    assert.ok(compare);
    // Fetchable keeps www; aggressive compare drops www — must not be requested.
    assert.notEqual(fetchable, compare);
    assert.match(fetchable!, /www\.example\.com/);
  });
});

describe('oversized page truncation is visible', () => {
  it('flags truncated markdown and leaves normal pages unflagged', async () => {
    const { extractCleanContent } = await import('./extract-content.js');

    const big = '<html><body><article>' + 'word '.repeat(200_000) + '</article></body></html>';
    const bigResult = extractCleanContent(big, 'https://n8n.io/integrations/set/');
    assert.equal(bigResult.truncated, true, 'oversized page must report truncation');
    assert.ok((bigResult.markdown ?? '').length <= 500_000);

    const small =
      '<html><body><article><h1>Hi</h1><p>Short article body here.</p></article></body></html>';
    const smallResult = extractCleanContent(small, 'https://n8n.io/a/');
    assert.equal(smallResult.truncated, false, 'normal page must not be flagged');
  });
});
