import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCrawlApiServer } from '../../src/api/server.js';
import { startFixtureSite } from '../fixtures/site.js';

type Api = ReturnType<typeof createCrawlApiServer>;

async function startMockGeekApi(): Promise<{ origin: string; close: () => void }> {
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
            runId: `11111111-1111-4111-8111-${String(runSeq).padStart(12, '0')}`,
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
      const parsed = JSON.parse(body) as { pages: Array<{ url: string }> };
      return res.end(
        JSON.stringify({
          pages: parsed.pages.map((p, i) => ({ url: p.url, pageId: `p-${i}` })),
        }),
      );
    }
    if (req.method === 'POST' && req.url?.includes('/links/batch')) {
      const parsed = JSON.parse(body) as { links: unknown[] };
      return res.end(JSON.stringify({ count: parsed.links.length }));
    }
    if (req.method === 'PATCH') {
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
  };
}

async function startApi(dataDir: string): Promise<{ api: Api; origin: string }> {
  const api = createCrawlApiServer({ dataDir, port: 0 });
  await api.listen();
  const address = api.server.address();
  if (!address || typeof address === 'string') throw new Error('Crawler API did not bind');
  return { api, origin: `http://127.0.0.1:${address.port}` };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

async function json(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

test('crawler API covers validation, wait mode, status, and resume forbidden', { timeout: 60_000 }, async () => {
  const geek = await startMockGeekApi();
  const fixture = await startFixtureSite({ sitemap: false });
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'geek-crawler-api-'));
  const old = {
    url: process.env.GEEK_API_URL,
    key: process.env.GEEK_BACKEND_API_KEY,
    user: process.env.GEEK_USER_ID,
  };
  process.env.GEEK_API_URL = geek.origin;
  process.env.GEEK_BACKEND_API_KEY = 'test-key';
  process.env.GEEK_USER_ID = 'test-user';
  const { api, origin } = await startApi(dataDir);
  try {
    const health = await fetch(`${origin}/health`);
    assert.equal(health.status, 200);

    const missing = await fetch(`${origin}/crawls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(missing.status, 400);

    const waited = await fetch(`${origin}/crawls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        seed: `${fixture.origin}/article`,
        crawlType: 'local',
        maxRequestsPerCrawl: 1,
        maxConcurrency: 1,
        wait: true,
      }),
    });
    assert.equal(waited.status, 200);
    const started = await json(waited);
    assert.ok(started.runId);

    const status = await fetch(`${origin}/crawls/${started.runId}`);
    assert.equal(status.status, 200);
    assert.equal((await json(status)).status, 'complete');

    const resumed = await fetch(`${origin}/crawls/resume-running`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(resumed.status, 409);
    assert.equal((await json(resumed)).code, 'RESUME_FORBIDDEN');

    const byUrl = await fetch(`${origin}/crawls/resume-by-url`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `${fixture.origin}/` }),
    });
    assert.equal(byUrl.status, 409);
  } finally {
    await closeServer(api.server);
    await fixture.close();
    geek.close();
    if (old.url === undefined) delete process.env.GEEK_API_URL;
    else process.env.GEEK_API_URL = old.url;
    if (old.key === undefined) delete process.env.GEEK_BACKEND_API_KEY;
    else process.env.GEEK_BACKEND_API_KEY = old.key;
    if (old.user === undefined) delete process.env.GEEK_USER_ID;
    else process.env.GEEK_USER_ID = old.user;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test(
  'a second crawl of a seed already in flight is refused, not allowed to supersede it',
  { timeout: 60_000 },
  async () => {
    const geek = await startMockGeekApi();
    // Slow pages keep the first crawl in flight while the duplicate is submitted,
    // so the assertion does not race the fixture finishing.
    const fixture = await startFixtureSite({ sitemap: false, slowMs: 250 });
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'geek-crawler-seedguard-'));
    const old = {
      url: process.env.GEEK_API_URL,
      key: process.env.GEEK_BACKEND_API_KEY,
      user: process.env.GEEK_USER_ID,
    };
    process.env.GEEK_API_URL = geek.origin;
    process.env.GEEK_BACKEND_API_KEY = 'test-key';
    process.env.GEEK_USER_ID = 'test-user';
    const { api, origin } = await startApi(dataDir);

    const submit = (seed: string) =>
      fetch(`${origin}/crawls`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seed, crawlType: 'local', maxConcurrency: 1 }),
      });

    try {
      const first = await submit(`${fixture.origin}/`);
      assert.equal(first.status, 202);
      const firstRunId = (await json(first)).runId as string;
      assert.ok(firstRunId);

      // The whole point: GeekAPI would drop `firstRunId` the moment a second run
      // claimed its seedKey, and the first crawl would start 404ing mid-flight.
      const duplicate = await submit(`${fixture.origin}/`);
      assert.equal(duplicate.status, 409, 'the duplicate seed must be refused');
      const body = await json(duplicate);
      assert.equal(body.code, 'SEED_IN_FLIGHT');
      assert.equal(body.runId, firstRunId, 'the refusal names the run it protected');

      // Keyed on seedKey, not origin: a different seed on the same host is a
      // different run on GeekAPI and must not be blocked.
      const sibling = await submit(`${fixture.origin}/article`);
      assert.equal(sibling.status, 202, 'a distinct seed on the same host still runs');

      // Once the run settles the claim is released, so the seed is crawlable again.
      const deadline = Date.now() + 40_000;
      let released = false;
      while (Date.now() < deadline) {
        const again = await submit(`${fixture.origin}/`);
        if (again.status === 202) {
          released = true;
          break;
        }
        assert.equal(again.status, 409, 'while in flight it stays refused');
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert.ok(released, 'the seed claim is released when the run settles');

      // Let every crawl this test started reach a terminal state before the
      // fixture and dataDir go away; tearing down under a live crawl races its
      // writes and fails the cleanup rather than the assertion.
      const settleBy = Date.now() + 40_000;
      while (Date.now() < settleBy) {
        const listed = await json(await fetch(`${origin}/crawls`));
        const runs = (listed.runs ?? []) as Array<{ status?: string }>;
        if (!runs.some((r) => r.status === 'running')) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } finally {
      await closeServer(api.server);
      await fixture.close();
      geek.close();
      if (old.url === undefined) delete process.env.GEEK_API_URL;
      else process.env.GEEK_API_URL = old.url;
      if (old.key === undefined) delete process.env.GEEK_BACKEND_API_KEY;
      else process.env.GEEK_BACKEND_API_KEY = old.key;
      if (old.user === undefined) delete process.env.GEEK_USER_ID;
      else process.env.GEEK_USER_ID = old.user;
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);

test('cancelling a live crawl stops fetching and lands it in cancelled, never complete', { timeout: 60_000 }, async () => {
  // A mock that records every status the crawler patches and acknowledges the purge that a cancel
  // performs: cancel is destructive, so the run's data is deleted after its post-mortem is written.
  const statuses: string[] = [];
  let deletes = 0;
  let runSeq = 0;
  const geek = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url?.endsWith('/ingest/runs')) {
      runSeq += 1;
      const seeds = (JSON.parse(body) as { seeds?: string[] }).seeds ?? [];
      return res.end(
        JSON.stringify({
          run: {
            runId: `22222222-2222-4222-8222-${String(runSeq).padStart(12, '0')}`,
            status: 'external',
            crawlType: 'local',
            seedUrls: seeds,
          },
          seedsAccepted: seeds.length,
          rejected: [],
        }),
      );
    }
    if (req.method === 'POST' && req.url?.includes('/pages/batch')) {
      const parsed = JSON.parse(body) as { pages: Array<{ url: string }> };
      return res.end(
        JSON.stringify({ pages: parsed.pages.map((p, i) => ({ url: p.url, pageId: `c-${i}` })) }),
      );
    }
    if (req.method === 'POST' && req.url?.includes('/links/batch')) {
      const parsed = JSON.parse(body) as { links: unknown[] };
      return res.end(JSON.stringify({ count: parsed.links.length }));
    }
    if (req.method === 'PATCH') {
      const status = String((JSON.parse(body) as { status?: string }).status ?? '');
      statuses.push(status);
      return res.end(JSON.stringify({ runId: 'x', status, crawlType: 'local' }));
    }
    if (req.method === 'DELETE') {
      deletes += 1;
      return res.end(JSON.stringify({ vectorsPurged: true, crawlDataDeleted: true }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((resolve) => geek.listen(0, '127.0.0.1', resolve));
  const geekAddress = geek.address();
  assert(geekAddress && typeof geekAddress !== 'string');

  // 400ms a page with one fetch at a time: the sitemap's dozen urls take seconds, so the cancel
  // lands with most of the queue unfetched.
  const fixture = await startFixtureSite({ slowMs: 400 });
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'geek-crawler-cancel-'));
  const old = {
    url: process.env.GEEK_API_URL,
    key: process.env.GEEK_BACKEND_API_KEY,
    user: process.env.GEEK_USER_ID,
  };
  process.env.GEEK_API_URL = `http://127.0.0.1:${geekAddress.port}`;
  process.env.GEEK_BACKEND_API_KEY = 'test-key';
  process.env.GEEK_USER_ID = 'test-user';
  const { api, origin } = await startApi(dataDir);
  try {
    const started = await fetch(`${origin}/crawls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seed: `${fixture.origin}/`, crawlType: 'local', maxConcurrency: 1 }),
    });
    assert.equal(started.status, 202);
    const runId = (await json(started)).runId as string;

    // Cancel mid-crawl, not before it starts: the robots and sitemap preflight are slowed too, so a
    // fixed delay can land before the first page is fetched.
    const startBy = Date.now() + 20_000;
    while (Date.now() < startBy && fixture.totalRequests() < 2) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(fixture.totalRequests() >= 2, 'the crawl must be fetching pages before it is cancelled');
    const cancel = await fetch(`${origin}/crawls/${runId}/cancel`, { method: 'POST' });
    assert.equal(cancel.status, 202);
    const cancelBody = await json(cancel);
    assert.equal(cancelBody.cancelling, true, 'a live run cancels itself');
    assert.equal(cancelBody.orphan, false);
    const fetchedAtCancel = fixture.totalRequests();

    const deadline = Date.now() + 30_000;
    // Both, not the patch alone: archiveAndPurge writes the archive to disk between the cancelled
    // patch and the purge DELETE, so stopping at the patch races the DELETE.
    while (Date.now() < deadline && !(statuses.includes('cancelled') && deletes === 1)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(statuses.includes('cancelled'), `expected a cancelled patch, saw ${statuses.join(',')}`);
    assert.ok(!statuses.includes('complete'), 'a cancelled run is never reported complete');
    assert.equal(deletes, 1, 'cancel purges the run after archiving it');
    // The page in flight when the cancel arrived may finish; nothing after it starts.
    assert.ok(
      fixture.totalRequests() <= fetchedAtCancel + 1,
      `fetching continued after cancel: ${fetchedAtCancel} then ${fixture.totalRequests()}`,
    );
    // The fixture sitemap lists 11 crawlable urls; a cancel that stopped nothing would fetch them all.
    assert.ok(fixture.totalRequests() < 8, `cancel stopped too late: ${fixture.totalRequests()} fetched`);
  } finally {
    await closeServer(api.server);
    await fixture.close();
    geek.close();
    if (old.url === undefined) delete process.env.GEEK_API_URL;
    else process.env.GEEK_API_URL = old.url;
    if (old.key === undefined) delete process.env.GEEK_BACKEND_API_KEY;
    else process.env.GEEK_BACKEND_API_KEY = old.key;
    if (old.user === undefined) delete process.env.GEEK_USER_ID;
    else process.env.GEEK_USER_ID = old.user;
    await rm(dataDir, { recursive: true, force: true });
  }
});

// The sweep deleted a request queue whenever stat on its run directory threw, whatever the error.
// Only a missing run directory makes a queue an orphan; anything else is reported and the queue kept.
test('the scratch sweep keeps a queue it cannot prove orphaned, and says why', { timeout: 30_000 }, async () => {
  const geek = await startMockGeekApi();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'geek-crawler-sweep-'));
  const old = {
    url: process.env.GEEK_API_URL,
    key: process.env.GEEK_BACKEND_API_KEY,
    user: process.env.GEEK_USER_ID,
  };
  process.env.GEEK_API_URL = geek.origin;
  process.env.GEEK_BACKEND_API_KEY = 'test-key';
  process.env.GEEK_USER_ID = 'test-user';
  // runs is a file, so stat(runs/<id>) fails with ENOTDIR rather than ENOENT.
  await writeFile(path.join(dataDir, 'runs'), 'not a directory');
  const queue = path.join(dataDir, '.crawlee', 'queue-1');
  await mkdir(queue, { recursive: true });
  const { api, origin } = await startApi(dataDir);
  try {
    const res = await fetch(`${origin}/maintenance/sweep-scratch`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.deepEqual(body.swept, []);
    assert.equal(body.failures.length, 1);
    assert.match(body.failures[0].error, /cannot stat .*ENOTDIR/);
    await access(queue);
  } finally {
    await closeServer(api.server);
    geek.close();
    if (old.url === undefined) delete process.env.GEEK_API_URL;
    else process.env.GEEK_API_URL = old.url;
    if (old.key === undefined) delete process.env.GEEK_BACKEND_API_KEY;
    else process.env.GEEK_BACKEND_API_KEY = old.key;
    if (old.user === undefined) delete process.env.GEEK_USER_ID;
    else process.env.GEEK_USER_ID = old.user;
    await rm(dataDir, { recursive: true, force: true });
  }
});
