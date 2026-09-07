import { createServer } from 'node:http';

const port = Number(process.env.E2E_SERVICE_PORT || 8899);
const origin = `http://127.0.0.1:${port}`;
const fixtureText =
  'Deterministic local fixture content is long enough for crawler reports and browser tests without external services.';

const runs = [
  {
    runId: 'run-123',
    status: 'complete',
    crawlType: 'partner',
    seeds: [`${origin}/fixture/article`],
    pagesSaved: 101,
    linksSaved: 3,
    createdAtUtc: '2026-01-01T00:00:00.000Z',
  },
  {
    runId: 'local-run',
    status: 'complete',
    crawlType: 'local',
    seeds: [`${origin}/fixture/local`],
    pagesSaved: 1,
    linksSaved: 0,
    createdAtUtc: '2026-01-02T00:00:00.000Z',
  },
];

function send(res, status, body, contentType = 'application/json') {
  res.writeHead(status, { 'content-type': contentType });
  res.end(contentType === 'application/json' ? JSON.stringify(body) : body);
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', origin);
  const pathname = url.pathname;

  if (pathname === '/robots.txt') {
    return send(res, 200, `User-agent: *\nSitemap: ${origin}/sitemap.xml`, 'text/plain');
  }
  if (pathname === '/sitemap.xml') {
    return send(
      res,
      200,
      `<?xml version="1.0"?><urlset>
        <url><loc>${origin}/fixture/article</loc></url>
        <url><loc>${origin}/fixture/article?utm_source=duplicate</loc></url>
        <url><loc>${origin}/fixture/second</loc></url>
      </urlset>`,
      'application/xml',
    );
  }
  if (pathname.startsWith('/fixture/')) {
    return send(
      res,
      200,
      `<!doctype html><html><head><title>Fixture page</title></head>
       <body><main><h1>Fixture page</h1><p>${fixtureText}</p></main></body></html>`,
      'text/html',
    );
  }

  if (req.method === 'GET' && pathname === '/crawls') {
    return send(res, 200, { ok: true, runs });
  }
  if (req.method === 'POST' && pathname === '/crawls') {
    const input = await body(req);
    if (String(input.seed || '').includes('backend-error')) {
      return send(res, 422, { error: 'deterministic backend rejection' });
    }
    return send(res, 202, {
      ok: true,
      runId: 'run-123',
      status: 'running',
      persistMode: 'local',
    });
  }
  if (req.method === 'POST' && pathname === '/crawls/resume-by-url') {
    const input = await body(req);
    if (String(input.url || '').includes('missing')) {
      return send(res, 404, { error: 'no local run found for seed URL' });
    }
    return send(res, 202, { ok: true, runId: 'run-123', resumed: true });
  }
  if (req.method === 'POST' && pathname === '/crawls/resume-running') {
    return send(res, 200, {
      ok: true,
      candidateCount: 3,
      resumed: [{ runId: 'run-123', seedUrl: `${origin}/fixture/article` }],
      skipped: [{ runId: 'busy-run', seedUrl: `${origin}/fixture/busy`, reason: 'already in flight' }],
      failed: [{ runId: 'broken-run', seedUrl: `${origin}/fixture/broken`, error: 'missing queue' }],
    });
  }

  const localPages = pathname.match(/^\/crawls\/([^/]+)\/pages$/);
  if (req.method === 'GET' && localPages) {
    const runId = decodeURIComponent(localPages[1]);
    if (!runs.some((run) => run.runId === runId)) return send(res, 404, { error: 'pages not found' });
    return send(res, 200, {
      runId,
      pages: [{ url: `${origin}/fixture/local`, finalUrl: `${origin}/fixture/local` }],
    });
  }
  const localRun = pathname.match(/^\/crawls\/([^/]+)$/);
  if (req.method === 'GET' && localRun) {
    const run = runs.find((item) => item.runId === decodeURIComponent(localRun[1]));
    return run ? send(res, 200, run) : send(res, 404, { error: 'run not found' });
  }

  const geekPages = pathname.match(/^\/api\/geek-crawler\/crawls\/([^/]+)\/page-urls$/);
  if (req.method === 'GET' && geekPages) {
    const runId = decodeURIComponent(geekPages[1]);
    if (runId === 'local-run') return send(res, 503, { error: 'GeekAPI unavailable' });
    const offset = Number(url.searchParams.get('offset') || 0);
    const limit = Number(url.searchParams.get('limit') || 100);
    const rows = Array.from({ length: 101 }, (_, i) => ({
      origin,
      url: `${origin}/fixture/page-${i + 1}`,
      hasHtml: i % 2 === 0,
    })).slice(offset, offset + limit);
    return send(res, 200, rows);
  }
  const geekRun = pathname.match(/^\/api\/geek-crawler\/crawls\/([^/]+)$/);
  if (req.method === 'GET' && geekRun) {
    const runId = decodeURIComponent(geekRun[1]);
    if (runId === 'local-run') return send(res, 503, { error: 'GeekAPI unavailable' });
    return send(res, 200, {
      runId,
      status: 'complete',
      crawlType: 'partner',
      seedUrls: [`${origin}/fixture/article`],
      hosts: [{ origin, pagesAttempted: 101, pagesWithHtml: 101 }],
      errorSummary: null,
    });
  }

  return send(res, 404, { error: 'not found' });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`deterministic E2E services on ${origin}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
