import { CheerioCrawler, Configuration, log } from 'crawlee';
import { BOT, defaultRequestHeaders } from '../bot/identity.js';
import {
  createCrawlPersist,
  isPersistenceError,
  type CrawlPersist,
} from '../storage/persist.js';
import { RobotsBlockedError } from '../storage/errors.js';
import { extractHrefs, sameOriginUrls } from './links.js';
import { extractCleanContent } from './extract-content.js';
import { buildProxyConfiguration } from './proxy.js';
import {
  filterEnqueueUrls,
  initialCrawlUrls,
  loadSiteMapIndex,
  type SiteMapIndex,
} from './sitemap.js';
import { createRobotsGate } from './robots.js';
import { concurrencyOptions, httpAgent, httpsAgent } from './throttle.js';
import type { CrawlType } from './types.js';
import { isViableHtml } from './viability.js';
import { classifyReject } from './reject.js';
import { normalizeSeeds } from '../storage/seed-key.js';
import { htmlHash } from './dedup.js';
import { clearCancel, isCancelRequested } from './cancel-registry.js';
import { MAX_PAGES_PER_SITE, clampToSiteCap } from './crawl-limits.js';
import { createSectionQuota } from './section-quota.js';
import { crawlProfileFor, sectionQuotasFor } from './crawl-profile.js';

export type RunCrawlInput = {
  crawlType: CrawlType;
  seeds: string[];
  dataDir: string;
  maxRequestsPerCrawl?: number;
  maxConcurrency?: number;
};

export type RunCrawlResult = {
  runId: string;
  pagesSaved: number;
  linksSaved: number;
  pagesRejectedLocale: number;
  pagesRejectedChallenge: number;
  pagesRejectedExtractEmpty: number;
  pagesRejectedRobots: number;
  pagesRejectedRequestFailed: number;
  duplicatePagesSkipped: number;
  dataDir: string;
  persistMode: string;
};

export type PreparedCrawl = {
  runId: string;
  persistMode: string;
  dataDir: string;
  run: () => Promise<RunCrawlResult>;
};

export async function prepareCheerioCrawl(input: RunCrawlInput): Promise<PreparedCrawl> {
  const seeds = normalizeSeeds(input.seeds);
  if (seeds.length === 0) throw new Error('No valid seed URLs');

  const robots = createRobotsGate();
  for (const seed of seeds) {
    const origin = new URL(seed).origin;
    await robots.requireOrigin(origin);
  }

  const persist = createCrawlPersist({
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
    run: () => executeCheerioCrawl(persist, seeds, input, robots),
  };
}

/** Resume of failed/incomplete runs is forbidden — start a new run. */
export async function prepareResumeCheerioCrawl(_input: {
  runId: string;
  dataDir: string;
  maxRequestsPerCrawl?: number;
  maxConcurrency?: number;
}): Promise<PreparedCrawl> {
  throw new Error(
    'Resume is forbidden under fail-closed policy — start a new crawl run instead',
  );
}

export async function runCheerioCrawl(input: RunCrawlInput): Promise<RunCrawlResult> {
  const prepared = await prepareCheerioCrawl(input);
  return prepared.run();
}

async function executeCheerioCrawl(
  persist: CrawlPersist,
  seeds: string[],
  input: RunCrawlInput,
  robots: ReturnType<typeof createRobotsGate>,
): Promise<RunCrawlResult> {
  const scopeUrl = seeds[0]!;
  const dedup = persist.dedup;
  let cancelled = false;
  // Scope policy is per crawl type. project-site disables section quotas: they exist to stop a
  // third party's page farm eating the budget, and on the operator's own site they would starve
  // the very directories the heading hierarchy is built from.
  const profile = crawlProfileFor(input.crawlType);
  const quotaLimits = sectionQuotasFor(input.crawlType);
  const quota = quotaLimits === null ? undefined : createSectionQuota(quotaLimits);
  if (quotaLimits === null) {
    log.info(`Section quotas disabled for crawlType=${input.crawlType}`);
  }
  const enqueueOpts = {
    aliases: dedup.aliases,
    counters: dedup.counters,
    quota,
  };

  const { minConcurrency, maxConcurrency, autoscaledPoolOptions } = concurrencyOptions({
    maxConcurrency: input.maxConcurrency,
  });
  const proxyConfiguration = buildProxyConfiguration();

  const siteMap: SiteMapIndex = await loadSiteMapIndex(seeds);
  if (siteMap.hasMap) {
    log.info(
      `Sitemap is the map: ${siteMap.urls.size} URL(s); link enqueue restricted to map`,
    );
  } else {
    log.info('No sitemap map found — same-site BFS (tracking params stripped)');
  }
  log.info(`Concurrency min=${minConcurrency} max=${maxConcurrency}`);

  let maxRequestsPerCrawl: number;
  if (input.maxRequestsPerCrawl != null && Number.isFinite(input.maxRequestsPerCrawl)) {
    maxRequestsPerCrawl = clampToSiteCap(input.maxRequestsPerCrawl);
    log.info(`Request budget override: maxRequestsPerCrawl=${maxRequestsPerCrawl}`);
  } else if (siteMap.hasMap) {
    maxRequestsPerCrawl = clampToSiteCap(Math.max(siteMap.urls.size, seeds.length));
    log.info(`Request budget from sitemap: maxRequestsPerCrawl=${maxRequestsPerCrawl}`);
  } else {
    maxRequestsPerCrawl = clampToSiteCap(profile.defaultMaxPages);
    log.info(
      `Request budget from ${input.crawlType} profile: maxRequestsPerCrawl=${maxRequestsPerCrawl}`,
    );
  }

  const config = new Configuration({
    purgeOnStart: true,
    storageClientOptions: {
      localDataDirectory: `${input.dataDir}/.crawlee/${persist.runId}`,
    },
  });

  const applyUniqueKey = <T extends { url: string; uniqueKey?: string }>(req: T): T => {
    req.uniqueKey = dedup.resolveKey(req.url) ?? req.url;
    return req;
  };

  let depthSuppressed = 0;

  /**
   * `parentDepth` is the depth of the page whose links these are; seeds are depth 0. Enqueue is
   * refused once the children would exceed the profile's cap, so a capped crawl stops widening
   * instead of silently running to the page budget.
   */
  const enqueueFiltered = async (
    enqueueLinks: (opts: Record<string, unknown>) => Promise<unknown>,
    urls: string[],
    parentDepth: number,
  ) => {
    if (persist.rootPersistenceError()) return;

    const childDepth = parentDepth + 1;
    if (profile.maxDepth !== null && childDepth > profile.maxDepth) {
      depthSuppressed += urls.length;
      return;
    }

    const toEnqueue = filterEnqueueUrls(urls, siteMap, enqueueOpts);
    if (toEnqueue.length === 0) return;
    await enqueueLinks({
      urls: toEnqueue,
      strategy: 'all',
      transformRequestFunction: (req: { url: string; uniqueKey?: string; userData?: unknown }) => {
        const out = applyUniqueKey(req);
        out.userData = { ...(out.userData as object | undefined), depth: childDepth };
        return out;
      },
    });
  };

  const HANDLER_TIMEOUT_MS = 60_000;

  const crawler = new CheerioCrawler(
    {
      proxyConfiguration,
      useSessionPool: true,
      persistCookiesPerSession: true,
      minConcurrency,
      maxConcurrency,
      autoscaledPoolOptions,
      maxRequestsPerCrawl,
      maxRequestRetries: 0,
      requestHandlerTimeoutSecs: 60,
      additionalHttpErrorStatusCodes: [429, 503],
      respectRobotsTxtFile: { userAgent: BOT.name },
      onSkippedRequest: async ({ url, reason }) => {
        if (reason === 'robotsTxt') {
          persist.noteReject('robots_disallowed', url, 'robots.txt');
        }
      },
      preNavigationHooks: [
        async ({ request }, gotOptions) => {
          dedup.bump('httpRequests');
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
        const currentDepth = Number((request.userData as { depth?: number } | undefined)?.depth ?? 0);
        if (persist.rootPersistenceError()) {
          request.noRetry = true;
          await crawler.stop();
          return;
        }

        if (isCancelRequested(persist.runId)) {
          cancelled = true;
          request.noRetry = true;
          await crawler.stop();
          return;
        }

        const rawHtml = typeof body === 'string' ? body : String(body ?? '');
        const statusCode = response?.statusCode;
        const finalUrl = request.loadedUrl ?? request.url;
        const owned = new Set<string>();
        let urlKey: string | null = null;
        let htmlKey: string | null = null;
        let committed = false;

        const releaseOwned = () => {
          if (!committed) {
            dedup.release({ urlKey, htmlHash: htmlKey });
          }
        };

        try {
          if (!(await robots.isAllowed(finalUrl))) {
            persist.noteReject('robots_disallowed', finalUrl, 'robots.txt');
            return;
          }

          const localeReject = classifyReject({ finalUrl });
          if (localeReject === 'locale_excluded') {
            persist.noteReject('locale_excluded', finalUrl);
            return;
          }

          dedup.learnRedirect(request.url, finalUrl, scopeUrl);
          urlKey = dedup.resolveKey(finalUrl);
          if (!urlKey) {
            persist.noteReject('request_failed', finalUrl, 'invalid finalUrl key');
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
              requestedUrlKey: dedup.resolveKey(request.url) ?? undefined,
              finalUrlKey: urlKey,
            });
            return;
          }

          const viability = isViableHtml(rawHtml, $ as never);
          if (!viability.viable) {
            if (viability.reason === 'challenge_page') {
              persist.noteReject('challenge_page', finalUrl);
              return;
            }
            // A page that carries no prose without JavaScript contributes
            // nothing, its links included. There is no browser here, so every
            // URL discovered on such a page would be fetched and rejected in
            // turn -- the crawl would pay for the whole site and store none of
            // it. The page is a dead end, not a frontier.
            //
            // The shell signal is reported as requires_javascript, not as a
            // failed extraction: nothing here is broken. A static crawler
            // meeting a JavaScript application is out of scope, the same as a
            // robots-disallowed URL.
            persist.noteReject(
              viability.reason === 'empty_or_spa_shell' ? 'requires_javascript' : 'extract_empty',
              finalUrl,
              viability.reason,
            );
            return;
          }

          htmlKey = htmlHash(rawHtml);
          const htmlReserve = await dedup.reserve({ urlKey, htmlHash: htmlKey }, owned);
          const htmlWait = await dedup.awaitInFlight(htmlReserve, HANDLER_TIMEOUT_MS);
          if (htmlWait.skip) {
            const links = extractHrefs($, finalUrl, scopeUrl);
            await enqueueFiltered(enqueueLinks as never, sameOriginUrls(links), currentDepth);
            await dedup.recordSkip({
              v: 1,
              at: new Date().toISOString(),
              reason: htmlWait.reason,
              cause: htmlWait.cause,
              requestedUrl: request.url,
              finalUrl,
              requestedUrlKey: dedup.resolveKey(request.url) ?? undefined,
              finalUrlKey: urlKey,
              htmlHash: htmlKey,
            });
            return;
          }

          dedup.bump('extractionInvocations');
          const clean = extractCleanContent(rawHtml, finalUrl);
          if (clean.truncated) {
            log.warning(
              `content truncated at cap [${new Date().toISOString()}]: ${finalUrl}`,
            );
          }
          const extractReject = classifyReject({
            finalUrl,
            text: clean.text,
          });
          if (extractReject === 'extract_empty') {
            // Same rule after extraction as before it: no prose, no frontier.
            persist.noteReject('extract_empty', finalUrl);
            return;
          }

          const canonicalKey = dedup.parseCanonicalHref($ as never, finalUrl, scopeUrl);
          const canonSkip = dedup.checkCanonicalAlias(urlKey, canonicalKey);
          if (canonSkip) {
            const links = extractHrefs($, finalUrl, scopeUrl);
            await enqueueFiltered(enqueueLinks as never, sameOriginUrls(links), currentDepth);
            await dedup.recordSkip({
              v: 1,
              at: new Date().toISOString(),
              reason: canonSkip,
              cause: 'accepted',
              requestedUrl: request.url,
              finalUrl,
              requestedUrlKey: dedup.resolveKey(request.url) ?? undefined,
              finalUrlKey: urlKey,
              htmlHash: htmlKey,
            });
            return;
          }

          try {
            const savedPage = await persist.savePage({
              url: request.url,
              finalUrl,
              statusCode,
              html: rawHtml,
              contentHtml: clean.contentHtml,
              text: clean.text,
              title: clean.title,
              excerpt: clean.excerpt,
              robotsAllowed: true,
              fetchMode: 'cheerio',
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

            const links = extractHrefs($, finalUrl, scopeUrl);
            await persist.saveLinks(
              pageId,
              links.map((l) => ({
                fromUrl: finalUrl,
                linkUrl: l.linkUrl,
                isSameOrigin: l.isSameOrigin,
              })),
            );

            await enqueueFiltered(enqueueLinks as never, sameOriginUrls(links), currentDepth);
          } catch (err) {
            if (isPersistenceError(err)) {
              request.noRetry = true;
              await crawler.stop();
              throw err;
            }
            throw err;
          }
        } finally {
          releaseOwned();
        }
      },
      failedRequestHandler: async ({ request }, error) => {
        if (isPersistenceError(error)) {
          request.noRetry = true;
          return;
        }
        log.warning(`Request failed ${request.url}: ${error}`);
        persist.noteReject(
          'request_failed',
          request.url,
          error instanceof Error ? error.message : String(error),
        );
      },
    },
    config,
  );

  try {
    const startUrls = initialCrawlUrls(seeds, siteMap, enqueueOpts);
    log.info(`Starting crawl with ${startUrls.length} URL(s)`);
    await crawler.run(startUrls.map((url) => applyUniqueKey({ url })));

    persist.throwIfPersistenceFailed();
    if (cancelled || isCancelRequested(persist.runId)) {
      // Cancel is destructive: the partial corpus is discarded along with the run. What survives is
      // the post-mortem, which archiveAndPurge writes before anything is destroyed.
      log.info(`Run ${persist.runId} cancelled — discarding the run, keeping its report`);
      await persist.markCancelled('Cancelled by operator');
      await persist.archiveAndPurge('cancelled', 'Cancelled by operator');
    } else {
      await persist.markComplete();
    }
  } catch (err) {
    const root = persist.rootPersistenceError();
    const message = (root ?? err) instanceof Error
      ? (root ?? err as Error).message
      : String(root ?? err);
    await persist.markFailed(message);
    await persist.archiveAndPurge('failed', message);
    throw root ?? err;
  } finally {
    clearCancel(persist.runId);
  }

  const stats = await persist.stats();
  return {
    runId: persist.runId,
    pagesSaved: stats.pagesSaved,
    linksSaved: stats.linksSaved,
    pagesRejectedLocale: stats.pagesRejectedLocale,
    pagesRejectedChallenge: stats.pagesRejectedChallenge,
    pagesRejectedExtractEmpty: stats.pagesRejectedExtractEmpty,
    pagesRejectedRobots: stats.pagesRejectedRobots,
    pagesRejectedRequestFailed: stats.pagesRejectedRequestFailed,
    duplicatePagesSkipped: stats.duplicatePagesSkipped,
    dataDir: persist.dataDir,
    persistMode: persist.mode,
  };
}

export { RobotsBlockedError };
