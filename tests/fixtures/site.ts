import { createServer, type Server } from 'node:http';

const articleText =
  'Deterministic crawler fixtures make integration tests repeatable without public network access. ' +
  'This article contains enough meaningful prose for Readability, markdown conversion, title extraction, ' +
  'excerpt generation, link persistence, and viability checks to exercise the production crawl pipeline.';

function page(title: string, body: string, extraHead = ''): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>${extraHead}</head>
<body><header>Fixture navigation</header><main><article><h1>${title}</h1>${body}</article></main></body></html>`;
}

export type FixtureSite = {
  origin: string;
  requests(pathname: string): number;
  close(): Promise<void>;
};

export async function startFixtureSite(options?: {
  sitemap?: boolean;
  slowMs?: number;
}): Promise<FixtureSite> {
  const counts = new Map<string, number>();
  let origin = '';

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', origin || 'http://127.0.0.1');
    counts.set(url.pathname, (counts.get(url.pathname) ?? 0) + 1);
    if (options?.slowMs) {
      await new Promise((resolve) => setTimeout(resolve, options.slowMs));
    }

    const send = (status: number, body: string, type = 'text/html; charset=utf-8') => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };

    if (url.pathname === '/robots.txt') {
      return send(
        200,
        [
          'User-agent: *',
          'Disallow: /blocked',
          ...(options?.sitemap === false ? [] : [`Sitemap: ${origin}/sitemaps/index.xml`]),
        ].join('\n'),
        'text/plain',
      );
    }
    if (url.pathname === '/sitemap.xml' && options?.sitemap === false) {
      return send(404, 'missing');
    }
    if (url.pathname === '/sitemaps/index.xml') {
      return send(
        200,
        `<?xml version="1.0"?><sitemapindex>
          <sitemap><loc>${origin}/sitemaps/pages.xml</loc></sitemap>
          <sitemap><loc>${origin}/sitemaps/more.xml</loc></sitemap>
        </sitemapindex>`,
        'application/xml',
      );
    }
    if (url.pathname === '/sitemaps/pages.xml') {
      return send(
        200,
        `<?xml version="1.0"?><urlset>
          <url><loc>${origin}/</loc></url>
          <url><loc>${origin}/article</loc></url>
          <url><loc>${origin}/article?utm_source=duplicate</loc></url>
          <url><loc>${origin}/redirect</loc></url>
          <url><loc>${origin}/retry</loc></url>
          <url><loc>${origin}/blocked</loc></url>
          <url><loc>${origin}/fr/article</loc></url>
        </urlset>`,
        'application/xml',
      );
    }
    if (url.pathname === '/sitemaps/more.xml') {
      return send(
        200,
        `<?xml version="1.0"?><urlset>
          <url><loc>${origin}/long</loc></url>
          <url><loc>${origin}/spa</loc></url>
          <url><loc>${origin}/challenge</loc></url>
          <url><loc>https://outside.invalid/not-crawled</loc></url>
        </urlset>`,
        'application/xml',
      );
    }
    if (url.pathname === '/') {
      return send(
        200,
        page(
          'Fixture home',
          `<p>${articleText}</p>
           <a href="/article?utm_campaign=home">Tracked article</a>
           <a href="/nested/one">Nested BFS page</a>
           <a href="/fr/article">French locale</a>
           <a href="https://outside.invalid/page">External page</a>`,
        ),
      );
    }
    if (url.pathname === '/article') {
      return send(
        200,
        page(
          'Fixture Article',
          `<p>${articleText}</p><h2>Exact fixture section</h2>
           <p>The persisted markdown must retain this exact deterministic sentence.</p>
           <a href="/long">Read the long article</a>`,
        ),
      );
    }
    if (url.pathname === '/nested/one') {
      return send(
        200,
        page(
          'Nested one',
          `<p>${articleText}</p><a href="/nested/two?utm_source=nested">Continue</a>`,
        ),
      );
    }
    if (url.pathname === '/nested/two') {
      return send(200, page('Nested two', `<p>${articleText}</p>`));
    }
    if (url.pathname === '/long') {
      return send(
        200,
        page(
          'Long Fixture Article',
          Array.from({ length: 30 }, (_, i) => `<p>Paragraph ${i + 1}. ${articleText}</p>`).join(''),
        ),
      );
    }
    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: '/article' });
      return res.end();
    }
    if (url.pathname === '/retry') {
      if ((counts.get('/retry') ?? 0) < 3) {
        return send(503, 'temporary fixture failure', 'text/plain');
      }
      return send(200, page('Retried page', `<p>${articleText}</p>`));
    }
    if (url.pathname === '/challenge') {
      return send(
        200,
        '<!doctype html><html><head><title>Just a moment...</title></head><body>' +
          '<div>cf-browser-verification</div>'.repeat(50) +
          '</body></html>',
      );
    }
    if (url.pathname === '/spa') {
      return send(
        200,
        `<!doctype html><html><head><title>SPA Fixture</title></head><body><div id="root"></div>
         <script src="/spa.js"></script>${'<!-- fixture padding -->'.repeat(30)}</body></html>`,
      );
    }
    if (url.pathname === '/spa.js') {
      return send(
        200,
        `document.getElementById('root').innerHTML =
          '<main><article><h1>Rendered SPA Article</h1><p>${articleText}</p>' +
          '<p>Playwright rendered this deterministic content.</p></article></main>';`,
        'text/javascript',
      );
    }
    if (url.pathname === '/blocked') {
      return send(200, page('Blocked page', `<p>${articleText}</p>`));
    }
    if (url.pathname === '/fr/article') {
      return send(200, page('French page', `<p>${articleText}</p>`));
    }

    return send(404, 'not found', 'text/plain');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not bind');
  origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    requests: (pathname) => counts.get(pathname) ?? 0,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}
