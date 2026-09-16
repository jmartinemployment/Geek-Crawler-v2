import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
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
      return res.end(
        JSON.stringify({
          runId: `11111111-1111-4111-8111-${String(runSeq).padStart(12, '0')}`,
          status: 'external',
          crawlType: 'partner',
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

test.todo('cancellation should stop active Crawlee work and persist cancelled status');
