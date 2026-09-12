import { Configuration, PlaywrightCrawler, log } from 'crawlee';
import { defaultRequestHeaders } from '../bot/identity.js';
import type { CrawlPersist } from '../storage/persist.js';
import { extractCleanContent } from './extract-content.js';
import { extractHrefs, sameOriginUrls } from './links.js';
import { buildProxyConfiguration } from './proxy.js';
import { classifyReject } from './reject.js';
import { filterEnqueueUrls, type SiteMapIndex } from './sitemap.js';
import { isViableHtml } from './viability.js';
import { htmlHash } from './dedup.js';

export type PlaywrightPoolInput = {
  runId: string;
  urls: string[];
  dataDir: string;
  persist: CrawlPersist;
  siteMap?: SiteMapIndex;
  /** Seed URL anchoring the same-site scope; defaults to the first promoted URL. */
  scopeUrl?: string;
};

/** Crawlee PlaywrightCrawler backup — promoted URLs only, capped concurrency. */
export async function runPlaywrightPool(input: PlaywrightPoolInput): Promise<number> {
  const urls = [...new Set(input.urls)].filter(Boolean);
  if (urls.length === 0) return 0;
  const scopeUrl = input.scopeUrl ?? urls[0];
  const dedup = input.persist.dedup;
  const enqueueOpts = { aliases: dedup.aliases, counters: dedup.counters };

  const maxConcurrency = Number(process.env.PLAYWRIGHT_MAX_CONCURRENCY ?? 1);
  const proxyConfiguration = buildProxyConfiguration();
  const siteMap: SiteMapIndex = input.siteMap ?? {
    hasMap: false,
    urls: new Set(),
    sources: [],
  };

  const config = new Configuration({
    storageClientOptions: {
      localDataDirectory: `${input.dataDir}/.crawlee/${input.runId}-pw`,
    },
  });

  let saved = 0;
  const HANDLER_TIMEOUT_MS = 90_000;

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
          dedup.bump('browserRenders');
          dedup.bump('httpRequests');
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
      async requestHandler({ request, page, parseWithCheerio, enqueueLinks }) {
        const rawHtml = await page.content();
        const finalUrl = page.url();
        const $ = await parseWithCheerio();
        const owned = new Set<string>();
        let urlKey: string | null = null;
        let htmlKey: string | null = null;
        let committed = false;

        try {
          const localeReject = classifyReject({ finalUrl });
          if (localeReject === 'locale_excluded') {
            input.persist.noteReject('locale_excluded', finalUrl);
            return;
          }

          dedup.learnRedirect(request.url, finalUrl, scopeUrl);
          urlKey = dedup.resolveKey(finalUrl);
          if (!urlKey) {
            input.persist.noteReject('request_failed', finalUrl, 'invalid finalUrl key');
            return;
          }

          const urlReserve = await dedup.reserve({ urlKey }, owned);
          const urlWait = await dedup.awaitInFlight(urlReserve, HANDLER_TIMEOUT_MS);
          if (urlWait.skip) {
            await dedup.recordSkip({
              v: 1,
              at: new Date().toISOString(),
              reason: urlWait.reason,
              cause: urlWait.cause,
              requestedUrl: request.url,
              finalUrl,
              finalUrlKey: urlKey,
            });
            return;
          }

          const viability = isViableHtml(rawHtml, $ as never);
          if (!viability.viable && viability.reason === 'challenge_page') {
            input.persist.noteReject('challenge_page', finalUrl);
            return;
          }

          htmlKey = htmlHash(rawHtml);
          const htmlReserve = await dedup.reserve({ urlKey, htmlHash: htmlKey }, owned);
          const htmlWait = await dedup.awaitInFlight(htmlReserve, HANDLER_TIMEOUT_MS);
          if (htmlWait.skip) {
            const links = extractHrefs($ as never, finalUrl, scopeUrl);
            const toEnqueue = filterEnqueueUrls(sameOriginUrls(links), siteMap, enqueueOpts);
            if (toEnqueue.length > 0) {
              await enqueueLinks({
                urls: toEnqueue,
                strategy: 'all',
                transformRequestFunction: (req) => {
                  req.uniqueKey = dedup.resolveKey(req.url) ?? req.url;
                  return req;
                },
              });
            }
            await dedup.recordSkip({
              v: 1,
              at: new Date().toISOString(),
              reason: htmlWait.reason,
              cause: htmlWait.cause,
              requestedUrl: request.url,
              finalUrl,
              finalUrlKey: urlKey,
              htmlHash: htmlKey,
            });
            return;
          }

          dedup.bump('extractionInvocations');
          const clean = extractCleanContent(rawHtml, finalUrl);
          if (clean.truncated) {
            log.warning(
              `markdown truncated at cap [${new Date().toISOString()}]: ${finalUrl}`,
            );
          }
          const extractReject = classifyReject({
            finalUrl,
            markdown: clean.markdown,
          });
          if (extractReject === 'extract_empty') {
            const links = extractHrefs($ as never, finalUrl, scopeUrl);
            const toEnqueue = filterEnqueueUrls(sameOriginUrls(links), siteMap, enqueueOpts);
            if (toEnqueue.length > 0) {
              await enqueueLinks({
                urls: toEnqueue,
                strategy: 'all',
                transformRequestFunction: (req) => {
                  req.uniqueKey = dedup.resolveKey(req.url) ?? req.url;
                  return req;
                },
              });
            }
            input.persist.noteReject('extract_empty', finalUrl);
            return;
          }

          const canonicalKey = dedup.parseCanonicalHref($ as never, finalUrl, scopeUrl);
          const canonSkip = dedup.checkCanonicalAlias(urlKey, canonicalKey);
          if (canonSkip) {
            await dedup.recordSkip({
              v: 1,
              at: new Date().toISOString(),
              reason: canonSkip,
              cause: 'accepted',
              requestedUrl: request.url,
              finalUrl,
              finalUrlKey: urlKey,
              htmlHash: htmlKey,
            });
            return;
          }

          const savedPage = await input.persist.savePage({
            url: request.url,
            finalUrl,
            statusCode: 200,
            html: rawHtml,
            markdown: clean.markdown,
            title: clean.title,
            excerpt: clean.excerpt,
            robotsAllowed: true,
            fetchMode: 'playwright',
            dedup: {
              owned,
              urlKey,
              requestedUrlKey: dedup.resolveKey(request.url) ?? urlKey,
              htmlHash: htmlKey,
              canonicalKey,
            },
          });
          if (!savedPage) return;
          committed = true;
          const { pageId } = savedPage;
          saved += 1;

          const links = extractHrefs($ as never, finalUrl, scopeUrl);
          await input.persist.saveLinks(
            pageId,
            links.map((l) => ({
              fromUrl: finalUrl,
              linkUrl: l.linkUrl,
              isSameOrigin: l.isSameOrigin,
            })),
          );
        } finally {
          if (!committed) {
            dedup.release({ urlKey, htmlHash: htmlKey });
          }
        }
      },
      failedRequestHandler: async ({ request }, error) => {
        log.warning(`PlaywrightCrawler failed ${request.url}: ${error}`);
        input.persist.noteReject(
          'request_failed',
          request.url,
          error instanceof Error ? error.message : String(error),
        );
      },
    },
    config,
  );

  await crawler.run(
    urls.map((url) => ({
      url,
      uniqueKey: dedup.resolveKey(url) ?? url,
    })),
  );
  return saved;
}
