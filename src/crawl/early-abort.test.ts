/**
 * Early abort: a run that has produced nothing stops rather than crawling out
 * a site that will refuse every URL.
 * Run: npx tsx --test src/crawl/early-abort.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_ABORT_AFTER,
  abortAfterFromEnv,
  barrenAbortReason,
  barrenTotal,
  emptyBarrenTally,
  isBlockedStatus,
  shouldAbortRun,
} from './early-abort.js';

describe('shouldAbortRun', () => {
  it('lets one saved page veto the abort, however many rejects follow', () => {
    // The safety property, and the reason this is a veto rather than a ratio.
    // A real site with a handful of SPA routes or gated sections must never be
    // abandoned, so a single successful extraction disables this for good.
    assert.equal(
      shouldAbortRun({ savedAny: true, rejects: 10_000, abortAfter: 25 }),
      false,
    );
  });

  it('stops at the threshold and not before', () => {
    assert.equal(shouldAbortRun({ savedAny: false, rejects: 24, abortAfter: 25 }), false);
    assert.equal(shouldAbortRun({ savedAny: false, rejects: 25, abortAfter: 25 }), true);
    assert.equal(shouldAbortRun({ savedAny: false, rejects: 26, abortAfter: 25 }), true);
  });

  it('never fires on a run that has seen nothing at all', () => {
    assert.equal(shouldAbortRun({ savedAny: false, rejects: 0, abortAfter: 25 }), false);
  });
});

describe('abortAfterFromEnv', () => {
  it('defaults to 25 and honours an override', () => {
    assert.equal(abortAfterFromEnv('CRAWL_ABORT_AFTER', {}), DEFAULT_ABORT_AFTER);
    assert.equal(abortAfterFromEnv('CRAWL_ABORT_AFTER', { CRAWL_ABORT_AFTER: '5' }), 5);
  });

  it('falls back on nonsense rather than disabling the guard or firing instantly', () => {
    for (const value of ['abc', '0', '-3', '', ' ']) {
      assert.equal(
        abortAfterFromEnv('CRAWL_ABORT_AFTER', { CRAWL_ABORT_AFTER: value }),
        DEFAULT_ABORT_AFTER,
        `CRAWL_ABORT_AFTER=${JSON.stringify(value)}`,
      );
    }
  });

  it('floors a fractional override instead of rejecting it', () => {
    assert.equal(abortAfterFromEnv('CRAWL_ABORT_AFTER', { CRAWL_ABORT_AFTER: '7.9' }), 7);
  });
});

describe('BarrenTally', () => {
  it('reaches the threshold on a mixture no single kind would reach', () => {
    // The bug this replaced. Separate counters at 25 each let a site answering
    // part shell, part 403, part empty crawl out in full: 12 and 8 and 6 trips
    // nothing, while the site has plainly given the run nothing at all.
    const tally = { shells: 12, refused: 8, noProse: 6 };
    assert.equal(barrenTotal(tally), 26);
    assert.equal(
      shouldAbortRun({ savedAny: false, rejects: barrenTotal(tally), abortAfter: 25 }),
      true,
    );
  });

  it('starts empty', () => {
    assert.equal(barrenTotal(emptyBarrenTally()), 0);
  });

  it('names every kind that fired, and only those', () => {
    const mixed = barrenAbortReason({ shells: 12, refused: 8, noProse: 6 });
    assert.match(mixed, /26 pages/);
    assert.match(mixed, /12 returned a JavaScript shell/);
    assert.match(mixed, /8 were refused with a 401, 403, 429 or a challenge page/);
    assert.match(mixed, /6 parsed but carried no prose/);

    // A wall of shells and a wall of 403s need different answers from the
    // operator, so the sentence must not mention a kind that did not happen.
    const refusedOnly = barrenAbortReason({ shells: 0, refused: 25, noProse: 0 });
    assert.match(refusedOnly, /25 were refused/);
    assert.doesNotMatch(refusedOnly, /JavaScript shell/);
    assert.doesNotMatch(refusedOnly, /carried no prose/);
  });
});

describe('isBlockedStatus', () => {
  it('counts the codes that mean refused', () => {
    for (const code of [401, 403, 429]) {
      assert.equal(isBlockedStatus(code), true, `HTTP ${code}`);
    }
  });

  it('does not count a missing page or a broken one', () => {
    // A 404 or a 500 says nothing about whether the site will serve the rest of
    // its URLs, so neither may contribute to abandoning it.
    for (const code of [200, 301, 400, 404, 410, 451, 500, 502, 503]) {
      assert.equal(isBlockedStatus(code), false, `HTTP ${code}`);
    }
  });

  it('treats an absent status as not blocked', () => {
    // A transport failure leaves no response, and a DNS error or a timeout must
    // never be read as a refusal.
    assert.equal(isBlockedStatus(undefined), false);
  });
});
