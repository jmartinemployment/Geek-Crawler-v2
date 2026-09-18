import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isDroppedRegionPath,
  isNonEnglishLocalePath,
  isUsRegionPath,
  localeNormalizeForMap,
  parseLocaleSegment,
  shouldExcludeLocalePath,
  stripEnglishLocalePrefix,
} from './locale-path.js';

const at = (p: string) => `https://www.freshbooks.com${p}`;

describe('parseLocaleSegment', () => {
  it('reads language and region, and rejects ordinary path segments', () => {
    assert.deepEqual(parseLocaleSegment('en'), { language: 'en', region: undefined });
    assert.deepEqual(parseLocaleSegment('en-GB'), { language: 'en', region: 'gb' });
    assert.deepEqual(parseLocaleSegment('gb'), { language: 'gb', region: undefined });
    assert.deepEqual(parseLocaleSegment('es-419'), { language: 'es', region: '419' });

    // Anything that cannot be a tag by shape is rejected outright.
    for (const seg of ['pricing', 'invoice-templates', 'a', 'en-gbr', '']) {
      assert.equal(parseLocaleSegment(seg), null, `${seg} is not tag-shaped`);
    }
  });

  it('recognises shape only — membership is what decides', () => {
    // `hub` and `api` are tag-shaped and parse as such. That is deliberate: the
    // parser reports what it saw, and belonging to KEEP/DROP/NON_ENGLISH is what
    // makes a tag mean anything. Neither is in any set, so neither is excluded.
    assert.deepEqual(parseLocaleSegment('hub'), { language: 'hub', region: undefined });
    assert.deepEqual(parseLocaleSegment('api'), { language: 'api', region: undefined });
    assert.equal(shouldExcludeLocalePath(at('/hub/invoicing')), false);
    assert.equal(shouldExcludeLocalePath(at('/api/docs')), false);
  });
});

describe('market regions', () => {
  it('keeps /us/ and drops bare foreign markets', () => {
    assert.equal(isUsRegionPath(at('/us/pricing')), true);
    assert.equal(isDroppedRegionPath(at('/us/pricing')), false);
    for (const p of ['/gb/pricing', '/uk/pricing', '/au/pricing', '/ca/pricing', '/za/pricing']) {
      assert.equal(isDroppedRegionPath(at(p)), true, `${p} is another market`);
    }
  });

  /**
   * The regression this file was written for. A compound tag was judged by its
   * language half alone, so `en-gb` read as English-therefore-keep and 264
   * GB-market pages consumed 10.8% of a 2,500-page US crawl budget.
   */
  it('drops an English tag that addresses a foreign market', () => {
    for (const p of ['/en-gb/pricing', '/en-ca/pricing', '/en-au/pricing', '/en-za/pricing']) {
      assert.equal(shouldExcludeLocalePath(at(p)), true, `${p} is a foreign market`);
    }
  });

  it('keeps English tags for the kept market', () => {
    assert.equal(shouldExcludeLocalePath(at('/en/pricing')), false);
    assert.equal(shouldExcludeLocalePath(at('/en-us/pricing')), false);
    assert.equal(shouldExcludeLocalePath(at('/pricing')), false);
  });

  it('leaves ordinary content paths alone', () => {
    for (const p of ['/pricing', '/hub/invoicing', '/api/docs', '/invoice-templates/x']) {
      assert.equal(shouldExcludeLocalePath(at(p)), false, `${p} is content`);
    }
  });
});

describe('non-English languages', () => {
  it('drops non-English prefixes and keeps English', () => {
    assert.equal(isNonEnglishLocalePath(at('/fr/pricing')), true);
    assert.equal(isNonEnglishLocalePath(at('/de/pricing')), true);
    assert.equal(isNonEnglishLocalePath(at('/en/pricing')), false);
    assert.equal(isNonEnglishLocalePath(at('/us/pricing')), false);
  });

  it('drops a non-English tag carrying a region', () => {
    assert.equal(shouldExcludeLocalePath(at('/fr-ca/pricing')), true);
    assert.equal(shouldExcludeLocalePath(at('/es-mx/pricing')), true);
  });
});

describe('stripEnglishLocalePrefix', () => {
  it('collapses English prefixes to the bare path', () => {
    assert.equal(new URL(stripEnglishLocalePrefix(at('/en/pricing'))).pathname, '/pricing');
    assert.equal(new URL(stripEnglishLocalePrefix(at('/en-us/pricing'))).pathname, '/pricing');
  });

  it('does not collapse a foreign market onto the US path', () => {
    // /en-gb/pricing is not the same page as /pricing; collapsing it would let a
    // GB page occupy the US slot in map membership.
    assert.equal(new URL(stripEnglishLocalePrefix(at('/en-gb/pricing'))).pathname, '/en-gb/pricing');
  });

  it('leaves /us/ untouched', () => {
    assert.equal(new URL(stripEnglishLocalePrefix(at('/us/pricing'))).pathname, '/us/pricing');
  });
});

describe('localeNormalizeForMap', () => {
  it('returns null for excluded markets and languages', () => {
    for (const p of ['/en-gb/pricing', '/gb/pricing', '/fr/pricing', '/fr-ca/pricing']) {
      assert.equal(localeNormalizeForMap(at(p)), null, `${p} is off the map`);
    }
  });

  it('normalises kept paths', () => {
    assert.equal(new URL(localeNormalizeForMap(at('/en-us/pricing'))!).pathname, '/pricing');
    assert.equal(new URL(localeNormalizeForMap(at('/pricing'))!).pathname, '/pricing');
    assert.equal(new URL(localeNormalizeForMap(at('/us/pricing'))!).pathname, '/us/pricing');
  });
});
