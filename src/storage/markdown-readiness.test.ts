import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCrawlPersist } from './persist.js';

test('API persistence marks completed Markdown runs ready and clears on resume', async () => {
  const patches: Array<Record<string, unknown>> = [];
  const runId = '11111111-2222-4333-8444-555555555555';
  const server = createServer(async (req, res) => {
    const body = await new Promise<string>((resolve) => {
      let text = '';
      req.on('data', (chunk) => (text += chunk));
      req.on('end', () => resolve(text));
    });
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url?.endsWith('/ingest/runs')) {
      return res.end(JSON.stringify({ runId, status: 'external', crawlType: 'partner' }));
    }
    if (req.method === 'POST' && req.url?.endsWith('/pages/batch')) {
      return res.end(JSON.stringify({ pages: [{ url: 'https://example.com', pageId: 'page-1' }] }));
    }
    if (req.method === 'PATCH') {
      patches.push(JSON.parse(body) as Record<string, unknown>);
      return res.end(JSON.stringify({ runId, status: 'complete', crawlType: 'partner' }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'crawler-readiness-'));
  const oldEnv = {
    url: process.env.GEEK_API_URL,
    key: process.env.GEEK_BACKEND_API_KEY,
    user: process.env.GEEK_USER_ID,
  };
  process.env.GEEK_API_URL = `http://127.0.0.1:${address.port}`;
  process.env.GEEK_BACKEND_API_KEY = 'test-key';
  process.env.GEEK_USER_ID = 'test-user';

  try {
    const persist = createCrawlPersist({
      crawlType: 'partner',
      seeds: ['https://example.com'],
      dataDir,
    });
    await persist.begin();
    await persist.savePage({
      url: 'https://example.com',
      html: '<main>Example</main>',
      markdown: '# Example',
      robotsAllowed: true,
      fetchMode: 'cheerio',
    });
    await persist.markComplete();
    await persist.beginResume();

    assert.equal(patches[0]?.status, 'complete');
    assert.equal(patches[0]?.markdownReadyAt, patches[0]?.completedAtUtc);
    assert.equal(patches[0]?.clearMarkdownReadyAt, false);
    assert.equal(patches[1]?.clearMarkdownReadyAt, true);
  } finally {
    if (oldEnv.url === undefined) delete process.env.GEEK_API_URL;
    else process.env.GEEK_API_URL = oldEnv.url;
    if (oldEnv.key === undefined) delete process.env.GEEK_BACKEND_API_KEY;
    else process.env.GEEK_BACKEND_API_KEY = oldEnv.key;
    if (oldEnv.user === undefined) delete process.env.GEEK_USER_ID;
    else process.env.GEEK_USER_ID = oldEnv.user;
    server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
