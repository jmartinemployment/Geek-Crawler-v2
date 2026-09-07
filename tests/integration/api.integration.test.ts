import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Configuration, RequestQueue } from 'crawlee';
import { createCrawlApiServer } from '../../src/api/server.js';
import { createJsonRunStore } from '../../src/storage/runs.js';
import { startFixtureSite } from '../fixtures/site.js';

type Api = ReturnType<typeof createCrawlApiServer>;

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

async function waitForWork(api: Api, runId: string): Promise<void> {
  const work = api.inFlight.get(runId);
  assert.ok(work, `expected ${runId} to be in flight`);
  await work;
}

async function json(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

test('crawler API covers validation, wait mode, status, pages, and malformed JSON', { timeout: 60_000 }, async () => {
  const fixture = await startFixtureSite({ sitemap: false });
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'geek-crawler-api-'));
  const { api, origin } = await startApi(dataDir);
  try {
    const health = await fetch(`${origin}/health`);
    assert.equal(health.status, 200);
    assert.equal((await json(health)).ok, true);

    const missing = await fetch(`${origin}/crawls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(missing.status, 400);

    const multiple = await fetch(`${origin}/crawls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seeds: [`${fixture.origin}/`, `${fixture.origin}/article`] }),
    });
    assert.equal(multiple.status, 400);

    const malformed = await fetch(`${origin}/crawls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"seed":',
    });
    assert.equal(malformed.status, 400);

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
    assert.equal(started.ok, true);
    assert.ok(started.runId);

    const status = await fetch(`${origin}/crawls/${started.runId}`);
    assert.equal(status.status, 200);
    assert.equal((await json(status)).status, 'complete');

    const pages = await fetch(`${origin}/crawls/${started.runId}/pages`);
    assert.equal(pages.status, 200);
    assert.equal((await json(pages)).pages.length, 1);
    assert.equal((await fetch(`${origin}/crawls/missing`)).status, 404);
    assert.equal((await fetch(`${origin}/crawls/missing/pages`)).status, 404);
  } finally {
    await closeServer(api.server);
    await fixture.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('background crawl can resume its persisted queue after an API server restart', { timeout: 90_000 }, async () => {
  const fixture = await startFixtureSite({ sitemap: false, slowMs: 20 });
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'geek-crawler-resume-'));
  const first = await startApi(dataDir);
  let second: Awaited<ReturnType<typeof startApi>> | undefined;
  try {
    const response = await fetch(`${first.origin}/crawls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        seed: `${fixture.origin}/article`,
        maxRequestsPerCrawl: 1,
        maxConcurrency: 1,
      }),
    });
    assert.equal(response.status, 202);
    const started = await json(response);
    await waitForWork(first.api, started.runId);
    const backgroundStatus = await json(await fetch(`${first.origin}/crawls/${started.runId}`));
    assert.equal(backgroundStatus.status, 'complete');

    const resumeRunId = 'persisted-resume-run';
    const store = createJsonRunStore(dataDir);
    await store.createRun({
      runId: resumeRunId,
      crawlType: 'local',
      seeds: [`${fixture.origin}/`],
    });
    await store.markRunning(resumeRunId);
    const queueConfig = new Configuration({
      purgeOnStart: false,
      storageClientOptions: {
        localDataDirectory: path.join(dataDir, '.crawlee', resumeRunId),
      },
    });
    const queue = await RequestQueue.open(null, { config: queueConfig });
    await queue.addRequests([
      { url: `${fixture.origin}/nested/one` },
      { url: `${fixture.origin}/nested/two` },
    ]);

    await closeServer(first.api.server);
    second = await startApi(dataDir);
    const resumed = await fetch(`${second.origin}/crawls/resume-running`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxConcurrency: 1, maxRequestsPerCrawl: 10 }),
    });
    assert.equal(resumed.status, 200);
    const resumeBody = await json(resumed);
    assert.deepEqual(resumeBody.failed, []);
    assert.equal(resumeBody.resumed.length, 1);
    assert.equal(resumeBody.resumed[0].runId, resumeRunId);
    await waitForWork(second.api, resumeRunId);

    const completed = await json(await fetch(`${second.origin}/crawls/${resumeRunId}`));
    assert.equal(completed.status, 'complete');
    assert.ok(completed.pagesSaved >= 2, `expected resumed queue pages, got ${completed.pagesSaved}`);

    const byUrl = await fetch(`${second.origin}/crawls/resume-by-url`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `${fixture.origin}/` }),
    });
    assert.equal(byUrl.status, 202);
    await waitForWork(second.api, resumeRunId);
  } finally {
    if (second?.api.server.listening) await closeServer(second.api.server);
    if (first.api.server.listening) await closeServer(first.api.server);
    await fixture.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test.todo('cancellation should stop active Crawlee work and persist cancelled status');
