import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startCrawl } from '../../src/crawl/orchestrator.js';
import { startFixtureSite } from '../fixtures/site.js';

async function startMockGeekApi(): Promise<{
  origin: string;
  close: () => void;
  pageWrites: () => number;
  linkWrites: () => number;
  lastPatch: () => Record<string, unknown> | null;
}> {
  let pageWrites = 0;
  let linkWrites = 0;
  let lastPatch: Record<string, unknown> | null = null;
  let runSeq = 0;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url?.endsWith('/ingest/runs')) {
      runSeq += 1;
      const parsedSeeds = (JSON.parse(body) as { seeds?: string[] }).seeds ?? [];
      return res.end(
        JSON.stringify({
          run: {
            runId: `00000000-0000-4000-8000-${String(runSeq).padStart(12, '0')}`,
            status: 'external',
            crawlType: 'partner',
            seedUrls: parsedSeeds,
          },
          seedsAccepted: parsedSeeds.length,
          rejected: [],
        }),
      );
    }
    if (req.method === 'POST' && req.url?.includes('/pages/batch')) {
      pageWrites += 1;
      const parsed = JSON.parse(body) as { pages: Array<{ url: string }> };
      return res.end(
        JSON.stringify({
          pages: parsed.pages.map((p, i) => ({
            url: p.url,
            pageId: `page-${pageWrites}-${i}`,
          })),
        }),
      );
    }
    if (req.method === 'POST' && req.url?.includes('/links/batch')) {
      linkWrites += 1;
      const parsed = JSON.parse(body) as { links: unknown[] };
      return res.end(JSON.stringify({ count: parsed.links.length }));
    }
    if (req.method === 'PATCH') {
      lastPatch = JSON.parse(body) as Record<string, unknown>;
      return res.end(JSON.stringify({ runId: 'x', status: 'complete', crawlType: 'partner' }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => server.close(),
    pageWrites: () => pageWrites,
    linkWrites: () => linkWrites,
    lastPatch: () => lastPatch,
  };
}

test('cheerio-only crawl persists via GeekAPI with retries disabled', { timeout: 120_000 }, async () => {
  const geek = await startMockGeekApi();
  const fixture = await startFixtureSite();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'geek-crawler-e2e-'));
  const old = {
    url: process.env.GEEK_API_URL,
    key: process.env.GEEK_BACKEND_API_KEY,
    user: process.env.GEEK_USER_ID,
  };
  process.env.GEEK_API_URL = geek.origin;
  process.env.GEEK_BACKEND_API_KEY = 'test-key';
  process.env.GEEK_USER_ID = 'test-user';
  try {
    const result = await startCrawl({
      seeds: [`${fixture.origin}/`],
      crawlType: 'partner',
      dataDir,
      maxConcurrency: 1,
    });

    assert.equal(result.persistMode, 'api');
    assert.ok(result.pagesSaved >= 1);
    assert.ok(geek.pageWrites() >= 1);
    assert.ok(fixture.requests('/retry') <= 1, 'maxRequestRetries=0 must not re-fetch');
    assert.equal(fixture.requests('/blocked'), 0);
    assert.equal(fixture.requests('/fr/article'), 0);

    // The fixture sitemap does not list /nested/one; the home page links to it. Until 2026-10-04 the
    // sitemap was an allowlist and this link was dropped without a count.
    assert.equal(fixture.requests('/nested/one'), 1, 'an off-sitemap link must be followed');
    assert.equal(fixture.requests('/nested/two'), 1, 'and the links on that page too');

    // The terminal patch carries the discovery report in hostProgressJson, and it accounts for
    // every discovered URL: fetched, refused by a named rule, or left unfetched.
    const patch = geek.lastPatch();
    assert.ok(patch, 'the run must be patched terminal');
    const hosts = JSON.parse(String(patch.hostProgressJson)) as Array<Record<string, unknown>>;
    const stats = hosts.find((h) => h.origin === '__crawlee_reject_stats__');
    const discovery = stats?.discovery as {
      discovered: number;
      enqueued: { total: number };
      fetched: number;
      enqueuedNotFetched: number;
      refused: Record<string, number>;
      offSitemapAdmitted: number;
      sitemap: { present: boolean; truncated: boolean };
    };
    assert.ok(discovery, 'hostProgressJson must carry the discovery report');
    const refused = Object.values(discovery.refused).reduce((a, b) => a + b, 0);
    assert.equal(discovery.discovered, discovery.enqueued.total + refused);
    assert.equal(discovery.enqueued.total, discovery.fetched + discovery.enqueuedNotFetched);
    assert.equal(discovery.enqueuedNotFetched, 0, 'nothing is left unfetched on a small site');
    assert.equal(discovery.offSitemapAdmitted, 2, '/nested/one and /nested/two');
    assert.equal(discovery.refused.locale, 1, '/fr/article, linked from the home page');
    assert.deepEqual(discovery.sitemap, { present: true, urls: discovery.sitemap.urls, truncated: false });
  } finally {
    if (old.url === undefined) delete process.env.GEEK_API_URL;
    else process.env.GEEK_API_URL = old.url;
    if (old.key === undefined) delete process.env.GEEK_BACKEND_API_KEY;
    else process.env.GEEK_BACKEND_API_KEY = old.key;
    if (old.user === undefined) delete process.env.GEEK_USER_ID;
    else process.env.GEEK_USER_ID = old.user;
    geek.close();
    await fixture.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
