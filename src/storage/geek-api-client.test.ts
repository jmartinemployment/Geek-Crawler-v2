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
import {
  MAX_PAGES_PER_BATCH,
  MONGO_BSON_MAX_DOCUMENT_BYTES,
} from './ingest-limits.js';

// Not "atomic": the server inserts links one document at a time with InsertOneAsync and
// skips duplicate keys individually, so a batch has never been a single transaction. The
// word was removed from the refusal message for the same reason -- a claim nothing enforces
// is read as one that something does.
test('link ingest is one batch per call, up to the max', async () => {
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
      /exceeds max/,
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

test('the 5,779-link page now fits one batch and lands whole', async () => {
  // The shape that failed: one netsuite.com portal index carrying 5,779 links
  // against a cap of 2,000, refused before sending, whole crawl purged. The cap
  // is 10,000 now, so this is a single batch and nothing is sliced.
  const batchSizes: number[] = [];
  const received: string[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    const parsed = JSON.parse(body) as { links: Array<{ linkUrl: string }> };
    batchSizes.push(parsed.links.length);
    for (const link of parsed.links) received.push(link.linkUrl);
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
    const rows = Array.from({ length: 5779 }, (_, index) => ({
      pageId: 'page-1',
      fromUrl: 'https://www.netsuite.com/portal/home.shtml',
      linkUrl: `https://www.netsuite.com/portal/${index}`,
      isSameOrigin: true,
    }));

    const persisted = await client.createLinksBatch('run-1', rows);

    assert.equal(persisted, rows.length);
    // One request, not three. That is the whole point of raising the cap.
    assert.deepEqual(batchSizes, [5779]);
    assert.equal(received.length, rows.length);
    assert.equal(new Set(received).size, rows.length);
  } finally {
    server.close();
  }
});

test('a page above the raised cap is still refused whole, never trimmed', () => {
  // Raising the cap moves the boundary; it does not remove it. Above it the batch
  // is rejected entire -- truncation is prohibited, so dropping links to fit is
  // not an available answer.
  const rows = Array.from({ length: MAX_LINKS_PER_BATCH + 1 }, (_, index) => ({
    pageId: 'page-1',
    fromUrl: 'https://example.com',
    linkUrl: `https://example.com/${index}`,
    isSameOrigin: true,
  }));
  const client = new GeekApiClient('http://127.0.0.1:1', 'test-key', 'test-user');

  assert.rejects(
    () => client.createLinksBatch('run-1', rows),
    new RegExp(`links/batch size ${MAX_LINKS_PER_BATCH + 1} exceeds max ${MAX_LINKS_PER_BATCH}`),
  );
});

test('the raised cap is calibrated against the body ceiling, and that is enforced', async () => {
  // A count cap alone would just move the failure: links carrying long query
  // strings can pass the count check and still blow the body ceiling, which
  // would surface as an opaque transport error instead of a stated limit.
  const padding = 'q'.repeat(4096);
  const rows = Array.from({ length: MAX_LINKS_PER_BATCH }, (_, index) => ({
    pageId: 'page-1',
    fromUrl: 'https://example.com',
    linkUrl: `https://example.com/${index}?p=${padding}`,
    isSameOrigin: true,
  }));
  const client = new GeekApiClient('http://127.0.0.1:1', 'test-key', 'test-user');

  await assert.rejects(
    () => client.createLinksBatch('run-1', rows),
    /links\/batch body \d+ exceeds max 29360128/,
  );
});

test('the cap matches the number the server enforces', () => {
  // GeekCrawlerIngestLimits.MaxLinksPerBatch in
  // GeekBackend/GeekAPI/Services/GeekCrawler/GeekCrawlerIngestLimits.cs. Nothing
  // keeps them in step automatically, so this pins the crawler's half: if the two
  // drift, every large batch is rejected at the boundary with a 400 the crawler
  // treats as fatal.
  assert.equal(MAX_LINKS_PER_BATCH, 10_000);
  assert.equal(MAX_PAGES_PER_BATCH, 100);
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

/**
 * Which non-2xx justifies destroying a finished crawl.
 *
 * On 2026-09-30 at 03:35 three completed crawls were purged in one minute — parseur 180 pages,
 * quickbooks 81, zoneandco 342 — because GeekAPI was redeploying and Railway's edge answered
 * `404 {"status":"error","code":404,"message":"Application not found","request_id":"..."}`. The
 * crawler read that as a deleted run, which is the one state that justifies removing local data.
 *
 * These serve the real bodies over a real socket, because the discriminator is the status, the
 * content type and the body together.
 */
async function failureFrom(
  status: number,
  body: string,
  contentType: string,
): Promise<PersistenceError> {
  const server = createServer((_req, res) => {
    res.statusCode = status;
    res.setHeader('content-type', contentType);
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    const client = new GeekApiClient(`http://127.0.0.1:${port}`, 'k', 'u');
    await client.createRun({ crawlType: 'partner', seeds: ['https://x.com'] });
    throw new Error('expected the call to fail');
  } catch (err) {
    if (!(err instanceof PersistenceError)) throw err;
    return err;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const RAILWAY_404 =
  '{"status":"error","code":404,"message":"Application not found","request_id":"qSKfdisKRiiSktaLU79b0g"}';

test("Railway's 404 is unreachable, not a deleted run", async () => {
  const err = await failureFrom(404, RAILWAY_404, 'application/json');
  assert.equal(err.unreachable, true);
});

test('an HTML proxy error page is unreachable', async () => {
  const err = await failureFrom(404, '<html><body>not found</body></html>', 'text/html');
  assert.equal(err.unreachable, true);
});

test('any 5xx is unreachable — 1,192 pages went this way', async () => {
  const err = await failureFrom(500, '', 'text/plain');
  assert.equal(err.unreachable, true);
});

test("GeekAPI's own 409 is determinate and still purges", async () => {
  const err = await failureFrom(
    409,
    '"Crawl reported complete with no usable pages"',
    'text/plain',
  );
  assert.equal(err.unreachable, false);
});

test('a ProblemDetails 400 is determinate and still purges', async () => {
  const err = await failureFrom(
    400,
    '{"title":"Bad Request","status":400,"detail":"pages carry no extracted content"}',
    'application/json',
  );
  assert.equal(err.unreachable, false);
});

// The orphan pass decides whether to delete a run on this status, so the status
// GeekAPI sent has to arrive intact, and a body without one has to say so.
test('runPresence carries the run status GeekAPI reports', async () => {
  const bodies: Record<string, string> = {
    '/api/geek-crawler/crawls/complete-run': JSON.stringify({ runId: 'complete-run', status: 'complete' }),
    '/api/geek-crawler/crawls/external-run': JSON.stringify({ runId: 'external-run', status: 'external' }),
    '/api/geek-crawler/crawls/no-status-run': JSON.stringify({ runId: 'no-status-run' }),
    '/api/geek-crawler/crawls/garbled-run': 'not json',
  };
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(bodies[req.url ?? ''] ?? '{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const client = new GeekApiClient(`http://127.0.0.1:${address.port}`, 'test-key', 'test-user');

  try {
    assert.deepEqual(await client.runPresence('complete-run'), { kind: 'present', status: 'complete' });
    assert.deepEqual(await client.runPresence('external-run'), { kind: 'present', status: 'external' });
    assert.deepEqual(await client.runPresence('no-status-run'), { kind: 'present', status: null });
    assert.deepEqual(await client.runPresence('garbled-run'), { kind: 'present', status: null });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// 2026-10-05: thirty runs failed on GeekAPI writes and every post-mortem read
// "fetch failed". The reason was in err.cause and was dropped.
test('a dropped connection names its cause in the persistence error', async () => {
  const server = createServer((req) => {
    req.socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const client = new GeekApiClient(`http://127.0.0.1:${address.port}`, 'test-key', 'test-user');

  try {
    await assert.rejects(
      client.patchRun('11111111-2222-4333-8444-555555555555', { status: 'running' }),
      (err: unknown) => {
        assert(err instanceof PersistenceError);
        assert.equal(err.unreachable, true);
        assert.match(err.message, /transport: fetch failed; caused by: .+/);
        assert.match(err.message, /other side closed|ECONNRESET|socket/i);
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
