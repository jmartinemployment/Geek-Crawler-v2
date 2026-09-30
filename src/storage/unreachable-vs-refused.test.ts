import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PersistenceError, isUnreachable } from './errors.js';

/**
 * The distinction that decides whether a finished crawl is destroyed.
 *
 * On 2026-09-30 at 03:35, three completed crawls were purged in one minute — parseur 180 pages,
 * quickbooks 81, zoneandco 342 — because GeekAPI was redeploying and Railway's edge answered
 * `404 {"status":"error","code":404,"message":"Application not found","request_id":"..."}`. The
 * crawler read that as "the run was deleted", which is the only state that justifies removing local
 * data, and threw 603 pages away. A further 1,192 went the same way on 5xx.
 */

const RAILWAY_404 =
  '{"status":"error","code":404,"message":"Application not found","request_id":"qSKfdisKRiiSktaLU79b0g"}';

describe('PersistenceError.unreachable', () => {
  it('defaults to false — a refusal is determinate unless proven otherwise', () => {
    assert.equal(new PersistenceError('boom').unreachable, false);
  });

  it('carries the flag when set', () => {
    assert.equal(new PersistenceError('boom', { unreachable: true }).unreachable, true);
  });

  it('isUnreachable reads it off a caught value', () => {
    assert.equal(isUnreachable(new PersistenceError('x', { unreachable: true })), true);
    assert.equal(isUnreachable(new PersistenceError('x')), false);
    assert.equal(isUnreachable(new Error('x')), false);
    assert.equal(isUnreachable(undefined), false);
  });
});

describe('what must NOT purge a finished crawl', () => {
  // Each of these is the sink being absent. The crawl may be perfectly good.
  const unreachable = [
    ['transport failure', new PersistenceError('POST … → transport: fetch failed', { unreachable: true })],
    ['platform 404', new PersistenceError(`POST … → 404: ${RAILWAY_404}`, { unreachable: true })],
    ['GeekAPI 500', new PersistenceError('POST … → 500: ', { unreachable: true })],
  ] as const;

  for (const [name, err] of unreachable) {
    it(`${name} is unreachable, so the pages are kept`, () => {
      assert.equal(isUnreachable(err), true);
    });
  }
});

describe('what must STILL purge', () => {
  // GeekAPI answering for itself. These are judgements about this crawl and they are final.
  const refused = [
    ['409 complete with nothing usable', new PersistenceError('PATCH … → 409: "Crawl reported complete with no usable pages"')],
    ['400 pages carry no extracted content', new PersistenceError('POST … → 400: pages carry no extracted content')],
  ] as const;

  for (const [name, err] of refused) {
    it(`${name} is determinate, so the run is purged`, () => {
      assert.equal(isUnreachable(err), false);
    });
  }
});
