import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startCrawl } from '../../src/crawl/orchestrator.js';
import { listFailures } from '../../src/storage/failure-archive.js';
import { startFixtureSite } from '../fixtures/site.js';

const RUN_ID = '55555555-6666-4777-8888-999999999999';

/** GeekAPI that accepts the run and its pages, then refuses every link batch. */
async function startFailingGeekApi(): Promise<{
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

test(
  'a failed crawl destroys itself and leaves only its post-mortem',
  { timeout: 120_000 },
  async () => {
    const geek = await startFailingGeekApi();
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

      assert.equal(geek.deleteCalls(), 1, 'exactly one purge, no retry');

      const failures = await listFailures(dataDir);
      assert.equal(failures.length, 1, 'the post-mortem is what survives');
      const record = failures[0]!;
      assert.equal(record.status, 'failed');
      assert.equal(record.runId, RUN_ID);
      assert.match(record.errorSummary ?? '', /links\/batch/);
      assert.equal(record.purge.crawlDataDeleted, true);

      assert.equal(
        await exists(path.join(dataDir, 'runs', RUN_ID)),
        false,
        'the local run directory must be gone',
      );
      assert.equal(
        await exists(path.join(dataDir, '.crawlee', RUN_ID)),
        false,
        'the request queue must be gone',
      );
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
  },
);
