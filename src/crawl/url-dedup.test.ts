/**
 * The persist-time dedup key: distinct request URLs that resolve to one page
 * must collapse to a single row. Run: npx tsx --test src/crawl/url-dedup.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeCrawlUrl } from './sitemap.js';

/** Mirrors the guard in persist.savePage. */
function dedupKey(finalUrl: string): string {
  return normalizeCrawlUrl(finalUrl) ?? finalUrl;
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

  it('simulates the n8n case: six requests, one row', () => {
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
});
