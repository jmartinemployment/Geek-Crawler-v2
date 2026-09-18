import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  GeekApiClient,
  MAX_BATCH_BODY_BYTES,
  MAX_LINKS_PER_BATCH,
  MAX_PAGE_DOCUMENT_BYTES,
  applyHtmlOmit,
  estimatePageDocumentBytes,
} from './geek-api-client.js';
import { PersistenceError } from './errors.js';
import { MONGO_BSON_MAX_DOCUMENT_BYTES } from './ingest-limits.js';

test('link ingest is a single atomic batch within the max', async () => {
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
    for (const count of [0, 1, MAX_LINKS_PER_BATCH]) {
      batchSizes.length = 0;
      const links = Array.from({ length: count }, (_, index) => ({
        pageId: 'page-1',
        fromUrl: 'https://example.com',
        linkUrl: `https://example.com/${index}`,
        isSameOrigin: true,
      }));
      assert.equal(await client.createLinksBatch('run-1', links), count);
      assert.deepEqual(batchSizes, count === 0 ? [] : [count]);
    }
    await assert.rejects(
      () =>
        client.createLinksBatch(
          'run-1',
          Array.from({ length: MAX_LINKS_PER_BATCH + 1 }, (_, index) => ({
            pageId: 'page-1',
            fromUrl: 'https://example.com',
            linkUrl: `https://example.com/${index}`,
            isSameOrigin: true,
          })),
        ),
      /exceeds atomic max/,
    );
  } finally {
    server.close();
  }
});

test('link ingest fails on first error without retry', async () => {
  let attempts = 0;
  const server = createServer((_req, res) => {
    attempts += 1;
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        error: {
          code: 'repository_error',
          message: 'unavailable',
          requestId: 'req-1',
        },
      }),
    );
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
    await assert.rejects(
      () =>
        client.createLinksBatch('run-1', [
          {
            pageId: 'page-1',
            fromUrl: 'https://example.com',
            linkUrl: 'https://example.com/next',
            isSameOrigin: true,
          },
        ]),
      (err: unknown) =>
        err instanceof PersistenceError &&
        /503/.test(err.message) &&
        /code=repository_error/.test(err.message) &&
        /requestId=req-1/.test(err.message),
    );
    assert.equal(attempts, 1);
  } finally {
    server.close();
  }
});

test('pages/batch fails on first 5xx without retry', async () => {
  let attempts = 0;
  const server = createServer((_req, res) => {
    attempts += 1;
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        error: { code: 'internal_error', message: 'boom', requestId: 'r2' },
      }),
    );
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
    await assert.rejects(
      () =>
        client.createPagesBatch('run-1', [
          {
            origin: 'https://example.com',
            url: 'https://example.com',
            statusCode: 200,
            robotsAllowed: true,
            contentHtml: '# hi',
          },
        ]),
      /500/,
    );
    assert.equal(attempts, 1);
  } finally {
    server.close();
  }
});

test('pages/batch omits oversized html before network and succeeds', async () => {
  let receivedHtml: string | null | undefined = 'sentinel';
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    const parsed = JSON.parse(body) as { pages: Array<{ html?: string | null }> };
    receivedHtml = parsed.pages[0]?.html;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        pages: [{ url: 'https://example.com/huge', pageId: 'p1' }],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const client = new GeekApiClient(
    `http://127.0.0.1:${address.port}`,
    'test-key',
    'test-user',
  );

  const hugeHtml = 'x'.repeat(MAX_PAGE_DOCUMENT_BYTES);
  try {
    const created = await client.createPagesBatch('run-1', [
      {
        origin: 'https://example.com',
        url: 'https://example.com/huge',
        statusCode: 200,
        robotsAllowed: true,
        html: hugeHtml,
        contentHtml: 'ok',
      },
    ]);
    assert.equal(created[0]?.pageId, 'p1');
    assert.equal(receivedHtml, null);
  } finally {
    server.close();
  }
});

test('pages/batch rejects a body that exceeds document limit without calling network', async () => {
  let attempts = 0;
  const server = createServer((_req, res) => {
    attempts += 1;
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const client = new GeekApiClient(
    `http://127.0.0.1:${address.port}`,
    'test-key',
    'test-user',
  );
  const hugeBody = 'm'.repeat(MAX_PAGE_DOCUMENT_BYTES + 10_000);
  try {
    await assert.rejects(
      () =>
        client.createPagesBatch('run-1', [
          {
            origin: 'https://example.com',
            url: 'https://example.com/md',
            statusCode: 200,
            robotsAllowed: true,
            contentHtml: hugeBody,
          },
        ]),
      /page_document_too_large/,
    );
    assert.equal(attempts, 0);
  } finally {
    server.close();
  }
});

test('applyHtmlOmit keeps mongo overflow html from being persistable', () => {
  const overMongo = 'z'.repeat(MONGO_BSON_MAX_DOCUMENT_BYTES + 100_000);
  const result = applyHtmlOmit({
    origin: 'https://example.com',
    url: 'https://example.com/overflow',
    html: overMongo,
    contentHtml: 'safe',
  });
  assert.equal(result.fits, true);
  assert.equal(result.html, null);
  assert.ok(result.estimatedBytes <= MAX_PAGE_DOCUMENT_BYTES);
  assert.ok(result.estimatedBytes < MONGO_BSON_MAX_DOCUMENT_BYTES);
});

test('estimatePageDocumentBytes uses utf8 not char length', () => {
  const ascii = estimatePageDocumentBytes({
    origin: 'https://example.com',
    url: 'https://example.com/a',
    html: 'a'.repeat(1000),
  });
  const multi = estimatePageDocumentBytes({
    origin: 'https://example.com',
    url: 'https://example.com/a',
    html: 'é'.repeat(1000),
  });
  assert.ok(multi > ascii);
});

test('pages/batch requires canonical pages schema', async () => {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ Pages: [{ Url: 'https://example.com', PageId: 'x' }] }));
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
    await assert.rejects(
      () =>
        client.createPagesBatch('run-1', [
          {
            origin: 'https://example.com',
            url: 'https://example.com',
            statusCode: 200,
            robotsAllowed: true,
          },
        ]),
      /missing pages array/,
    );
  } finally {
    server.close();
  }
});

test('links/batch requires count === submitted length', async () => {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ count: 0 }));
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
    await assert.rejects(
      () =>
        client.createLinksBatch('run-1', [
          {
            pageId: 'page-1',
            fromUrl: 'https://example.com',
            linkUrl: 'https://example.com/next',
            isSameOrigin: true,
          },
        ]),
      /count 0 !== submitted 1/,
    );
  } finally {
    server.close();
  }
});

test('limits constants align with plan', () => {
  assert.equal(MAX_PAGE_DOCUMENT_BYTES, 14 * 1024 * 1024);
  assert.equal(MAX_BATCH_BODY_BYTES, 28 * 1024 * 1024);
  assert.ok(MAX_PAGE_DOCUMENT_BYTES < MONGO_BSON_MAX_DOCUMENT_BYTES);
});

test('typed blocks count toward the page document estimate', () => {
  // Blocks restate the fragment's prose, so a page that fits with contentHtml
  // alone can breach the cap once they travel with it. An estimator blind to
  // them would wave through a document Mongo then rejects.
  const base = {
    origin: 'https://geekatyourspot.com',
    url: 'https://geekatyourspot.com/',
    contentHtml: '<p>Pay vendors from one place.</p>',
  };
  const withoutBlocks = estimatePageDocumentBytes(base);
  const withBlocks = estimatePageDocumentBytes({
    ...base,
    blocks: [
      {
        kind: 'paragraph' as const,
        text: 'Pay vendors from one place.',
        html: 'Pay vendors from one place.',
        anchors: [{ label: 'Melio', href: 'https://geekatyourspot.com/tools/accounting/melio' }],
      },
    ],
  });

  assert.ok(withBlocks > withoutBlocks, 'blocks must add to the estimate');
  assert.equal(estimatePageDocumentBytes({ ...base, blocks: [] }), withoutBlocks);
});

test('a failure row carries no blocks and is still accepted', () => {
  // request_failed pages have no body by design. Requiring blocks would turn
  // every failure into a validation error and take the post-mortem with it.
  const bytes = estimatePageDocumentBytes({
    origin: 'https://example.com',
    url: 'https://example.com/down',
    failureReason: '503 from origin',
  });

  assert.ok(bytes > 0 && bytes < MAX_PAGE_DOCUMENT_BYTES);
});
