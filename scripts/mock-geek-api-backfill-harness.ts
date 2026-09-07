/**
 * Local mock GeekAPI for markdown backfill dry-run + write verification.
 * Usage: npx tsx scripts/mock-geek-api-backfill-harness.ts
 */
import { createServer } from 'node:http';
import {
  backfillMarkdownForRuns,
  createBackfillClientExplicit,
} from '../src/crawl/backfill-markdown.js';
import { extractCleanContent } from '../src/crawl/extract-content.js';
import { createCrawlPersist } from '../src/storage/persist.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const RUN_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const API_KEY = 'test-key';

type StorePage = {
  id: string;
  runId: string;
  origin: string;
  url: string;
  finalUrl: string;
  statusCode: number;
  robotsAllowed: boolean;
  html: string | null;
  title: string | null;
  markdown: string | null;
  excerpt: string | null;
  markdownBackfilledAt: string | null;
  failureReason: string | null;
  crawledAtUtc: string;
};

const pages: StorePage[] = [
  {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    runId: RUN_ID,
    origin: 'https://example.com',
    url: 'https://example.com/us/product',
    finalUrl: 'https://example.com/us/product',
    statusCode: 200,
    robotsAllowed: true,
    html: `<!doctype html><html><head><title>US Product</title></head><body>
      <nav>Home About</nav>
      <article><h1>US Product</h1><p>Clean body copy about the US product for readability.</p></article>
    </body></html>`,
    title: null,
    markdown: null,
    excerpt: null,
    markdownBackfilledAt: null,
    failureReason: null,
    crawledAtUtc: new Date().toISOString(),
  },
  {
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    runId: RUN_ID,
    origin: 'https://example.com',
    url: 'https://example.com/gb/product',
    finalUrl: 'https://example.com/gb/product',
    statusCode: 200,
    robotsAllowed: true,
    html: `<!doctype html><html><head><title>GB Product</title></head><body>
      <article><h1>GB Product</h1><p>Should be skipped by locale filter.</p></article>
    </body></html>`,
    title: null,
    markdown: null,
    excerpt: null,
    markdownBackfilledAt: null,
    failureReason: null,
    crawledAtUtc: new Date().toISOString(),
  },
  {
    id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    runId: RUN_ID,
    origin: 'https://example.com',
    url: 'https://example.com/blog/hello',
    finalUrl: 'https://example.com/blog/hello',
    statusCode: 200,
    robotsAllowed: true,
    html: `<!doctype html><html><head><title>Hello Blog</title></head><body>
      <article><h1>Hello Blog</h1><p>Another keepable English bare path article with enough text.</p></article>
    </body></html>`,
    title: null,
    markdown: null,
    excerpt: null,
    markdownBackfilledAt: null,
    failureReason: null,
    crawledAtUtc: new Date().toISOString(),
  },
];

async function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

function startMock(port: number): Promise<{ close: () => Promise<void>; baseUrl: string }> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && url.pathname === `/api/geek-crawler/crawls/${RUN_ID}/pages`) {
      const limit = Number(url.searchParams.get('limit') ?? 100);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      return send(200, pages.slice(offset, offset + limit));
    }

    if (
      req.method === 'POST' &&
      url.pathname === `/api/geek-crawler/ingest/runs/${RUN_ID}/pages/markdown-backfill`
    ) {
      const raw = await readBody(req);
      const body = JSON.parse(raw) as {
        pages: Array<{ pageId: string; title?: string; markdown?: string; excerpt?: string }>;
      };
      let count = 0;
      for (const item of body.pages ?? []) {
        const page = pages.find((p) => p.id === item.pageId);
        if (!page) continue;
        if (page.markdown) continue;
        if (!item.markdown) continue;
        page.title = item.title ?? null;
        page.markdown = item.markdown;
        page.excerpt = item.excerpt ?? null;
        page.markdownBackfilledAt = new Date().toISOString();
        count += 1;
      }
      return send(200, { count, requested: body.pages?.length ?? 0 });
    }

    if (req.method === 'GET' && url.pathname === '/api/geek-crawler/crawls') {
      return send(200, [{ id: RUN_ID, status: 'complete' }]);
    }

    send(404, { error: 'not found', path: url.pathname });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((r, j) => server.close((err) => (err ? j(err) : r()))),
      });
    });
  });
}

async function main() {
  const mock = await startMock(8799);
  const client = createBackfillClientExplicit({
    baseUrl: mock.baseUrl,
    apiKey: API_KEY,
    userId: USER_ID,
  });

  console.log('--- dry-run ---');
  const dry = await backfillMarkdownForRuns({
    client,
    runIds: [RUN_ID],
    dryRun: true,
    onSample: (s) => console.log('sample', s.url, s.title, s.markdownPreview.slice(0, 80)),
  });
  console.log(JSON.stringify(dry, null, 2));

  if (dry.updated < 2) throw new Error(`expected >=2 dry updates, got ${dry.updated}`);
  if (dry.skipped_locale < 1) throw new Error('expected locale skip for /gb/');
  if (pages.some((p) => p.markdown)) throw new Error('dry-run must not write');

  console.log('--- write ---');
  const written = await backfillMarkdownForRuns({
    client,
    runIds: [RUN_ID],
    dryRun: false,
  });
  console.log(JSON.stringify(written, null, 2));

  const us = pages.find((p) => p.url.includes('/us/'))!;
  const blog = pages.find((p) => p.url.includes('/blog/'))!;
  const gb = pages.find((p) => p.url.includes('/gb/'))!;

  if (!us.markdown || !us.title || !us.markdownBackfilledAt) {
    throw new Error('US page missing markdown after write');
  }
  if (!blog.markdown || !blog.markdownBackfilledAt) {
    throw new Error('blog page missing markdown after write');
  }
  if (gb.markdown) throw new Error('GB page should remain without markdown');

  console.log('--- idempotent second write ---');
  const again = await backfillMarkdownForRuns({
    client,
    runIds: [RUN_ID],
    dryRun: false,
  });
  if (again.updated !== 0) throw new Error(`expected 0 second-pass updates, got ${again.updated}`);
  if (again.skipped_has_markdown < 2) {
    throw new Error('expected skipped_has_markdown for already filled pages');
  }

  console.log('--- live persist extract (local mode) ---');
  const dir = await mkdtemp(path.join(tmpdir(), 'gc-md-'));
  try {
    delete process.env.GEEK_API_URL;
    process.env.KEEP_LOCAL_DATA = '1';
    const persist = createCrawlPersist({
      crawlType: 'partner',
      seeds: ['https://example.com'],
      dataDir: dir,
    });
    await persist.begin();
    const html = pages[0]!.html!;
    const clean = extractCleanContent(html, pages[0]!.url);
    await persist.savePage({
      url: pages[0]!.url,
      finalUrl: pages[0]!.finalUrl,
      statusCode: 200,
      html,
      markdown: clean.markdown,
      title: clean.title,
      excerpt: clean.excerpt,
      robotsAllowed: true,
      fetchMode: 'cheerio',
    });
    if (!clean.markdown || !clean.title) throw new Error('live extract failed');
    console.log('live extract ok', { title: clean.title, mdLen: clean.markdown.length });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  await mock.close();
  console.log('HARNESS_OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
