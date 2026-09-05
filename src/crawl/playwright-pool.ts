import { Configuration, PlaywrightCrawler, log } from 'crawlee';
import { defaultRequestHeaders } from '../bot/identity.js';
import type { CrawlPersist } from '../storage/persist.js';
import { extractHrefs } from './links.js';
import { buildProxyConfiguration } from './proxy.js';

export type PlaywrightPoolInput = {
  runId: string;
  urls: string[];
  dataDir: string;
  persist: CrawlPersist;
};

/** Crawlee PlaywrightCrawler backup — promoted URLs only, capped concurrency. */
export async function runPlaywrightPool(input: PlaywrightPoolInput): Promise<number> {
  const urls = [...new Set(input.urls)].filter(Boolean);
  if (urls.length === 0) return 0;

  const maxConcurrency = Number(process.env.PLAYWRIGHT_MAX_CONCURRENCY ?? 1);
  const proxyConfiguration = buildProxyConfiguration();

  const config = new Configuration({
    storageClientOptions: {
      localDataDirectory: `${input.dataDir}/.crawlee/${input.runId}-pw`,
    },
  });

  let saved = 0;

  const crawler = new PlaywrightCrawler(
    {
      proxyConfiguration,
      useSessionPool: true,
      persistCookiesPerSession: true,
      minConcurrency: 1,
      maxConcurrency: Number.isFinite(maxConcurrency) ? Math.max(1, maxConcurrency) : 1,
      maxRequestRetries: 2,
      requestHandlerTimeoutSecs: 90,
      launchContext: {
        launchOptions: { headless: true },
      },
      preNavigationHooks: [
        async ({ page }, goOptions) => {
          const headers = defaultRequestHeaders();
          await page.setExtraHTTPHeaders({
            'Sec-Ch-Ua-Mobile': headers['Sec-Ch-Ua-Mobile'],
            'Sec-Ch-Ua-Platform': headers['Sec-Ch-Ua-Platform'],
            From: headers.From,
          });
          await page.setViewportSize({ width: 412, height: 915 });
          goOptions.waitUntil = 'domcontentloaded';
        },
      ],
      async requestHandler({ request, page, parseWithCheerio }) {
        const rawHtml = await page.content();
        const finalUrl = page.url();
        const { pageId } = await input.persist.savePage({
          url: request.url,
          finalUrl,
          statusCode: 200,
          html: rawHtml,
          robotsAllowed: true,
          fetchMode: 'playwright',
        });
        saved += 1;

        const $ = await parseWithCheerio();
        const links = extractHrefs($ as never, finalUrl);
        await input.persist.saveLinks(
          pageId,
          links.map((l) => ({
            fromUrl: finalUrl,
            linkUrl: l.linkUrl,
            isSameOrigin: l.isSameOrigin,
          })),
        );
      },
      failedRequestHandler: async ({ request }, error) => {
        log.warning(`PlaywrightCrawler failed ${request.url}: ${error}`);
        await input.persist.savePage({
          url: request.url,
          robotsAllowed: true,
          failureReason: error instanceof Error ? error.message : String(error),
          fetchMode: 'playwright',
        });
      },
    },
    config,
  );

  await crawler.run(urls);
  return saved;
}
