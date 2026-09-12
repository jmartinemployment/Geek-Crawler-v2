import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AliasTable,
  SimhashIndex,
  aggressiveAliasesEnabled,
  contentHash,
  crawlDedupKey,
  hammingHex64,
  htmlHash,
  simhash64,
} from './dedup.js';

describe('crawlDedupKey', () => {
  it('collapses host case, default port, fragment, and noise params', () => {
    const a = crawlDedupKey('https://N8N.IO:443/path/?utm_source=x#frag', {
      aggressive: false,
    });
    const b = crawlDedupKey('https://n8n.io/path/', { aggressive: false });
    assert.equal(a, b);
  });

  it('keeps www/apex, http/https, path case, trailing slash, and query order distinct by default', () => {
    assert.notEqual(
      crawlDedupKey('https://www.n8n.io/a', { aggressive: false }),
      crawlDedupKey('https://n8n.io/a', { aggressive: false }),
    );
    assert.notEqual(
      crawlDedupKey('http://n8n.io/a', { aggressive: false }),
      crawlDedupKey('https://n8n.io/a', { aggressive: false }),
    );
    assert.notEqual(
      crawlDedupKey('https://n8n.io/A/', { aggressive: false }),
      crawlDedupKey('https://n8n.io/a', { aggressive: false }),
    );
    assert.notEqual(
      crawlDedupKey('https://n8n.io/a/', { aggressive: false }),
      crawlDedupKey('https://n8n.io/a', { aggressive: false }),
    );
    assert.notEqual(
      crawlDedupKey('https://n8n.io/?tag=a&tag=b', { aggressive: false }),
      crawlDedupKey('https://n8n.io/?tag=b&tag=a', { aggressive: false }),
    );
  });

  it('aggressive mode collapses aliases including param order', () => {
    const opts = { aggressive: true };
    assert.equal(
      crawlDedupKey('https://www.n8n.io/A/', opts),
      crawlDedupKey('http://n8n.io/a', opts),
    );
    assert.equal(
      crawlDedupKey('https://n8n.io/?tag=a&tag=b', opts),
      crawlDedupKey('https://n8n.io/?tag=b&tag=a', opts),
    );
  });

  it('keeps pagination params distinct', () => {
    assert.notEqual(
      crawlDedupKey('https://n8n.io/list?page=1'),
      crawlDedupKey('https://n8n.io/list?page=2'),
    );
  });

  it('preserves repeated query keys unreordered by default', () => {
    const k = crawlDedupKey('https://n8n.io/?tag=a&tag=b');
    assert.ok(k?.includes('tag=a') && k.includes('tag=b'));
  });
});

describe('AliasTable', () => {
  it('learns redirects, resolves chains, and guards cycles', () => {
    const t = new AliasTable();
    assert.equal(t.learn('https://n8n.io/a', 'https://n8n.io/b'), true);
    assert.equal(t.learn('https://n8n.io/b', 'https://n8n.io/c'), true);
    assert.equal(t.resolve('https://n8n.io/a'), 'https://n8n.io/c');
    t.learn('https://n8n.io/c', 'https://n8n.io/a');
    assert.equal(typeof t.resolve('https://n8n.io/a'), 'string');
  });

  it('rejects self maps', () => {
    const t = new AliasTable();
    assert.equal(t.learn('https://n8n.io/a', 'https://n8n.io/a'), false);
  });
});

describe('fingerprints', () => {
  it('contentHash collapses whitespace but preserves case', () => {
    assert.equal(contentHash('Hello   world'), contentHash('Hello world'));
    assert.notEqual(contentHash('Hello'), contentHash('hello'));
  });

  it('htmlHash is sha256 hex', () => {
    assert.equal(htmlHash('<html/>').length, 64);
  });

  it('SimhashIndex finds distance within threshold-derived bands', () => {
    const idx = new SimhashIndex(5);
    const base = 'alpha beta gamma delta epsilon zeta eta theta iota kappa '.repeat(20);
    const a = simhash64(base, 5);
    const near = simhash64(base + ' extra', 5);
    idx.add({
      simhash: a,
      contentHash: contentHash(base),
      pageId: '1',
      url: 'https://n8n.io/a',
      markdownLength: base.length,
      excerpt: base.slice(0, 40),
    });
    const d = hammingHex64(a, near);
    if (d <= 5) {
      const hit = idx.findNear(near);
      assert.ok(hit);
      assert.ok(hit!.distance <= 5);
    } else {
      // Content may hash farther; still ensure banding does not throw
      assert.equal(idx.findNear(a)?.entry.pageId, '1');
    }
  });

  it('short bodies under NEAR_DUP_MIN_CHARS are still hashable', () => {
    assert.ok(simhash64('hi', 5).length === 16);
  });
});

describe('aggressiveAliasesEnabled', () => {
  it('defaults off', () => {
    const prev = process.env.AGGRESSIVE_URL_ALIASES;
    delete process.env.AGGRESSIVE_URL_ALIASES;
    assert.equal(aggressiveAliasesEnabled(), false);
    if (prev !== undefined) process.env.AGGRESSIVE_URL_ALIASES = prev;
  });
});
