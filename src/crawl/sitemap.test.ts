import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createDiscoveryLedger } from './discovery-ledger.js';
import { createDirectoryCap } from './link-trap.js';
import { createSectionQuota } from './section-quota.js';
import {
  filterEnqueueUrls,
  initialCrawlUrls,
  inSiteMap,
  loadSiteMapForSeed,
  mergeHarvestedUrls,
  siteMapIndex,
  sitemapMemberKey,
} from './sitemap.js';

const NO_MAP = siteMapIndex([], [], false);

function urlsOf(candidates: Array<{ url: string }>): string[] {
  return candidates.map((c) => c.url);
}

describe('sitemapMemberKey — membership survives the variants a site links with', () => {
  it('ignores a trailing slash, host case and www', () => {
    const k = sitemapMemberKey('https://ramp.com/pricing');
    assert.equal(sitemapMemberKey('https://ramp.com/pricing/'), k);
    assert.equal(sitemapMemberKey('https://WWW.Ramp.com/pricing'), k);
  });

  it('keeps the root slash, the path case and the query', () => {
    assert.equal(sitemapMemberKey('https://ramp.com/'), 'https://ramp.com/');
    assert.notEqual(sitemapMemberKey('https://ramp.com/Pricing'), sitemapMemberKey('https://ramp.com/pricing'));
    assert.notEqual(sitemapMemberKey('https://ramp.com/a?x=1'), sitemapMemberKey('https://ramp.com/a'));
  });

  it('inSiteMap is false with no map', () => {
    assert.equal(inSiteMap(NO_MAP, 'https://ramp.com/'), false);
  });
});

describe('filterEnqueueUrls — the sitemap seeds the crawl, it does not bound it', () => {
  const map = siteMapIndex(['https://ramp.com/', 'https://ramp.com/blog/a'], [], false);

  it('admits a same-origin link the sitemap omits -- the ramp.com /products case', () => {
    const out = filterEnqueueUrls(['https://ramp.com/products', 'https://ramp.com/blog/a'], map);
    assert.deepEqual(urlsOf(out), ['https://ramp.com/products', 'https://ramp.com/blog/a']);
  });

  it('puts off-sitemap product and evidence links at the front, nothing else', () => {
    const out = filterEnqueueUrls(
      [
        'https://ramp.com/products',
        'https://ramp.com/customers/acme',
        'https://ramp.com/about',
        'https://ramp.com/blog/a',
      ],
      map,
    );
    assert.deepEqual(
      out.map((c) => [c.url, c.forefront]),
      [
        ['https://ramp.com/products', true],
        ['https://ramp.com/customers/acme', true],
        ['https://ramp.com/about', false],
        // Listed: already queued from the sitemap, never pulled forward.
        ['https://ramp.com/blog/a', false],
      ],
    );
  });

  it('treats a trailing-slash variant of a listed url as listed, so the trap rules skip it', () => {
    const listed = siteMapIndex(['https://ramp.com/blog/page/2'], [], false);
    const out = filterEnqueueUrls(['https://ramp.com/blog/page/2/'], listed);
    assert.deepEqual(urlsOf(out), ['https://ramp.com/blog/page/2/']);
  });

  it('refuses a listing view the sitemap omits, and admits one it lists', () => {
    const listed = siteMapIndex(['https://ramp.com/blog?page=2'], [], false);
    assert.deepEqual(urlsOf(filterEnqueueUrls(['https://ramp.com/blog?page=2'], listed)), [
      'https://ramp.com/blog?page=2',
    ]);
    assert.deepEqual(filterEnqueueUrls(['https://ramp.com/blog?page=3'], listed), []);
  });

  it('applies the trap rules to every link when there is no sitemap', () => {
    const out = filterEnqueueUrls(
      ['https://x.com/features', 'https://x.com/search?q=ap', 'https://x.com/events/2026-10-04'],
      NO_MAP,
    );
    assert.deepEqual(urlsOf(out), ['https://x.com/features']);
  });

  it('drops non-English locales and strips tracking params', () => {
    const out = filterEnqueueUrls(
      ['https://ramp.com/fr/products', 'https://ramp.com/products?utm_source=x'],
      map,
    );
    assert.deepEqual(urlsOf(out), ['https://ramp.com/products']);
  });

  it('collapses duplicates within one call and counts them', () => {
    const counters = { enqueueAttempts: 0, enqueueSuppressedLocal: 0 };
    const out = filterEnqueueUrls(
      ['https://ramp.com/products', 'https://ramp.com/products#top'],
      map,
      { counters },
    );
    assert.equal(out.length, 1);
    assert.deepEqual(counters, { enqueueAttempts: 2, enqueueSuppressedLocal: 1 });
  });

  it('refuses links past the depth cap only when the sitemap omits them', () => {
    const out = filterEnqueueUrls(
      ['https://ramp.com/products', 'https://ramp.com/blog/a'],
      map,
      undefined,
      { depthExceeded: true },
    );
    assert.deepEqual(urlsOf(out), ['https://ramp.com/blog/a']);
  });

  it('caps admitted off-sitemap other-tier pages per directory', () => {
    const directoryCap = createDirectoryCap(2);
    const out = filterEnqueueUrls(
      ['https://x.com/jobs/1', 'https://x.com/jobs/2', 'https://x.com/jobs/3', 'https://x.com/about'],
      map,
      { directoryCap },
    );
    assert.deepEqual(urlsOf(out), ['https://x.com/jobs/1', 'https://x.com/jobs/2', 'https://x.com/about']);
  });

  it('never charges the directory cap for a page the quota refused', () => {
    // Both urls are other tier under directory `locations`. The first is refused by the zip-codes
    // quota; had the cap been charged before the quota ran, its one slot would be gone and the
    // second -- which no quota covers -- refused with it.
    const directoryCap = createDirectoryCap(1);
    const quota = createSectionQuota(new Map([['zip-codes', 0]]));
    const ledger = createDiscoveryLedger();
    const out = filterEnqueueUrls(
      ['https://x.com/locations/zip-codes/33101', 'https://x.com/locations/miami'],
      NO_MAP,
      { directoryCap, quota, ledger },
    );
    assert.deepEqual(urlsOf(out), ['https://x.com/locations/miami']);
    assert.equal(ledger.report().refused.section, 1);
    assert.equal(ledger.report().refused.directoryCap, 0);
  });

  it('records each refusal in the ledger once, under the rule that refused it', () => {
    const ledger = createDiscoveryLedger();
    const quota = createSectionQuota(new Map([['zip-codes', 0]]));
    const links = [
      'https://ramp.com/products',
      'https://ramp.com/blog?page=2',
      'https://ramp.com/zip-codes/33101',
      'https://ramp.com/de/products',
    ];
    // The same page links appear on 40 pages. Each URL is still one URL.
    for (let i = 0; i < 40; i++) filterEnqueueUrls(links, map, { quota, ledger });
    const report = ledger.report();
    assert.equal(report.discovered, 4);
    assert.equal(report.enqueued.total, 1);
    assert.equal(report.enqueued.bySource.link, 1);
    assert.equal(report.refused.pagination, 1);
    assert.equal(report.refused.section, 1);
    assert.equal(report.refused.locale, 1);
    assert.equal(report.offSitemapAdmitted, 1);
    assert.equal(report.offSitemapSuppressed, 3);
    assert.deepEqual(report.sectionSuppressed, { 'zip-codes': 1 });
    assert.equal(quota.totalSuppressed(), 1);
  });
});

describe('initialCrawlUrls — seeds first, then the sitemap in tier order', () => {
  it('starts with the seeds and appends the map product-first', () => {
    const map = siteMapIndex(
      ['https://ramp.com/blog/a', 'https://ramp.com/pricing', 'https://ramp.com/'],
      [],
      false,
    );
    assert.deepEqual(initialCrawlUrls(['https://ramp.com/'], map), [
      'https://ramp.com/',
      'https://ramp.com/pricing',
      'https://ramp.com/blog/a',
    ]);
  });

  it('is the seeds alone with no sitemap', () => {
    assert.deepEqual(initialCrawlUrls(['https://ramp.com/'], NO_MAP), ['https://ramp.com/']);
  });

  it('passes sitemap urls through the quota and records both outcomes', () => {
    const ledger = createDiscoveryLedger();
    const quota = createSectionQuota(new Map([['zip-codes', 0]]));
    const map = siteMapIndex(['https://ramp.com/pricing', 'https://ramp.com/zip-codes/1'], [], false);
    const out = initialCrawlUrls(['https://ramp.com/'], map, { quota, ledger });
    assert.deepEqual(out, ['https://ramp.com/', 'https://ramp.com/pricing']);
    const report = ledger.report();
    assert.deepEqual(report.enqueued.bySource, { seed: 1, sitemap: 1, harvest: 0, link: 0 });
    assert.equal(report.refused.section, 1);
    assert.equal(report.offSitemapSuppressed, 0);
  });
});

describe('mergeHarvestedUrls — a browser pass stands in for a missing sitemap', () => {
  it('merges without duplicates, in tier order, and records only the new urls', () => {
    const ledger = createDiscoveryLedger();
    const start = initialCrawlUrls(['https://x.com/'], NO_MAP, { ledger });
    const out = mergeHarvestedUrls(
      start,
      ['https://x.com/blog/a', 'https://x.com/pricing', 'https://x.com/', 'https://x.com/pricing#x'],
      { ledger },
    );
    // Tier order puts /pricing (product) ahead of the root (other).
    assert.deepEqual(out, ['https://x.com/pricing', 'https://x.com/', 'https://x.com/blog/a']);
    assert.deepEqual(ledger.report().enqueued.bySource, { seed: 1, sitemap: 0, harvest: 2, link: 0 });
  });
});

describe('loadSiteMapForSeed — robots.txt, sitemap indexes, and the ceilings', () => {
  let server: Server;
  let origin = '';
  let childSitemaps = 0;

  before(async () => {
    server = createServer((req, res) => {
      const path = req.url ?? '/';
      const xml = (body: string) => {
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end(body);
      };
      if (path === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end(`User-agent: *\nSitemap: ${origin}/index.xml\n`);
      }
      if (path === '/index.xml') {
        return xml(
          `<sitemapindex><sitemap><loc>${origin}/pages.xml</loc></sitemap></sitemapindex>`,
        );
      }
      if (path === '/pages.xml') {
        return xml(
          `<urlset>
            <url><loc>${origin}/pricing</loc></url>
            <url><loc>${origin}/pricing?utm_source=x#top</loc></url>
            <url><loc>${origin}/fr/pricing</loc></url>
            <url><loc>${origin}/en/features</loc></url>
            <url><loc>https://elsewhere.invalid/page</loc></url>
          </urlset>`,
        );
      }
      if (path === '/sitemap.xml') {
        return xml(`<urlset><url><loc>${origin}/from-fallback</loc></url></urlset>`);
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    origin = `http://127.0.0.1:${address.port}`;
  });

  after(() => {
    server.close();
  });

  it('reads robots.txt sitemaps and the /sitemap.xml fallback, normalized and same-site', async () => {
    const map = await loadSiteMapForSeed(`${origin}/`);
    assert.equal(map.hasMap, true);
    assert.equal(map.truncated, false);
    assert.deepEqual([...map.urls].sort(), [
      `${origin}/features`,
      `${origin}/from-fallback`,
      `${origin}/pricing`,
    ]);
    assert.equal(inSiteMap(map, `${origin}/pricing/`), true);
  });

  it('is an empty map for an unparseable seed', async () => {
    const map = await loadSiteMapForSeed('not a url');
    assert.equal(map.hasMap, false);
    assert.equal(map.truncated, false);
  });

  it('reports truncation when the sitemap-file ceiling stops the load', async () => {
    const wide = createServer((req, res) => {
      const path = req.url ?? '/';
      const ok = () => res.writeHead(200, { 'content-type': 'application/xml' });
      if (path === '/sitemap.xml') {
        ok();
        const children = Array.from(
          { length: 60 },
          (_, i) => `<sitemap><loc>${wideOrigin}/child-${i}.xml</loc></sitemap>`,
        ).join('');
        return res.end(`<sitemapindex>${children}</sitemapindex>`);
      }
      const m = /^\/child-(\d+)\.xml$/.exec(path);
      if (m) {
        ok();
        childSitemaps += 1;
        return res.end(`<urlset><url><loc>${wideOrigin}/page-${m[1]}</loc></url></urlset>`);
      }
      res.writeHead(404);
      res.end();
    });
    let wideOrigin = '';
    await new Promise<void>((resolve) => wide.listen(0, '127.0.0.1', resolve));
    const address = wide.address();
    assert(address && typeof address !== 'string');
    wideOrigin = `http://127.0.0.1:${address.port}`;
    try {
      const map = await loadSiteMapForSeed(`${wideOrigin}/`);
      assert.equal(map.hasMap, true);
      assert.equal(map.truncated, true);
      assert.ok(childSitemaps < 60, 'the ceiling must stop the load before every child is read');
    } finally {
      wide.close();
    }
  });
});
