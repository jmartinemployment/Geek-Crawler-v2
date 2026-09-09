/**
 * Unit tests for unusable-page reject taxonomy.
 * Run: npx tsx --test src/crawl/reject.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyReject,
  emptyRejectCounters,
  bumpRejectCounter,
  RejectSampleLog,
  isExtractEmptyMarkdown,
  rejectStatsHostProgressEntry,
  REJECT_STATS_ORIGIN,
  sanitizeRejectDetail,
} from './reject.js';

describe('classifyReject', () => {
  it('rejects locale-excluded final URLs', () => {
    assert.equal(
      classifyReject({ finalUrl: 'https://example.com/fr/docs' }),
      'locale_excluded',
    );
    assert.equal(
      classifyReject({ finalUrl: 'https://example.com/de/product' }),
      'locale_excluded',
    );
  });

  it('keeps /us/ and bare paths for locale', () => {
    assert.equal(
      classifyReject({ finalUrl: 'https://example.com/us/docs', markdown: '# Enough markdown content here for corpus' }),
      null,
    );
    assert.equal(
      classifyReject({
        finalUrl: 'https://example.com/docs',
        markdown: '# Enough markdown content here for corpus',
      }),
      null,
    );
  });

  it('rejects challenge_page from viability', () => {
    assert.equal(
      classifyReject({
        finalUrl: 'https://example.com/',
        viabilityReason: 'challenge_page',
        markdown: '# ignored',
      }),
      'challenge_page',
    );
  });

  it('rejects extract_empty when markdown blank', () => {
    assert.equal(
      classifyReject({ finalUrl: 'https://example.com/login', markdown: null }),
      'extract_empty',
    );
    assert.equal(
      classifyReject({ finalUrl: 'https://example.com/login', markdown: '   ' }),
      'extract_empty',
    );
  });

  it('locale wins over extract_empty', () => {
    assert.equal(
      classifyReject({ finalUrl: 'https://example.com/gb/x', markdown: null }),
      'locale_excluded',
    );
  });
});

describe('isExtractEmptyMarkdown', () => {
  it('treats short markdown as empty', () => {
    assert.equal(isExtractEmptyMarkdown('hi'), true);
    assert.equal(
      isExtractEmptyMarkdown('# Long enough markdown body for a real page extract'),
      false,
    );
  });
});

describe('rejectStatsHostProgressEntry', () => {
  it('uses synthetic origin for GeekAPI hostProgressJson', () => {
    const entry = rejectStatsHostProgressEntry(
      {
        pagesRejectedLocale: 1,
        pagesRejectedChallenge: 2,
        pagesRejectedExtractEmpty: 3,
        pagesRejectedRobots: 4,
        pagesRejectedRequestFailed: 5,
      },
      9,
    );
    assert.equal(entry.origin, REJECT_STATS_ORIGIN);
    assert.equal(entry.pagesRejectedChallenge, 2);
    assert.equal(entry.pagesRejectedRobots, 4);
    assert.equal(entry.pagesRejectedRequestFailed, 5);
    assert.equal(entry.pagesSaved, 9);
  });
});

describe('failure rejection reporting', () => {
  it('counts robots and request failures without storing bodies', () => {
    const counters = emptyRejectCounters();
    bumpRejectCounter(counters, 'robots_disallowed');
    bumpRejectCounter(counters, 'request_failed');
    assert.equal(counters.pagesRejectedRobots, 1);
    assert.equal(counters.pagesRejectedRequestFailed, 1);
  });

  it('caps samples and removes URL secrets and error credentials', () => {
    const samples = new RejectSampleLog();
    const sample = samples.note(
      'request_failed',
      'https://user:secret@example.com/path?token=secret#fragment',
      'authorization: Bearer-secret\napi_key=hidden',
    );
    assert.equal(sample?.url, 'https://example.com/path');
    assert.doesNotMatch(sample?.detail ?? '', /Bearer-secret|hidden/);
    for (let index = 0; index < 5; index += 1) {
      samples.note('robots_disallowed', `https://example.com/${index}`);
    }
    assert.equal(
      samples.note('robots_disallowed', 'https://example.com/overflow'),
      null,
    );
  });

  it('sanitizes and bounds failure details', () => {
    const detail = sanitizeRejectDetail(`token=secret\n${'x'.repeat(400)}`);
    assert.ok(detail);
    assert.equal(detail!.length, 300);
    assert.doesNotMatch(detail!, /secret/);
  });
});
