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
    assert.equal(abortAfterFromEnv('JS_ONLY_ABORT_AFTER', {}), DEFAULT_ABORT_AFTER);
    assert.equal(abortAfterFromEnv('JS_ONLY_ABORT_AFTER', { JS_ONLY_ABORT_AFTER: '5' }), 5);
    assert.equal(abortAfterFromEnv('BLOCKED_ABORT_AFTER', { BLOCKED_ABORT_AFTER: '3' }), 3);
  });

  it('reads each threshold from its own variable', () => {
    const env = { JS_ONLY_ABORT_AFTER: '5', BLOCKED_ABORT_AFTER: '3' };
    assert.equal(abortAfterFromEnv('JS_ONLY_ABORT_AFTER', env), 5);
    assert.equal(abortAfterFromEnv('BLOCKED_ABORT_AFTER', env), 3);
  });

  it('falls back on nonsense rather than disabling the guard or firing instantly', () => {
    for (const value of ['abc', '0', '-3', '', ' ']) {
      assert.equal(
        abortAfterFromEnv('JS_ONLY_ABORT_AFTER', { JS_ONLY_ABORT_AFTER: value }),
        DEFAULT_ABORT_AFTER,
        `JS_ONLY_ABORT_AFTER=${JSON.stringify(value)}`,
      );
    }
  });

  it('floors a fractional override instead of rejecting it', () => {
    assert.equal(abortAfterFromEnv('BLOCKED_ABORT_AFTER', { BLOCKED_ABORT_AFTER: '7.9' }), 7);
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
