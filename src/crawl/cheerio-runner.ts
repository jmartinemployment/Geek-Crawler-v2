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
  mergeHarvestedUrls,
  type SiteMapIndex,
} from './sitemap.js';
import { createDirectoryCap } from './link-trap.js';
import { createRobotsGate } from './robots.js';
import { concurrencyOptions, httpAgent, httpsAgent } from './throttle.js';
import type { CrawlType } from './types.js';
import { isViableHtml } from './viability.js';
import {
  abortAfterFromEnv,
  barrenAbortReason,
  barrenTotal,
  emptyBarrenTally,
  isBlockedStatus,
  shouldAbortRun,
} from './early-abort.js';
import { classifyReject } from './reject.js';
import { normalizeSeeds } from '../storage/seed-key.js';
import { htmlHash } from './dedup.js';
import { clearCancel, isCancelRequested } from './cancel-registry.js';
import { MAX_PAGES_PER_SITE, clampToSiteCap } from './crawl-limits.js';
import { createSectionQuota } from './section-quota.js';
import { crawlProfileFor, sectionQuotasFor } from './crawl-profile.js';
import { harvestLinks } from './link-harvest.js';
import { isUnreachable } from '../storage/errors.js';

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
    // Before the run exists, so a site that disallows everything costs one robots.txt request
    // instead of a full walk, a rejected ingest and a purge. See requireSeedAllowed.
    await robots.requireSeedAllowed(seed);
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

  // Two kinds of site are out of scope for a crawler that runs no JavaScript,
  // and identifying either one page by page costs the whole request budget:
  // every URL fetched, every one refused the same way, and the run only reports
  // "no usable pages" once the sitemap is exhausted -- hundreds of fetches to
  // learn what the first twenty-five already said.
  //
  // The discriminator is the yield, not a flag. A site that answers produces
  // pages at some fraction of the rate it refuses them; a site that is
  // blocking produces a rounding error. quickbooks.intuit.com refused 2,499
  // requests and let one through, and a flag that only asked "saved anything?"
  // kept that crawl alive for the whole budget.
  const abortAfter = abortAfterFromEnv('CRAWL_ABORT_AFTER');
  const barren = emptyBarrenTally();
  let pagesSaved = 0;
  let abortReason: string | null = null;

  /**
   * End the run and say why. Crawlee finishes the requests already in flight,
   * so the reason is recorded once and the terminal block acts on it.
   */
  const abortRun = async (reason: string, request: { noRetry: boolean }) => {
    if (abortReason) return;
    abortReason = reason;
    log.warning(reason);
    request.noRetry = true;
    await crawler.stop();
  };

  /** The reject reason each barren kind is reported as. */
  const BARREN_REJECT = {
    shell: 'requires_javascript',
    refused: 'challenge_page',
    noProse: 'extract_empty',
  } as const;

  /**
   * Record a page that produced nothing, and end the run once that is all this
   * site has produced.
   *
   * Every barren outcome goes through here so there is one tally and one
   * threshold. Counting each kind separately was the bug: a site answering half
   * its URLs with a shell and half with a 403 tripped neither counter and
   * crawled out in full.
   */
  const noteBarren = async (
    kind: keyof typeof BARREN_REJECT,
    url: string,
    detail: string | undefined,
    request: { noRetry: boolean },
  ) => {
    persist.noteReject(BARREN_REJECT[kind], url, detail);
    barren[kind === 'shell' ? 'shells' : kind === 'refused' ? 'refused' : 'noProse'] += 1;
    if (
      !shouldAbortRun({ pagesSaved, rejects: barrenTotal(barren), abortAfter })
    ) {
      return;
    }
    await abortRun(barrenAbortReason(barren), request);
  };

  // Scope policy is per crawl type. project-site disables section quotas: they exist to stop a
  // third party's page farm eating the budget, and on the operator's own site they would starve
  // the very directories the heading hierarchy is built from.
  const profile = crawlProfileFor(input.crawlType);
  const quotaLimits = sectionQuotasFor(input.crawlType);
  const quota = quotaLimits === null ? undefined : createSectionQuota(quotaLimits);
  if (quotaLimits === null) {
    log.info(`Section quotas disabled for crawlType=${input.crawlType}`);
  }
  // The directory cap rides with the section quotas: both exist to stop a third party's generated
  // directories eating the budget, and project-site disables both for the same reason.
  const enqueueOpts = {
    aliases: dedup.aliases,
    counters: dedup.counters,
    quota,
    directoryCap: quota ? createDirectoryCap() : undefined,
    ledger: persist.discovery,
  };

  const { minConcurrency, maxConcurrency, autoscaledPoolOptions } = concurrencyOptions({
    maxConcurrency: input.maxConcurrency,
  });
  const proxyConfiguration = buildProxyConfiguration();

  const siteMap: SiteMapIndex = await loadSiteMapIndex(seeds);
  persist.discovery.setSitemap(siteMap.hasMap, siteMap.urls.size, siteMap.truncated);
  if (siteMap.hasMap) {
    log.info(
      `Sitemap seeds the crawl: ${siteMap.urls.size} URL(s)` +
        `${siteMap.truncated ? ' (truncated at the loader ceiling)' : ''}; ` +
        'links it omits are admitted under the trap rules and quotas',
    );
  } else {
    log.info('No sitemap map found — same-site BFS (tracking params stripped)');
  }
  log.info(`Concurrency min=${minConcurrency} max=${maxConcurrency}`);

  let maxRequestsPerCrawl: number;
  if (input.maxRequestsPerCrawl != null && Number.isFinite(input.maxRequestsPerCrawl)) {
    maxRequestsPerCrawl = clampToSiteCap(input.maxRequestsPerCrawl);
    log.info(`Request budget override: maxRequestsPerCrawl=${maxRequestsPerCrawl}`);
  } else {
    // The profile, never the sitemap. Sized from the sitemap -- min(sitemap, profile) -- the budget
    // was exactly the sitemap's length whenever that was under 2,500, so every page the sitemap
    // omitted could only be fetched by displacing one it listed. The profile is also what keeps
    // budgets behaviour rather than documentation, which is what the min was originally for.
    maxRequestsPerCrawl = clampToSiteCap(profile.defaultMaxPages);
    log.info(
      `Request budget from ${input.crawlType} profile: maxRequestsPerCrawl=${maxRequestsPerCrawl}`,
    );
  }
  persist.discovery.setBudget(maxRequestsPerCrawl);

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

  /**
   * Whether this run has already reported a body-rooted extract. Logged once per
   * crawl, not once per page: a site that declares no `main` or `article`
   * declares none on every page, and 2,500 identical warnings would bury the
   * rest of the log.
   */
  let bodyRootReported = false;

  /**
   * parentDepth is the depth of the page whose links these are; start urls are depth 0. Past the
   * profile's cap, links the sitemap omits are refused and counted per URL in the discovery report;
   * links it lists are already queued at depth 0, so the cap never touches them.
   *
   * Two enqueue calls because forefront is per call: off-sitemap product and evidence links go to
   * the front of the queue, everything else to the back. See filterEnqueueUrls.
   */
  const enqueueFiltered = async (
    enqueueLinks: (opts: Record<string, unknown>) => Promise<unknown>,
    urls: string[],
    parentDepth: number,
  ) => {
    if (persist.rootPersistenceError()) return;

    const childDepth = parentDepth + 1;
    const depthExceeded = profile.maxDepth !== null && childDepth > profile.maxDepth;
    const toEnqueue = filterEnqueueUrls(urls, siteMap, enqueueOpts, { depthExceeded });
    const transformRequestFunction = (req: {
      url: string;
      uniqueKey?: string;
      userData?: unknown;
    }) => {
      const out = applyUniqueKey(req);
      out.userData = { ...(out.userData as object | undefined), depth: childDepth };
      return out;
    };
    for (const forefront of [true, false]) {
      const batch = toEnqueue.filter((c) => c.forefront === forefront).map((c) => c.url);
      if (batch.length === 0) continue;
      await enqueueLinks({ urls: batch, strategy: 'all', forefront, transformRequestFunction });
    }
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
        persist.discovery.markFetched(url);
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
        persist.discovery.markFetched(request.url);
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

          // A 4xx or 5xx body is the server's error page, not the site's
          // content. Crawlee hands 401, 403, 404 and 410 to this handler with
          // the body attached -- only 5xx and the codes named in
          // additionalHttpErrorStatusCodes are thrown -- so without this gate a
          // "You do not have permission to access this resource" page clears
          // the prose floor and is persisted as corpus under its own URL.
          if (statusCode !== undefined && statusCode >= 400) {
            if (isBlockedStatus(statusCode)) {
              // Refused, not broken: the site is turning away a non-browser
              // client, which is the same answer it will give for every
              // remaining URL.
              await noteBarren('refused', finalUrl, `HTTP ${statusCode}`, request);
              return;
            }
            // A 404 or a 500 says nothing about the rest of the site, so it is
            // reported and never counted toward abandoning it.
            persist.noteReject('request_failed', finalUrl, `HTTP ${statusCode}`);
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
              // A challenge served with a 200 is the same refusal as a 403,
              // dressed as a page, so it feeds the same counter.
              await noteBarren('refused', finalUrl, 'challenge page served with 200', request);
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
            //
            // Both branches count. empty_or_spa_shell is only returned for a
            // page with no text at all or one of three known mount-point ids
            // (#root, #__next, #app), so a JavaScript-only site that renders a
            // nav or a footer, or mounts anywhere else -- Next's App Router has
            // no #__next, Angular uses app-root -- lands on insufficient_text
            // instead. Counting only the shells left exactly those sites
            // crawling out in full.
            await noteBarren(
              viability.reason === 'empty_or_spa_shell' ? 'shell' : 'noProse',
              finalUrl,
              viability.reason,
              request,
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
          if (clean.contentRoot === 'body' && !bodyRootReported) {
            bodyRootReported = true;
            // Not an error: `body` is the last of the ordered content roots and a
            // legitimate outcome. It does mean the site offers no semantic
            // landmark to root the extract on, so whatever chrome the selector
            // pass missed is inside the corpus for every page of it. Worth
            // knowing while the crawl runs rather than inferring afterwards.
            log.info(
              `content root is body — site declares no main/article: ${finalUrl}`,
            );
          }
          const extractReject = classifyReject({
            finalUrl,
            text: clean.text,
          });
          if (extractReject === 'extract_empty') {
            // Same rule after extraction as before it: no prose, no frontier.
            await noteBarren('noProse', finalUrl, 'no prose after extraction', request);
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
            // The yield the early abort measures itself against.
            pagesSaved += 1;
            const savedPage = await persist.savePage({
              url: request.url,
              finalUrl,
              statusCode,
              html: rawHtml,
              contentHtml: clean.contentHtml,
              blocks: clean.blocks,
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
      failedRequestHandler: async ({ request, response }, error) => {
        persist.discovery.markFetched(request.url);
        if (isPersistenceError(error)) {
          request.noRetry = true;
          return;
        }
        log.warning(`Request failed ${request.url}: ${error}`);

        // 429 and 503 are thrown rather than handled, so a rate-limited site
        // arrives here instead of at the status gate above. The response is
        // already on the context when the throw comes from the status code; a
        // transport failure leaves it undefined, which is why a DNS error or a
        // timeout cannot be mistaken for a refusal.
        const statusCode = response?.statusCode;
        if (isBlockedStatus(statusCode)) {
          await noteBarren('refused', request.url, `HTTP ${statusCode}`, request);
          return;
        }

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
    let startUrls = initialCrawlUrls(seeds, siteMap, enqueueOpts);

    // Link discovery, for the sites a static fetch cannot see.
    //
    // Only when there is no sitemap: the map already is the url list, so bill.com and medius.com
    // never launch a browser. Where it does run it is one page load, and the pages themselves are
    // still fetched by Cheerio -- measured on lightyear.cloud, 6 static links became 57 in 2.0s
    // (12 of them product), and on parseur.com 0 became 77 in 0.6s (24 product).
    //
    // Fails the crawl rather than continuing. A site with no sitemap and a JavaScript nav yields a
    // blog-only corpus that looks like a successful crawl, which is the silent failure plans/rules
    // §3a exists to forbid -- lightyear.cloud produced 148 pages, 129 of them blog posts, and
    // reported complete.
    if (!siteMap.hasMap) {
      const seed = seeds[0];
      if (seed) {
        const harvested = await harvestLinks(seed);
        if (!harvested.ok) {
          throw new Error(
            `Link discovery failed for ${seed}: ${harvested.reason}. The site has no sitemap, so ` +
              'its urls cannot be discovered from static HTML alone; crawling it now would yield ' +
              'whatever happens to be statically linked and report success.',
          );
        }
        const before = startUrls.length;
        startUrls = mergeHarvestedUrls(startUrls, harvested.urls, enqueueOpts);
        log.info(
          `Link discovery: ${before} static url(s) -> ${startUrls.length} after one browser pass`,
        );
      }
    }

    log.info(`Starting crawl with ${startUrls.length} URL(s)`);
    await crawler.run(startUrls.map((url) => applyUniqueKey({ url })));

    persist.throwIfPersistenceFailed();
    if (abortReason) {
      // Failed rather than complete: nothing was published, and the reason names
      // the cause. Left to finish, GeekAPI answers "no usable pages" - the same
      // sentence it returns for an all-robots-blocked or an all-403 site.
      await persist.markFailed(abortReason);
      await persist.archiveAndPurge('failed', abortReason);
    } else if (cancelled || isCancelRequested(persist.runId)) {
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
    const cause = root ?? err;
    const message = cause instanceof Error ? cause.message : String(cause);
    await persist.markFailed(message);

    // Purge only when the failure is determinate.
    //
    // Every error took this path until 2026-09-30, and archiveAndPurge destroys the crawl. Three
    // finished crawls went in one minute -- parseur 180 pages, quickbooks 81, zoneandco 342 --
    // because Railway answered `404 {"message":"Application not found"}` while GeekAPI redeployed.
    // A further 1,192 pages went to 5xx on pages/batch. None of those errors said anything about
    // the run; they said the sink was not there.
    //
    // A determinate refusal still purges: GeekAPI's 400 for pages with no extracted content and its
    // 409 for a run complete with nothing usable are judgements about this crawl, and the data
    // genuinely should go. What changes is that "the API was absent" no longer counts as one.
    //
    // The post-mortem is written either way, so a kept run is recoverable rather than merely
    // undeleted: archiveFailure writes the same record with no purge outcome. markFailed does not
    // write it -- it only patches the GeekAPI row -- and the run that GeekAPI could not be reached
    // to patch is precisely the one whose record has to come from here.
    if (isUnreachable(cause)) {
      await persist.archiveFailure('failed', message);
      log.error(
        `Run ${persist.runId} failed because GeekAPI was unreachable, keeping crawl data for ` +
          `re-post: ${message}`,
      );
    } else {
      await persist.archiveAndPurge('failed', message);
    }
    throw root ?? err;
  } finally {
    clearCancel(persist.runId);
  }

  // Composition by tier, which the discovery report does not carry: it counts URLs by what became
  // of them, not by what kind of page they are. Without this line the evidence tier's effect on a
  // live crawl is unobservable. Absent for project-site, where quotas are disabled outright.
  if (quota) {
    const tiers = quota.admittedByTier();
    log.info(
      `composition runId=${persist.runId} product=${tiers.product} evidence=${tiers.evidence} ` +
        `other=${tiers.other} editorial=${tiers.editorial} ` +
        `suppressedByShare=${quota.suppressedByShare()} ` +
        `suppressedBySectionCap=${quota.totalSuppressed()}`,
    );
  }

  // The same report sent in hostProgressJson, summarised so a crawl log answers "what did it skip"
  // without a GeekAPI round trip.
  const discovery = persist.discovery.report();
  const refusals = Object.entries(discovery.refused)
    .filter(([, n]) => n > 0)
    .map(([rule, n]) => `${rule}=${n}`)
    .join(' ');
  log.info(
    `discovery runId=${persist.runId} discovered=${discovery.discovered} ` +
      `enqueued=${discovery.enqueued.total} fetched=${discovery.fetched} ` +
      `unfetched=${discovery.enqueuedNotFetched} budgetExhausted=${discovery.budgetExhausted} ` +
      `offSitemapAdmitted=${discovery.offSitemapAdmitted} ` +
      `offSitemapSuppressed=${discovery.offSitemapSuppressed}` +
      (refusals ? ` refused: ${refusals}` : ''),
  );

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
