/**
 * The early abort, end to end.
 *
 * The predicate is unit tested in src/crawl/early-abort.test.ts. What is worth
 * proving here is the thing the unit tests cannot: that a real crawl against a
 * real server actually stops, and stops without having fetched the whole
 * sitemap. The first version of this feature passed its unit tests while never
 * firing on the sites it was built for, because the counter it incremented was
 * fed by a classification those sites never produced.
 *
 * Run: npx tsx --test tests/integration/early-abort.integration.test.ts
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isPrepareFailure, startCrawl } from '../../src/crawl/orchestrator.js';
import { runLogPath } from '../../src/crawl/run-log.js';
import { listFailures } from '../../src/storage/failure-archive.js';

const RUN_ID = '11111111-2222-4333-8444-555555555555';
const SITEMAP_SIZE = 200;

/** Padding that is never text: attribute values are not in $('body').text(). */
const PAD = 'x'.repeat(600);

/**
 * A JavaScript shell that does NOT announce itself.
 *
 * No #root, no #__next, no #app, and a nav that renders without JavaScript, so
 * isViableHtml reports insufficient_text rather than empty_or_spa_shell. This
 * is a Next App Router or Angular page, and it is precisely the shape that used
 * to slip past the abort and spend the whole budget.
 */
const QUIET_SHELL = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>App</title></head>
<body><header>Home About Contact</header><div id="mount" data-pad="${PAD}"></div></body></html>`;

/** A shell that does announce itself, for the branch that always worked. */
const LOUD_SHELL = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>App</title></head>
<body><div id="__next" data-pad="${PAD}"></div></body></html>`;

const FORBIDDEN = `<!doctype html><html><head><title>403 Forbidden</title></head>
<body><main><h1>Access denied</h1><p>You do not have permission to access this resource on this
server. If you believe this is an error, contact the site administrator and quote your IP
address, the time of the request, and the URL you were trying to reach.</p></main>
<div data-pad="${PAD}"></div></body></html>`;

type Mode = (index: number) => { status: number; body: string };

async function startBarrenSite(mode: Mode): Promise<{
  origin: string;
  pageFetches: () => number;
  close: () => Promise<void>;
}> {
  let origin = '';
  let pageFetches = 0;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', origin || 'http://127.0.0.1');
    const send = (status: number, body: string, type = 'text/html; charset=utf-8') => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };

    if (url.pathname === '/robots.txt') {
      return send(200, `User-agent: *\nSitemap: ${origin}/sitemap.xml`, 'text/plain');
    }
    if (url.pathname === '/sitemap.xml') {
      const urls = Array.from(
        { length: SITEMAP_SIZE },
        (_, i) => `<url><loc>${origin}/page-${i + 1}</loc></url>`,
      ).join('');
      return send(200, `<?xml version="1.0"?><urlset>${urls}</urlset>`, 'application/xml');
    }

    const match = url.pathname.match(/^\/page-(\d+)$/);
    if (match) {
      pageFetches += 1;
      const { status, body } = mode(Number(match[1]));
      return send(status, body);
    }
    return send(404, 'not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    pageFetches: () => pageFetches,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** GeekAPI that accepts the run, then records the patch and the purge. */
async function startGeekApi(): Promise<{
  origin: string;
  pageWrites: () => number;
  close: () => Promise<void>;
}> {
  let pageWrites = 0;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    res.setHeader('content-type', 'application/json');

    if (req.method === 'POST' && req.url?.endsWith('/ingest/runs')) {
      const seeds = (JSON.parse(body) as { seeds?: string[] }).seeds ?? [];
      return res.end(
        JSON.stringify({
          run: { runId: RUN_ID, status: 'external', crawlType: 'partner', seedUrls: seeds },
          seedsAccepted: seeds.length,
          rejected: [],
        }),
      );
    }
    if (req.method === 'POST' && req.url?.includes('/pages/batch')) {
      const parsed = JSON.parse(body) as { pages: Array<{ url: string }> };
      pageWrites += parsed.pages.length;
      return res.end(
        JSON.stringify({
          pages: parsed.pages.map((p, i) => ({ url: p.url, pageId: `page-${i}` })),
        }),
      );
    }
    if (req.method === 'POST' && req.url?.includes('/links/batch')) {
      return res.end(JSON.stringify({ linksStored: 0 }));
    }
    if (req.method === 'DELETE') {
      return res.end(JSON.stringify({ vectorsPurged: true, crawlDataDeleted: true }));
    }
    if (req.method === 'PATCH') {
      return res.end(JSON.stringify({ runId: RUN_ID, status: 'failed', crawlType: 'partner' }));
    }
    res.statusCode = 404;
    res.end('{}');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    pageWrites: () => pageWrites,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function crawlBarrenSite(mode: Mode) {
  const geek = await startGeekApi();
  const site = await startBarrenSite(mode);
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'geek-crawler-abort-'));
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
      seeds: [`${site.origin}/`],
      crawlType: 'partner',
      dataDir,
      maxConcurrency: 1,
    });
    assert(!isPrepareFailure(result), 'the run must get past preparation');
    const failures = await listFailures(dataDir);
    assert(failures, 'the failures directory must be listable');
    const runLog = await readFile(runLogPath(dataDir, result.runId), 'utf8');
    const runDirSurvived = await access(path.join(dataDir, 'runs', result.runId)).then(
      () => true,
      () => false,
    );
    return {
      result,
      failures,
      runLog,
      runDirSurvived,
      pageFetches: site.pageFetches(),
      pageWrites: geek.pageWrites(),
    };
  } finally {
    process.env.GEEK_API_URL = old.url;
    process.env.GEEK_BACKEND_API_KEY = old.key;
    process.env.GEEK_USER_ID = old.user;
    await site.close();
    await geek.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test(
  'a JavaScript site that does not announce itself is abandoned, not crawled out',
  { timeout: 120_000 },
  async () => {
    const { result, failures, runLog, runDirSurvived, pageFetches, pageWrites } =
      await crawlBarrenSite(() => ({
        status: 200,
        body: QUIET_SHELL,
      }));

    assert.equal(result.pagesSaved, 0, 'nothing from a JavaScript-only site may be stored');
    assert.equal(pageWrites, 0, 'and nothing may reach GeekAPI');

    // The whole point. 200 URLs were offered; the run must not have taken them.
    assert.ok(
      pageFetches < SITEMAP_SIZE / 2,
      `stopped early: fetched ${pageFetches} of ${SITEMAP_SIZE}`,
    );
    assert.ok(pageFetches >= 25, `did not stop before the threshold: ${pageFetches}`);

    assert.equal(failures.length, 1, 'the post-mortem is what survives');
    assert.match(failures[0]!.errorSummary ?? '', /Nothing extractable after/);
    assert.match(failures[0]!.errorSummary ?? '', /carried no prose/);

    // The run is purged, and its log is not: the log is most needed for the runs
    // that get deleted.
    assert.equal(runDirSurvived, false, 'the failed run was purged');
    assert.match(runLog, /Starting crawl with \d+ URL/);
    assert.match(runLog, /Nothing extractable after/);
  },
);

test('a site that refuses every request is abandoned too', { timeout: 120_000 }, async () => {
  const { result, failures, pageFetches } = await crawlBarrenSite(() => ({
    status: 403,
    body: FORBIDDEN,
  }));

  // 401, 403 and 429 never reach the request handler: Crawlee's session pool
  // throws on them first, so they arrive as failed requests instead. That is
  // why the refusal is counted in both places rather than only at the status
  // gate -- reading the code alone, this path looks like the dead one.
  assert.equal(result.pagesSaved, 0, 'a refused request is not content');
  assert.ok(pageFetches < SITEMAP_SIZE / 2, `stopped early: fetched ${pageFetches}`);
  assert.match(failures[0]!.errorSummary ?? '', /were refused with a 401, 403, 429/);
});

test(
  'an error page that is not a refusal is never stored as corpus',
  { timeout: 120_000 },
  async () => {
    // 404 is not in Crawlee's blocked set and is under 500, so unlike a 403 it
    // arrives at the request handler with its body attached and goes down the
    // normal save path. This body carries far more than the prose floor, so
    // without the status gate every one of these was persisted as a page.
    const { result, failures, pageWrites, pageFetches } = await crawlBarrenSite(() => ({
      status: 404,
      body: FORBIDDEN,
    }));

    assert.equal(result.pagesSaved, 0, 'a 404 body is the error page, not the site');
    assert.equal(pageWrites, 0, 'and none of it may reach GeekAPI');

    // A missing page says nothing about whether the site serves its other URLs,
    // so this must NOT count toward abandoning it: the run crawls the sitemap
    // out and ends without an abort.
    assert.equal(failures.length, 0, 'a wall of 404s is not grounds to abandon a site');
    assert.ok(
      pageFetches > SITEMAP_SIZE * 0.9,
      `kept going rather than stopping at the threshold: ${pageFetches} of ${SITEMAP_SIZE}`,
    );
  },
);

test(
  'a site that refuses in several different ways is still abandoned',
  { timeout: 120_000 },
  async () => {
    // The hole that two separate counters left: no single kind reaches the
    // threshold, while the site has plainly given the run nothing at all.
    const { result, failures, pageFetches } = await crawlBarrenSite((index) => {
      if (index % 3 === 0) return { status: 403, body: FORBIDDEN };
      if (index % 3 === 1) return { status: 200, body: LOUD_SHELL };
      return { status: 200, body: QUIET_SHELL };
    });

    assert.equal(result.pagesSaved, 0);
    assert.ok(pageFetches < SITEMAP_SIZE / 2, `stopped early: fetched ${pageFetches}`);

    const summary = failures[0]!.errorSummary ?? '';
    assert.match(summary, /Nothing extractable after/);
    // All three kinds contributed, and the sentence says so.
    assert.match(summary, /returned a JavaScript shell/);
    assert.match(summary, /were refused with a 401, 403, 429/);
    assert.match(summary, /parsed but carried no prose/);
  },
);
