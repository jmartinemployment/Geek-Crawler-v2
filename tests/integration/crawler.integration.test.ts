import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startCrawl } from '../../src/crawl/orchestrator.js';
import type { CrawlPageMeta } from '../../src/storage/runs.js';
import { startFixtureSite } from '../fixtures/site.js';

async function tempDataDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'geek-crawler-e2e-'));
}

async function readJsonLines<T>(file: string): Promise<T[]> {
  const text = await readFile(file, 'utf8');
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function forceLocalPersistence(): () => void {
  const keys = ['GEEK_API_URL', 'GEEK_BACKEND_API_KEY', 'GEEK_USER_ID'] as const;
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  return () => {
    for (const key of keys) {
      const value = old[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test('real crawler follows nested sitemap, retries, renders SPA, and persists content', { timeout: 120_000 }, async () => {
  const restoreEnv = forceLocalPersistence();
  const fixture = await startFixtureSite();
  const dataDir = await tempDataDir();
  try {
    const result = await startCrawl({
      seeds: [`${fixture.origin}/`],
      crawlType: 'partner',
      dataDir,
      maxConcurrency: 1,
    });

    assert.equal(result.persistMode, 'local');
    assert.ok(result.pagesSaved >= 6, `expected at least six persisted attempts, got ${result.pagesSaved}`);
    assert.ok(result.pagesRejectedChallenge >= 1);
    assert.equal(result.pagesRejectedLocale, 0, 'locale sitemap entries should be filtered before fetch');
    assert.ok(fixture.requests('/retry') >= 3, '503 fixture should exercise Crawlee retries');
    assert.equal(fixture.requests('/fr/article'), 0);
    assert.equal(fixture.requests('/blocked'), 0);

    const runDir = path.join(dataDir, 'runs', result.runId);
    const pages = await readJsonLines<CrawlPageMeta>(path.join(runDir, 'pages.jsonl'));
    const links = await readJsonLines<{ linkUrl: string }>(path.join(runDir, 'links.jsonl'));
    const article = pages.find((page) => page.finalUrl === `${fixture.origin}/article`);
    const spa = pages.find((page) => page.finalUrl === `${fixture.origin}/spa`);
    const blocked = pages.find((page) => page.url === `${fixture.origin}/blocked`);

    assert.ok(article?.bodyKey);
    assert.ok(article?.markdownBodyKey);
    assert.equal(article?.title, 'Fixture Article');
    assert.equal(spa?.fetchMode, 'playwright');
    assert.equal(spa?.title, 'SPA Fixture');
    assert.ok(spa?.markdownBodyKey);
    assert.equal(blocked?.robotsAllowed, false);
    assert.equal(blocked?.failureReason, 'robots_disallowed');
    assert.ok(links.some((link) => link.linkUrl.includes('/long')));

    const html = await readFile(path.join(dataDir, article!.bodyKey), 'utf8');
    const markdown = await readFile(path.join(dataDir, article!.markdownBodyKey!), 'utf8');
    assert.match(html, /Exact fixture section/);
    const spaMarkdown = await readFile(path.join(dataDir, spa!.markdownBodyKey!), 'utf8');
    assert.match(markdown, /persisted markdown must retain this exact deterministic sentence/i);
    assert.match(spaMarkdown, /Rendered SPA Article/);
  } finally {
    restoreEnv();
    await fixture.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('real crawler uses same-site BFS and strips tracking duplicates without a sitemap', { timeout: 60_000 }, async () => {
  const restoreEnv = forceLocalPersistence();
  const fixture = await startFixtureSite({ sitemap: false });
  const dataDir = await tempDataDir();
  try {
    const result = await startCrawl({
      seeds: [`${fixture.origin}/`],
      crawlType: 'local',
      dataDir,
      maxConcurrency: 1,
      maxRequestsPerCrawl: 10,
    });
    const pages = await readJsonLines<CrawlPageMeta>(
      path.join(dataDir, 'runs', result.runId, 'pages.jsonl'),
    );
    const urls = pages.map((page) => page.url);

    assert.ok(urls.includes(`${fixture.origin}/nested/one`));
    assert.ok(urls.includes(`${fixture.origin}/nested/two`));
    assert.equal(urls.filter((url) => url.startsWith(`${fixture.origin}/article`)).length, 1);
    assert.equal(fixture.requests('/fr/article'), 0);
  } finally {
    restoreEnv();
    await fixture.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
