import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shouldExcludeNonContentPath } from './non-content-path.js';
import { classifyReject } from './reject.js';

/**
 * Every excluded URL below is from the Tipalti partner crawl of 2026-10-05 (170 pages, 30 under
 * legal and privacy) or Melio's; every kept one is a content page the rule must not touch.
 */
describe('shouldExcludeNonContentPath — directories that are never corpus', () => {
  const excluded = [
    'https://tipalti.com/legal/tipalti-services-agreement/',
    'https://tipalti.com/legal/uk-services-schedule-20250404/',
    'https://tipalti.com/privacy/',
    'https://melio.com/privacy-policy/',
    'https://melio.com/terms-of-service/',
    'https://example.test/terms',
    'https://example.test/cookie-policy/',
    'https://tipalti.com/company/careers/'.replace('/company', ''),
    'https://example.test/jobs/senior-engineer',
    '/legal/dpa',
  ];
  for (const url of excluded) {
    it(`excludes ${url}`, () => assert.equal(shouldExcludeNonContentPath(url), true));
  }

  const kept = [
    'https://melio.com/industries/legal/',
    'https://tipalti.com/ap-automation/multi-entity/',
    'https://tipalti.com/blog/legal-entities-and-payables/',
    'https://tipalti.com/company/careers/',
    'https://tipalti.com/',
    'https://tipalti.com/resources/learn/legal-tech/',
  ];
  for (const url of kept) {
    it(`keeps ${url}`, () => assert.equal(shouldExcludeNonContentPath(url), false));
  }

  it('is a first-segment rule, not a substring one', () => {
    assert.equal(shouldExcludeNonContentPath('https://x.test/legal-entities/'), false);
    assert.equal(shouldExcludeNonContentPath('https://x.test/LEGAL/x'), true);
  });
});

describe('classifyReject — non_content_directory', () => {
  it('rejects a legal page before anything else about it is considered', () => {
    assert.equal(
      classifyReject({ finalUrl: 'https://tipalti.com/legal/tipalti-services-agreement/', text: 'A'.repeat(500) }),
      'non_content_directory',
    );
  });

  it('locale still wins, as the outermost scope decision', () => {
    assert.equal(classifyReject({ finalUrl: 'https://tipalti.com/fr/legal/' }), 'locale_excluded');
  });

  it('a content page under a legal-industry directory is not touched', () => {
    assert.equal(classifyReject({ finalUrl: 'https://melio.com/industries/legal/', text: 'A'.repeat(500) }), null);
  });
});
