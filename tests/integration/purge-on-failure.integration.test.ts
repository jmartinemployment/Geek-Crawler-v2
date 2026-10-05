import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startCrawl } from '../../src/crawl/orchestrator.js';
import { listFailures, type FailureRecord } from '../../src/storage/failure-archive.js';
import { startFixtureSite } from '../fixtures/site.js';

const RUN_ID = '55555555-6666-4777-8888-999999999999';

/**
 * How the link batch fails, which is the whole point of these two tests.
 *
 * `determinate` is GeekAPI answering for itself: a 400 in its own ProblemDetails shape, a judgement
 * about this crawl. `unreachable` is the shape that cost 603 pages on 2026-09-30 — a 5xx, or
 * Railway's edge answering `{"message":"Application not found"}` mid-deploy, neither of which says
 * anything about the run.
 */
type LinkFailure = 'determinate' | 'unreachable-5xx' | 'unreachable-platform-404';

/** GeekAPI that accepts the run and its pages, then refuses every link batch. */
async function startFailingGeekApi(failure: LinkFailure): Promise<{
  origin: string;
  close: () => void;
  deleteCalls: () => number;
}> {
  let pageWrites = 0;
  let deleteCalls = 0;
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
      pageWrites += 1;
      const parsed = JSON.parse(body) as { pages: Array<{ url: string }> };
      return res.end(
        JSON.stringify({
          pages: parsed.pages.map((p, i) => ({ url: p.url, pageId: `page-${pageWrites}-${i}` })),
        }),
      );
    }
    if (req.method === 'POST' && req.url?.includes('/links/batch')) {
      if (failure === 'determinate') {
        res.statusCode = 400;
        return res.end(
          JSON.stringify({
            type: 'https://tools.ietf.org/html/rfc9110#section-15.5.1',
            title: 'Bad Request',
            detail: 'links refused: pageId does not belong to this run',
            traceId: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-00',
          }),
        );
      }
      if (failure === 'unreachable-platform-404') {
        // Byte-for-byte what the Railway edge returns while the service redeploys. It is a 404, so
        // only the body distinguishes it from GeekAPI saying the run is gone.
        res.statusCode = 404;
        return res.end(JSON.stringify({ status: 404, code: 'NOT_FOUND', request_id: 'abc123' }));
      }
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: 'links refused' }));
    }
    if (req.method === 'DELETE') {
      deleteCalls += 1;
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
    close: () => server.close(),
    deleteCalls: () => deleteCalls,
  };
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Drive one crawl against a GeekAPI that refuses the link batch in the given way, and hand back
 * everything the caller needs to judge what survived.
 */
async function crawlAgainstFailure(failure: LinkFailure): Promise<{
  deleteCalls: number;
  failures: FailureRecord[];
  runDirExists: boolean;
  queueDirExists: boolean;
  cacheFiles: string[];
}> {
  const geek = await startFailingGeekApi(failure);
  const fixture = await startFixtureSite();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'geek-crawler-purge-'));
  const old = {
    url: process.env.GEEK_API_URL,
    key: process.env.GEEK_BACKEND_API_KEY,
    user: process.env.GEEK_USER_ID,
  };
  process.env.GEEK_API_URL = geek.origin;
  process.env.GEEK_BACKEND_API_KEY = 'test-key';
  process.env.GEEK_USER_ID = 'test-user';

  try {
    await assert.rejects(
      () =>
        startCrawl({
          seeds: [`${fixture.origin}/`],
          crawlType: 'partner',
          dataDir,
          maxConcurrency: 1,
        }),
      'a link persistence failure must fail the run',
    );

    const cacheDir = path.join(dataDir, 'extract-cache', RUN_ID);
    return {
      deleteCalls: geek.deleteCalls(),
      failures: await listFailures(dataDir),
      runDirExists: await exists(path.join(dataDir, 'runs', RUN_ID)),
      queueDirExists: await exists(path.join(dataDir, '.crawlee', RUN_ID)),
      cacheFiles: (await exists(cacheDir)) ? (await readdir(cacheDir)).sort() : [],
    };
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
}

test(
  'a determinately refused crawl destroys itself and leaves only its post-mortem',
  { timeout: 120_000 },
  async () => {
    const out = await crawlAgainstFailure('determinate');

    assert.equal(out.deleteCalls, 1, 'exactly one purge, no retry');

    assert.equal(out.failures.length, 1, 'the post-mortem is what survives');
    const record = out.failures[0]!;
    assert.equal(record.status, 'failed');
    assert.equal(record.runId, RUN_ID);
    assert.match(record.errorSummary ?? '', /links\/batch/);
    assert.equal(record.purge?.crawlDataDeleted, true);
    assert.ok(record.purgedAtUtc, 'a purged run carries the time it was purged');

    assert.equal(out.runDirExists, false, 'the local run directory must be gone');
    assert.equal(out.queueDirExists, false, 'the request queue must be gone');

    // The extract cache is the exception, and deliberately so. Every run fails
    // while GeekAPI rejects contentHtml, so a cache inside run scratch would be
    // destroyed on precisely the crawls worth inspecting. It has to outlive the
    // purge for offline chunking to have a corpus at all.
    assert.ok(out.cacheFiles.length > 0, 'the extract cache must survive the purge');
    assert.ok(
      out.cacheFiles.some((f) => f.endsWith('.blocks.json')),
      'the typed blocks survive',
    );
    assert.ok(
      out.cacheFiles.some((f) => f.endsWith('.content.html')),
      'the clean fragment survives',
    );
  },
);

// An interrupted run is deleted, whatever interrupted it (Jeff, 2026-10-05). From 2026-09-30 a run
// that failed because GeekAPI was absent was kept "for re-post" instead, but nothing could re-post
// it, and the run sat `external` on GeekAPI and `running` here. Now a 5xx and a Railway edge 404
// purge exactly as a determinate refusal does: post-mortem first, then the delete.
for (const failure of ['unreachable-5xx', 'unreachable-platform-404'] as const) {
  test(
    `a crawl that failed because GeekAPI was absent (${failure}) is deleted`,
    { timeout: 120_000 },
    async () => {
      const out = await crawlAgainstFailure(failure);

      assert.equal(out.deleteCalls, 1, 'an interrupted run is purged, exactly once');

      assert.equal(out.failures.length, 1, 'the post-mortem is what survives');
      const record = out.failures[0]!;
      assert.equal(record.status, 'failed');
      assert.equal(record.runId, RUN_ID);
      assert.match(record.errorSummary ?? '', /links\/batch/);
      assert.equal(record.purge?.crawlDataDeleted, true);
      assert.ok(record.purgedAtUtc, 'a purged run carries the time it was purged');

      assert.equal(out.runDirExists, false, 'the local run directory must be gone');
      assert.equal(out.queueDirExists, false, 'the request queue must be gone');
      assert.ok(out.cacheFiles.length > 0, 'the extract cache survives, as for any purge');
    },
  );
}
