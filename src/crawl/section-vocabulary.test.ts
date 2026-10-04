import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyPath } from './classify-path.js';
import { quotaKey } from './section-quota.js';
import { SECTIONS } from './section-vocabulary.js';

/**
 * One sample segment per entry. Keyed by pattern source so that two entries sharing a name each
 * need their own sample; an entry added without one fails the coverage test below.
 */
const SAMPLES = new Map<string, string>([
  [/^products?$/.source, 'product'],
  [/^solutions?$/.source, 'solutions'],
  [/^features?$/.source, 'features'],
  [/^pricing$/.source, 'pricing'],
  [/^plans?$/.source, 'plans'],
  [/^platform$/.source, 'platform'],
  [/^integrations?$/.source, 'integrations'],
  [/^use-cases?$/.source, 'use-cases'],
  [/^industries$/.source, 'industries'],
  [/^(?:alternatives|vs|versus|compare|comparison)$/.source, 'vs'],
  [/^capabilities$/.source, 'capabilities'],
  [/^modules?$/.source, 'modules'],
  [/^customers$/.source, 'customers'],
  [/^(?:[a-z0-9]+-)?case-stud(?:y|ies)$/.source, 'customer-case-studies'],
  [/^(?:[a-z0-9]+-)?success-stor(?:y|ies)$/.source, 'success-story'],
  [/^(?:[a-z0-9]+-)?stories$/.source, 'customer-stories'],
  [/^(?:[a-z0-9]+-)?testimonials?$/.source, 'smb-testimonials'],
  [/^(?:faqs?|frequently-asked(?:-questions)?)$/.source, 'faq'],
  [/^(?:[a-z0-9]+-)?blogs?$/.source, 'company-blog'],
  [/^(?:[a-z0-9]+-)?news$/.source, 'news'],
  [/^press(?:-releases?|-room|-centre?|-center)?$/.source, 'press-releases'],
  [/^(?:[a-z0-9]+-)?story$/.source, 'story'],
  [/^(?:[a-z0-9]+-)?resources?$/.source, 'resources'],
  [/^[a-z0-9-]*resource-cent(?:er|re)$/.source, 'accountant-resource-center'],
  [/^(?:[a-z0-9]+-)?(?:hub|content-corner)$/.source, 'content-corner'],
  [/^learn(?:ing)?$/.source, 'learning'],
  [/^academy$/.source, 'academy'],
  [/^(?:glossary|definitions|dictionary|what-is)$/.source, 'glossary'],
  [/^insights?$/.source, 'insights'],
  [/^articles?$/.source, 'articles'],
  [/^guides?$/.source, 'guides'],
  [/^ebooks?$/.source, 'ebooks'],
  [/^(?:[a-z0-9]+-)?templates?$/.source, 'business-templates'],
  [/^videos?$/.source, 'video'],
  [/^webinars?$/.source, 'webinars'],
  [/^podcasts?$/.source, 'podcast'],
  [/^events?$/.source, 'events'],
  [/^(?:community|forum|answers|questions)$/.source, 'forum'],
  [/^(?:job-descriptions|roles|titles)$/.source, 'job-descriptions'],
  [/^free-tools$/.source, 'free-tools'],
  [/^generators?$/.source, 'generator'],
  [/^calculators?$/.source, 'calculator'],
  [/^(?:knowledge|kb|help|support)$/.source, 'help'],
  [/^(?:author|authors|tag|tags|category|categories|topics|archive|page)$/.source, 'page'],
  [/^apps$/.source, 'apps'],
  [/^connectors$/.source, 'connectors'],
  [/^plugins$/.source, 'plugins'],
  [/^marketplace$/.source, 'marketplace'],
  [/^tools$/.source, 'tools'],
  [SECTIONS.find((e) => e.name === 'jurisdiction-guides')!.pattern.source, 'country-guides'],
  [SECTIONS.find((e) => e.name === 'tax-reference')!.pattern.source, 'eu-vat-rules'],
  [/^tax-?rates?$/.source, 'taxrates'],
  [/^(?:state|city|county|local|zip|sales-tax)-rates?$/.source, 'local-rates'],
  [/^(?:count(?:y|ies)|cities|states|municipalities|districts)$/.source, 'counties'],
  [/^zip-?codes?$/.source, 'zip-codes'],
]);

describe('section vocabulary — the classifier and the quotas read one table', () => {
  it('has a sample for every entry, and each sample matches its own entry', () => {
    for (const entry of SECTIONS) {
      const sample = SAMPLES.get(entry.pattern.source);
      assert.ok(sample, `no sample for ${entry.name} ${entry.pattern}`);
      assert.ok(entry.pattern.test(sample), `${sample} must match ${entry.pattern}`);
    }
  });

  it('agrees on every entry: the classifier returns its tier, the quotas its name', () => {
    for (const entry of SECTIONS) {
      const url = `https://x.com/${SAMPLES.get(entry.pattern.source)}/x`;
      // `other` entries never classify, so the tier of a page under one is whatever the token rules
      // say: /country-guides/x is editorial by the weak `-guides` token, as it was before the tables
      // were merged. Only classifying entries are held to their tier.
      if (entry.tier !== 'other') assert.equal(classifyPath(url), entry.tier, `tier of ${url}`);
      // Product sections are never capped, so the quotas see no section.
      assert.equal(quotaKey(url), entry.tier === 'product' ? '' : entry.name, `section of ${url}`);
    }
  });

  it('closes the drift F-C7 found', () => {
    // Evidence to the classifier, and now capped as case-studies rather than uncapped.
    assert.equal(classifyPath('https://x.com/customer-case-studies/acme'), 'evidence');
    assert.equal(quotaKey('https://x.com/customer-case-studies/acme'), 'case-studies');
    // An archive to both, as the first segment only.
    assert.equal(quotaKey('https://x.com/page/2'), 'archive');
    assert.equal(quotaKey('https://x.com/docs/page/2'), '');
    // Capped as calculators all along; now editorial to the classifier too.
    assert.equal(classifyPath('https://x.com/calculator/roi'), 'editorial');
  });

  it('lets an other section name the quota without stopping classification', () => {
    assert.equal(classifyPath('https://x.com/tools/blog/x'), 'editorial');
    assert.equal(quotaKey('https://x.com/tools/blog/x'), 'tools');
  });

  it('caps an editorial section under a product directory by its own name', () => {
    assert.equal(classifyPath('https://x.com/solutions/blog/x'), 'product');
    assert.equal(quotaKey('https://x.com/solutions/blog/x'), 'blog');
  });
});
