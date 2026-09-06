import { CheerioCrawler, Configuration, log } from 'crawlee';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { BOT, defaultRequestHeaders } from '../bot/identity.js';
import { createCrawlPersist, type CrawlPersist } from '../storage/persist.js';
import { createJsonRunStore } from '../storage/runs.js';
import { extractHrefs, sameOriginUrls } from './links.js';
import { runPlaywrightPool } from './playwright-pool.js';
import { buildProxyConfiguration } from './proxy.js';
import {
  filterEnqueueUrls,
  initialCrawlUrls,
  loadSiteMapIndex,
  type SiteMapIndex,
} from './sitemap.js';
import { concurrencyOptions, httpAgent, httpsAgent } from './throttle.js';
import type { CrawlType } from './types.js';
import { isViableHtml } from './viability.js';
import { normalizeSeeds } from '../storage/seed-key.js';

export type RunCrawlInput = {
  runId?: string;
  crawlType: CrawlType;
  seeds: string[];
  dataDir: string;
  maxRequestsPerCrawl?: number;
  /** When true, do not re-seed; continue Crawlee request queue under .crawlee/<runId>. */
  resume?: boolean;
};

export type RunCrawlResult = {
  runId: string;
  pagesSaved: number;
  linksSaved: number;
  dataDir: string;
  persistMode: string;
};

export type PreparedCrawl = {
  runId: string;
  persistMode: string;
  dataDir: string;
  run: () => Promise<RunCrawlResult>;
};

/** Create GeekAPI/local run and return immediately; call `run()` to crawl. */
export async function prepareCheerioCrawl(input: RunCrawlInput): Promise<PreparedCrawl> {
  const seeds = normalizeSeeds(input.seeds);
  if (seeds.length === 0) throw new Error('No valid seed URLs');

  const persist = createCrawlPersist({
    runIdHint: input.runId,
    crawlType: input.crawlType,
    seeds,
    dataDir: input.dataDir,
  });
  await persist.begin();
  await persist.markRunning();

  return {
    runId: persist.runId,
    persistMode: persist.mode,
    dataDir: persist.dataDir,
    run: () => executeCheerioCrawl(persist, seeds, input),
  };
}

/**
 * Resume an existing run: same runId, same `.crawlee/<runId>` queue, no GeekAPI createRun.
 * Processes remaining pending requests (already-handled URLs stay skipped by Crawlee).
 */
export async function prepareResumeCheerioCrawl(input: {
  runId: string;
  dataDir: string;
  maxRequestsPerCrawl?: number;
}): Promise<PreparedCrawl> {
  const dataDir = path.resolve(input.dataDir);
  const runId = input.runId;
  const meta = createJsonRunStore(dataDir);
  const existing = await meta.getRun(runId);
  if (!existing) {
    throw new Error(`Run not found locally: ${runId}`);
  }
  const queueDir = path.join(dataDir, '.crawlee', runId);
  try {
    await access(queueDir);
  } catch {
    throw new Error(
      `Cannot resume — Crawlee storage missing at ${queueDir}. Resume needs the local request queue.`,
    );
  }

  const seeds = normalizeSeeds(existing.seeds);
  if (seeds.length === 0) {
    throw new Error(`Cannot resume — run ${runId} has no seeds in local stub`);
  }
  const persist = createCrawlPersist({
    runIdHint: runId,
    crawlType: existing.crawlType,
    seeds,
    dataDir,
  });
  await persist.beginResume();
  await persist.markRunning();

  if (persist.runId !== runId) {
    throw new Error(`Resume runId mismatch: expected ${runId}, got ${persist.runId}`);
  }

  const crawlInput: RunCrawlInput = {
    runId,
    crawlType: existing.crawlType,
    seeds,
    dataDir,
    maxRequestsPerCrawl: input.maxRequestsPerCrawl,
    resume: true,
  };

  return {
    runId: persist.runId,
    persistMode: persist.mode,
    dataDir: persist.dataDir,
    run: () => executeCheerioCrawl(persist, seeds, crawlInput),
  };
}

export async function runCheerioCrawl(input: RunCrawlInput): Promise<RunCrawlResult> {
  const prepared = await prepareCheerioCrawl(input);
  return prepared.run();
}

async function executeCheerioCrawl(
  persist: CrawlPersist,
  seeds: string[],
  input: RunCrawlInput,
): Promise<RunCrawlResult> {
  const promoteToPlaywright = new Set<string>();
  const { minConcurrency, maxConcurrency, autoscaledPoolOptions } = concurrencyOptions();
  const proxyConfiguration = buildProxyConfiguration();

  const siteMap: SiteMapIndex = await loadSiteMapIndex(seeds);
  if (siteMap.hasMap) {
    log.info(
      `Sitemap is the map: ${siteMap.urls.size} URL(s); link enqueue restricted to map`,
    );
  } else {
    log.info('No sitemap map found — same-site BFS (tracking params stripped)');
  }

  const config = new Configuration({
    storageClientOptions: {
      localDataDirectory: `${input.dataDir}/.crawlee/${persist.runId}`,
    },
  });

  const crawler = new CheerioCrawler(
    {
      proxyConfiguration,
      useSessionPool: true,
      persistCookiesPerSession: true,
      minConcurrency,
      maxConcurrency,
      autoscaledPoolOptions,
      ...(input.maxRequestsPerCrawl != null
        ? { maxRequestsPerCrawl: input.maxRequestsPerCrawl }
        : {}),
      maxRequestRetries: 5,
      requestHandlerTimeoutSecs: 60,
      additionalHttpErrorStatusCodes: [429, 503],
      respectRobotsTxtFile: { userAgent: BOT.name },
      onSkippedRequest: async ({ url, reason }) => {
        if (reason === 'robotsTxt') {
          const { pageId } = await persist.savePage({
            url,
            robotsAllowed: false,
            failureReason: 'robots_disallowed',
            fetchMode: 'cheerio',
          });
          void pageId;
        }
      },
      preNavigationHooks: [
        async ({ request }, gotOptions) => {
          gotOptions.agent = { http: httpAgent, https: httpsAgent };
          gotOptions.headers = {
            ...gotOptions.headers,
            ...defaultRequestHeaders(),
            ...request.headers,
          };
          gotOptions.headerGeneratorOptions = {
            devices: ['mobile'],
            operatingSystems: ['android'],
          };
        },
      ],
      async requestHandler({ request, body, $, response, enqueueLinks }) {
        const rawHtml = typeof body === 'string' ? body : String(body ?? '');
        const statusCode = response?.statusCode;
        const finalUrl = request.loadedUrl ?? request.url;

        const viability = isViableHtml(rawHtml, $ as never);
        if (!viability.viable) {
          if (viability.reason === 'challenge_page') {
            await persist.savePage({
              url: request.url,
              finalUrl,
              statusCode,
              html: rawHtml,
              robotsAllowed: true,
              failureReason: viability.reason,
              fetchMode: 'cheerio',
            });
            return;
          }

          log.info(`Playwright backup (${viability.reason}): ${request.url}`);
          promoteToPlaywright.add(request.url);
          const links = extractHrefs($, finalUrl);
          const toEnqueue = filterEnqueueUrls(sameOriginUrls(links), siteMap);
          if (toEnqueue.length > 0) {
            await enqueueLinks({ urls: toEnqueue, strategy: 'all' });
          }
          return;
        }

        const { pageId } = await persist.savePage({
          url: request.url,
          finalUrl,
          statusCode,
          html: rawHtml,
          robotsAllowed: true,
          fetchMode: 'cheerio',
        });

        const links = extractHrefs($, finalUrl);
        await persist.saveLinks(
          pageId,
          links.map((l) => ({
            fromUrl: finalUrl,
            linkUrl: l.linkUrl,
            isSameOrigin: l.isSameOrigin,
          })),
        );

        const toEnqueue = filterEnqueueUrls(sameOriginUrls(links), siteMap);
        if (toEnqueue.length > 0) {
          await enqueueLinks({ urls: toEnqueue, strategy: 'all' });
        }
      },
      failedRequestHandler: async ({ request }, error) => {
        log.warning(`Request failed ${request.url}: ${error}`);
        await persist.savePage({
          url: request.url,
          robotsAllowed: true,
          failureReason: error instanceof Error ? error.message : String(error),
          fetchMode: 'cheerio',
        });
      },
    },
    config,
  );

  try {
    if (input.resume) {
      log.info(`Resuming Crawlee queue for run ${persist.runId} (no re-seed; map filter active)`);
      await crawler.run();
    } else {
      const startUrls = initialCrawlUrls(seeds, siteMap);
      log.info(`Starting crawl with ${startUrls.length} URL(s)`);
      await crawler.run(startUrls);
    }

    if (promoteToPlaywright.size > 0) {
      log.info(`Playwright backup pool: ${promoteToPlaywright.size} URL(s)`);
      await runPlaywrightPool({
        runId: persist.runId,
        urls: [...promoteToPlaywright],
        dataDir: input.dataDir,
        persist,
      });
    }

    await persist.markComplete();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await persist.markFailed(message);
    throw err;
  }

  const stats = await persist.stats();
  return {
    runId: persist.runId,
    pagesSaved: stats.pagesSaved,
    linksSaved: stats.linksSaved,
    dataDir: persist.dataDir,
    persistMode: persist.mode,
  };
}
