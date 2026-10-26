/**
 * Unit tests for unusable-page reject taxonomy.
 * Run: npx tsx --test src/crawl/reject.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyReject,
  isOnSite,
  emptyRejectCounters,
  bumpRejectCounter,
  RejectSampleLog,
  isExtractEmptyText,
  rejectStatsHostProgressEntry,
  REJECT_STATS_ORIGIN,
  sanitizeRejectDetail,
} from './reject.js';

describe('classifyReject', () => {
  // Moosend's partner crawl of 2026-10-25: `/go/active-campaign-free-trial/` landed on
  // activecampaign.com and was saved as a Moosend page; the index stamped it with the host it
  // landed on and answered Moosend's run for activecampaign.com, which had no crawl of its own.
  it('rejects a page that redirected to another site, before anything else about it is read', () => {
    assert.equal(
      classifyReject({
        finalUrl: 'https://www.activecampaign.com/pricing',
        scopeUrl: 'https://moosend.com',
        text: 'A'.repeat(500),
      }),
      'off_site_redirect',
    );
    // A subdomain is another site, as it is for a link (links.ts isSameSite).
    assert.equal(
      classifyReject({ finalUrl: 'https://identity.moosend.com/login', scopeUrl: 'https://moosend.com' }),
      'off_site_redirect',
    );
    // Off site wins over a locale or legal path on the other site: it is not this crawl's to classify.
    assert.equal(
      classifyReject({ finalUrl: 'https://www.activecampaign.com/fr/legal/', scopeUrl: 'https://moosend.com' }),
      'off_site_redirect',
    );
  });

  it('a redirect that stays on the site is not off site: www and bare are one site, scheme is ignored', () => {
    assert.equal(classifyReject({ finalUrl: 'https://www.make.com/en/pricing', scopeUrl: 'http://make.com' }), null);
    assert.equal(classifyReject({ finalUrl: 'https://make.com/pricing', scopeUrl: 'https://www.make.com/' }), null);
  });

  it('without a scope URL nothing is judged off site, as every caller before 2026-10-26', () => {
    assert.equal(classifyReject({ finalUrl: 'https://www.activecampaign.com/pricing', text: 'A'.repeat(500) }), null);
  });

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
      classifyReject({ finalUrl: 'https://example.com/us/docs', text: 'Enough prose content here for the corpus to accept it' }),
      null,
    );
    assert.equal(
      classifyReject({
        finalUrl: 'https://example.com/docs',
        text: 'Enough prose content here for the corpus to accept it',
      }),
      null,
    );
  });

  it('rejects challenge_page from viability', () => {
    assert.equal(
      classifyReject({
        finalUrl: 'https://example.com/',
        viabilityReason: 'challenge_page',
        text: '# ignored',
      }),
      'challenge_page',
    );
  });

  it('rejects extract_empty when prose blank', () => {
    assert.equal(
      classifyReject({ finalUrl: 'https://example.com/login', text: null }),
      'extract_empty',
    );
    assert.equal(
      classifyReject({ finalUrl: 'https://example.com/login', text: '   ' }),
      'extract_empty',
    );
  });

  it('locale wins over extract_empty', () => {
    assert.equal(
      classifyReject({ finalUrl: 'https://example.com/gb/x', text: null }),
      'locale_excluded',
    );
  });
});

describe('isExtractEmptyText', () => {
  it('treats short prose as empty', () => {
    assert.equal(isExtractEmptyText('hi'), true);
    assert.equal(
      isExtractEmptyText('Long enough prose body for a real page extract'),
      false,
    );
  });
});

describe('rejectStatsHostProgressEntry', () => {
  it('uses synthetic origin for GeekAPI hostProgressJson', () => {
    const entry = rejectStatsHostProgressEntry(
      {
        pagesRejectedLocale: 1,
        pagesRejectedNonContent: 0, pagesRejectedOffSite: 0,
        pagesRejectedRequiresJavascript: 6,
        pagesRejectedChallenge: 2,
        pagesRejectedExtractEmpty: 3,
        pagesRejectedExtractFailed: 7,
        pagesRejectedRobots: 4,
        pagesRejectedRequestFailed: 5,
      },
      9,
    );
    assert.equal(entry.origin, REJECT_STATS_ORIGIN);
    assert.equal(entry.pagesRejectedChallenge, 2);
    assert.equal(entry.pagesRejectedRobots, 4);
    assert.equal(entry.pagesRejectedExtractFailed, 7);
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

  it('counts an extractor crash apart from a page with no prose', () => {
    const counters = emptyRejectCounters();
    bumpRejectCounter(counters, 'extract_failed');
    assert.equal(counters.pagesRejectedExtractFailed, 1);
    assert.equal(counters.pagesRejectedExtractEmpty, 0);
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

describe('isOnSite', () => {
  it('compares hosts with www set aside and ignores scheme and path', () => {
    assert.equal(isOnSite('https://moosend.com', 'https://moosend.com/blog/x/'), true);
    assert.equal(isOnSite('https://moosend.com', 'https://www.moosend.com/'), true);
    assert.equal(isOnSite('http://moosend.com', 'https://moosend.com/'), true);
    assert.equal(isOnSite('https://moosend.com', 'https://www.activecampaign.com/'), false);
    assert.equal(isOnSite('https://moosend.com', 'https://identity.moosend.com/'), false);
  });

  it('a URL that does not parse is not on the site', () => {
    assert.equal(isOnSite('https://moosend.com', 'not a url'), false);
    assert.equal(isOnSite('not a url', 'https://moosend.com/'), false);
  });
});

describe('off_site_redirect is counted and reported', () => {
  it('bumps its own counter and the host-progress entry carries it', () => {
    const counters = emptyRejectCounters();
    bumpRejectCounter(counters, 'off_site_redirect');
    bumpRejectCounter(counters, 'off_site_redirect');
    assert.equal(counters.pagesRejectedOffSite, 2);
    assert.equal(counters.pagesRejectedNonContent, 0);
    const entry = rejectStatsHostProgressEntry(counters, 10);
    assert.equal(entry.pagesRejectedOffSite, 2);
  });
});

