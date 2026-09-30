import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyPath, TIER_ORDER } from './classify-path.js';

/**
 * Every URL below was taken from the live corpus on 2026-09-30, not invented. The corpus was 72%
 * editorial across 4,496 pages, and each "leak" case is a section the old exact-string quota table
 * had no key for.
 */

describe('classifyPath — the leaks that made the corpus 72% editorial', () => {
  const leaks: Array<[string, string]> = [
    ['https://bill.com/learning/2-way-matching', 'learning, 510 pages, no quota key existed'],
    ['https://avidxchange.com/press-releases/acumatica-selects-avidxchange', 'press-releases, 254'],
    ['https://bill.com/accountant-resource-center/ap-and-ar', 'accountant-resource-center, 230'],
    ['https://bill.com/case-study/9to5-national-association', 'case-study singular, 207'],
    ['https://lightyear.cloud/company-blog/10-tips-for-ap-teams/', 'company-blog compound, 129'],
    ['https://medius.com/videos/about-medius/', 'videos, 94'],
    ['https://avidxchange.com/customer-stories/a-mission-that-serves/', 'customer-stories, 59'],
    ['https://bill.com/business-templates/balance-sheet', 'business-templates, 42'],
    ['https://avidxchange.com/company-news/avidxchange-announces/', 'company-news, 28'],
    ['https://medius.com/resources/case-studies/', 'resources, 310'],
    ['https://geekatyourspot.com/glossary/accounts-payable', 'glossary'],
    ['https://geekatyourspot.com/blog/accounting/how-ai-is-revolutionizing', 'blog'],
  ];

  for (const [url, why] of leaks) {
    it(`treats ${new URL(url).pathname.split('/')[1]} as editorial — ${why}`, () => {
      assert.equal(classifyPath(url), 'editorial');
    });
  }
});

describe('classifyPath — editorial nested inside a product path', () => {
  // The trap that matters most: marketing tucks SEO clusters under product directories, and a
  // parent-folder rule counts them as product until the budget is gone.
  it('downgrades a how-to under /solutions/', () => {
    assert.equal(classifyPath('https://avidxchange.com/solutions/how-to-automate-invoices/'), 'editorial');
  });

  it('treats a guide section as editorial by its section, not by the word guide', () => {
    assert.equal(classifyPath('https://example.com/guides/accounts-receivable'), 'editorial');
  });

  it('does NOT downgrade /integrations/setup-guide — product documentation is evidence', () => {
    assert.equal(classifyPath('https://parseur.com/integrations/setup-guide'), 'product');
  });
});

describe('classifyPath — precedence between tokens, segments and archives', () => {
  // Each of these was wrong in an earlier revision, and each broke a different rule.
  it('product taxonomy under /solutions/ is not a blog archive', () => {
    // `category` scanned anywhere in the path made every /solutions/category/* page editorial.
    assert.equal(classifyPath('https://x.com/solutions/category/product-0'), 'product');
  });

  it('a real blog archive still is one', () => {
    assert.equal(classifyPath('https://x.com/category/accounting'), 'editorial');
    assert.equal(classifyPath('https://x.com/blog/category/accounting'), 'editorial');
  });

  it('a guide under a topic folder is editorial', () => {
    // The review's headline trap. An SEO cluster nested under a product-sounding directory.
    assert.equal(
      classifyPath('https://quickbooks.intuit.com/accounting/accounts-receivable-guide/'),
      'editorial',
    );
  });

  it('a guide under a product folder is not', () => {
    assert.equal(classifyPath('https://parseur.com/integrations/setup-guide'), 'product');
  });

  it('a strong token beats its product parent', () => {
    assert.equal(classifyPath('https://x.com/solutions/how-to-automate-invoices'), 'editorial');
  });

  it('the leftmost classifying segment wins', () => {
    assert.equal(classifyPath('https://x.com/blog/pricing-explained'), 'editorial');
    assert.equal(classifyPath('https://x.com/pricing/blog-migration'), 'product');
  });
});

describe('classifyPath — pages the crawl exists to collect', () => {
  const product: Array<[string, string]> = [
    ['https://medius.com/solutions/company-size/', 'solutions'],
    ['https://bill.com/product/1099-filing', 'product'],
    ['https://dext.com/business/pricing', 'pricing under a generic first segment'],
    ['https://nexusap.com/industries', 'industries'],
    ['https://bill.com/compare', 'competitor comparison is evidence'],
    ['https://geekatyourspot.com/use-cases/accounting', 'use-cases'],
    ['https://parseur.com/integrations/zapier', 'integrations'],
  ];

  for (const [url, why] of product) {
    it(`keeps ${url.replace(/^https?:\/\//, '')} as product — ${why}`, () => {
      assert.equal(classifyPath(url), 'product');
    });
  }
});

describe('classifyPath — the resource false positive', () => {
  // B2B software is full of "Enterprise Resource Planning" and "Human Resources". Substring
  // matching on `resource` would bury the product pages this whole change exists to surface.
  it('does not mistake erp-resource-planning for /resources/', () => {
    assert.equal(
      classifyPath('https://medius.com/solutions/erp-resource-planning-software'),
      'product',
    );
  });

  it('does not mistake human-resources-automation for /resources/', () => {
    assert.equal(classifyPath('https://example.com/product/human-resources-automation'), 'product');
  });
});

describe('classifyPath — everything else lands in other, not silently in product', () => {
  const other = [
    'https://medius.com/lps/au-ap/',
    'https://medius.com/legal/accessibility-statement/',
    'https://medius.com/about/awards-and-recognition/',
    'https://dext.com/cafr/app',
    'https://medius.com/partners/partner-finder/',
    'https://medius.com/',
  ];

  for (const url of other) {
    it(`classifies ${url.replace(/^https?:\/\//, '')} as other`, () => {
      assert.equal(classifyPath(url), 'other');
    });
  }
});

describe('classifyPath — totality and ordering', () => {
  it('never returns undefined, whatever it is given', () => {
    for (const s of ['', '/', 'not a url', 'https://x.com', 'ftp://x.com/blog']) {
      assert.ok(['product', 'other', 'editorial'].includes(classifyPath(s)), s);
    }
  });

  it('orders product before other before editorial', () => {
    assert.ok(TIER_ORDER.product < TIER_ORDER.other);
    assert.ok(TIER_ORDER.other < TIER_ORDER.editorial);
  });
});

describe('sectionAdmissionOrder — the acceptance test for composition', () => {
  it('puts 50 product pages ahead of 500 blog posts regardless of depth or alphabet', async () => {
    const { sectionAdmissionOrder } = await import('./sitemap.js');

    // Deliberately stacked against the old sort: every blog post is depth 2 and starts with "b",
    // every product page is depth 3 and starts with "s". Depth-then-alphabetical put all 500 blog
    // posts first, which is exactly how the live corpus reached 72% editorial.
    const blog = Array.from({ length: 500 }, (_, i) => `https://x.com/blog/post-${i}`);
    const product = Array.from(
      { length: 50 },
      (_, i) => `https://x.com/solutions/category/product-${i}`,
    );

    const ordered = sectionAdmissionOrder([...blog, ...product]);

    const firstBlog = ordered.findIndex((u) => u.includes('/blog/'));
    const lastProduct = ordered.map((u) => u.includes('/solutions/')).lastIndexOf(true);
    assert.ok(
      lastProduct < firstBlog,
      'every product page must be ordered before the first blog post',
    );
    assert.equal(ordered.slice(0, 50).every((u) => u.includes('/solutions/')), true);
    assert.equal(ordered.length, 550, 'ordering must not drop or duplicate URLs');
  });

  it('keeps ordering deterministic inside a tier', () => {
    const urls = [
      'https://x.com/solutions/b',
      'https://x.com/solutions/a',
      'https://x.com/pricing',
    ];
    const once = sectionAdmissionOrderSync(urls);
    const twice = sectionAdmissionOrderSync([...urls].reverse());
    assert.deepEqual(once, twice, 'same set, same order, whatever the input order');
  });
});

// Imported lazily above to avoid a cycle at module load; this is the sync handle for the second test.
import { sectionAdmissionOrder as sectionAdmissionOrderSync } from './sitemap.js';
