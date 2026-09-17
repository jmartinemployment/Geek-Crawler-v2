import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  bumpRejectCounter,
  emptyRejectCounters,
  RejectSampleLog,
} from '../crawl/reject.js';

/**
 * The crawler owns the reject taxonomy because it is the only component that sees each fetch.
 * These assert the shape GeekAPI now receives — specifically that policy exclusions and failures
 * stay on opposite sides of the line.
 */
describe('crawl report mapping', () => {
  it('keeps robots and locale out of the failure counts', () => {
    const counters = emptyRejectCounters();
    bumpRejectCounter(counters, 'robots_disallowed');
    bumpRejectCounter(counters, 'robots_disallowed');
    bumpRejectCounter(counters, 'locale_excluded');
    bumpRejectCounter(counters, 'request_failed');

    const excluded = counters.pagesRejectedRobots + counters.pagesRejectedLocale;
    const failed =
      counters.pagesRejectedRequestFailed +
      counters.pagesRejectedChallenge +
      counters.pagesRejectedExtractEmpty;

    // Three pages were declined on purpose; one actually failed. Collapsing these would report
    // four errors and make an obedient crawl look broken.
    assert.equal(excluded, 3);
    assert.equal(failed, 1);
  });

  it('counts challenge pages apart from request failures', () => {
    const counters = emptyRejectCounters();
    for (let i = 0; i < 40; i += 1) bumpRejectCounter(counters, 'challenge_page');
    bumpRejectCounter(counters, 'request_failed');

    // A wave of challenges means the crawl identity is being rejected; retrying cannot fix it.
    // Averaging it into request failures destroys the only signal that says so.
    assert.equal(counters.pagesRejectedChallenge, 40);
    assert.equal(counters.pagesRejectedRequestFailed, 1);
  });

  it('flattens samples so every one carries its reason', () => {
    const log = new RejectSampleLog();
    log.note('challenge_page', 'https://example.test/pricing', 'cf challenge');
    log.note('request_failed', 'https://example.test/about');

    const flattened = Object.entries(log.snapshot()).flatMap(([reason, entries]) =>
      entries.map((entry) => ({ reason, url: entry.url, detail: entry.detail })),
    );

    // A sample URL detached from its reason is not actionable.
    assert.equal(flattened.length, 2);
    assert.ok(flattened.every((s) => typeof s.reason === 'string' && s.reason.length > 0));
    assert.ok(flattened.some((s) => s.reason === 'challenge_page' && s.detail === 'cf challenge'));
  });
});
