import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { GeekApiClient } from './geek-api-client.js';

test('link ingest respects the 2,000-item API limit', async () => {
  const batchSizes: number[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    const parsed = JSON.parse(body) as { links: unknown[] };
    batchSizes.push(parsed.links.length);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ count: parsed.links.length }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const client = new GeekApiClient(
    `http://127.0.0.1:${address.port}`,
    'test-key',
    'test-user',
  );

  try {
    for (const count of [0, 1, 2_000, 2_001, 4_501]) {
      batchSizes.length = 0;
      const links = Array.from({ length: count }, (_, index) => ({
        pageId: 'page-1',
        fromUrl: 'https://example.com',
        linkUrl: `https://example.com/${index}`,
        isSameOrigin: true,
      }));
      assert.equal(await client.createLinksBatch('run-1', links), count);
      const expected =
        count === 0
          ? []
          : count === 1
          ? [1]
          : count === 2_000
            ? [2_000]
            : count === 2_001
              ? [2_000, 1]
              : [2_000, 2_000, 501];
      assert.deepEqual(batchSizes, expected);
    }
  } finally {
    server.close();
  }
});

test('link ingest retries a transient failed chunk', async () => {
  let attempts = 0;
  const server = createServer((_req, res) => {
    attempts += 1;
    if (attempts === 1) {
      res.statusCode = 503;
      return res.end('retry');
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ count: 1 }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const client = new GeekApiClient(
    `http://127.0.0.1:${address.port}`,
    'test-key',
    'test-user',
  );

  try {
    const count = await client.createLinksBatch('run-1', [
      {
        pageId: 'page-1',
        fromUrl: 'https://example.com',
        linkUrl: 'https://example.com/next',
        isSameOrigin: true,
      },
    ]);
    assert.equal(count, 1);
    assert.equal(attempts, 2);
  } finally {
    server.close();
  }
});
