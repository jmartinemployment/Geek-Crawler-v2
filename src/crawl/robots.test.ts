/**
 * The seed robots.txt pre-check.
 * Run: npx tsx --test src/crawl/robots.test.ts
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { describe, it } from 'node:test';
import { createRobotsGate } from './robots.js';
import { RobotsBlockedError } from '../storage/errors.js';

/** Serve one robots.txt body, and 200 on everything else. */
async function withRobots(
  body: string,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((req, res) => {
    if (req.url === '/robots.txt') {
      res.setHeader('content-type', 'text/plain');
      return res.end(body);
    }
    res.setHeader('content-type', 'text/html');
    res.end('<html><body><p>a page</p></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('requireSeedAllowed', () => {
  it('refuses the seed when robots.txt disallows the whole site', async () => {
    await withRobots('User-agent: *\nDisallow: /\n', async (origin) => {
      const gate = createRobotsGate();
      await gate.requireOrigin(origin);
      await assert.rejects(
        () => gate.requireSeedAllowed(`${origin}/`),
        (err: unknown) => {
          assert.ok(err instanceof RobotsBlockedError);
          assert.match(err.message, /seed_disallowed/);
          return true;
        },
        'a site that disallows everything must be refused before a run exists',
      );
    });
  });

  it('refuses when the site allowlists other bots and disallows *', async () => {
    // taulia.com's actual shape, read live 2026-09-30: a long Allow list of named crawlers, then
    // `User-agent: *  Disallow: /`. geekatyourspotbot is not on the list, so every URL on the site
    // is disallowed -- which is why four crawls walked 202 then 558 URLs and saved zero pages.
    const body = [
      'User-agent: Googlebot',
      'User-agent: Bingbot',
      'Allow: /',
      '',
      'User-agent: *',
      'Disallow: /',
      '',
      'Sitemap: https://example.com/sitemap_index.xml',
    ].join('\n');
    await withRobots(body, async (origin) => {
      const gate = createRobotsGate();
      await assert.rejects(() => gate.requireSeedAllowed(`${origin}/`));
    });
  });

  it('allows a seed on a site that only disallows some sections', async () => {
    const body = 'User-agent: *\nDisallow: /admin\nDisallow: /cart\n';
    await withRobots(body, async (origin) => {
      const gate = createRobotsGate();
      await gate.requireSeedAllowed(`${origin}/`);
      // The per-URL gate is unchanged: a partial disallow is a normal site.
      assert.equal(await gate.isAllowed(`${origin}/admin`), false);
      assert.equal(await gate.isAllowed(`${origin}/products`), true);
    });
  });

  it('refuses a seed that is not a URL rather than crawling it', async () => {
    const gate = createRobotsGate();
    await assert.rejects(
      () => gate.requireSeedAllowed('not a url'),
      (err: unknown) => {
        assert.ok(err instanceof RobotsBlockedError);
        assert.match(err.message, /seed_not_a_url/);
        return true;
      },
    );
  });
});
