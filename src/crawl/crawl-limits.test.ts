import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_PAGES_PER_SITE, clampToSiteCap } from './crawl-limits.js';

describe('clampToSiteCap', () => {
  it('caps at 2500 pages per site', () => {
    assert.equal(MAX_PAGES_PER_SITE, 2500);
    assert.equal(clampToSiteCap(50_000), 2500);
    assert.equal(clampToSiteCap(2501), 2500);
  });

  it('keeps smaller budgets intact', () => {
    assert.equal(clampToSiteCap(10), 10);
    assert.equal(clampToSiteCap(2500), 2500);
  });

  it('defaults missing or non-finite budgets to the cap', () => {
    assert.equal(clampToSiteCap(undefined), 2500);
    assert.equal(clampToSiteCap(Number.NaN), 2500);
    assert.equal(clampToSiteCap(Number.POSITIVE_INFINITY), 2500);
  });

  it('floors fractions and never returns less than one', () => {
    assert.equal(clampToSiteCap(7.9), 7);
    assert.equal(clampToSiteCap(0), 1);
    assert.equal(clampToSiteCap(-5), 1);
  });
});
