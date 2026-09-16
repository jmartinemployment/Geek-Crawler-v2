import { createFilesystemRawBodyStore, type RawBodyStore } from './raw-body.js';
import { createGeekApiClient, type GeekApiClient } from './geek-api-client.js';
import { PersistenceError, isPersistenceError } from './errors.js';
import { createJsonRunStore, type CrawlLinkMeta, type RunStore } from './runs.js';
import { computeSeedKey, normalizeSeeds, originOf } from './seed-key.js';
import type { CrawlType } from '../crawl/types.js';
import {
  bumpRejectCounter,
  classifyReject,
  emptyRejectCounters,
  RejectSampleLog,
  rejectStatsHostProgressEntry,
  type RejectCounters,
  type RejectReason,
} from '../crawl/reject.js';
import {
  createPageDedupTracker,
  type DedupCounters,
  type PageDedupTracker,
} from './page-dedup.js';
import { log } from 'crawlee';

export type PersistPageInput = {
  url: string;
  finalUrl?: string;
  statusCode?: number;
  html?: string;
  markdown?: string | null;
  title?: string | null;
  excerpt?: string | null;
  robotsAllowed: boolean;
  failureReason?: string;
  fetchMode: 'cheerio';
  dedup?: {
    owned: Set<string>;
    urlKey: string;
    requestedUrlKey: string;
    htmlHash: string;
    canonicalKey: string | null;
    aliasKeys?: string[];
  };
};

export type CrawlPersist = {
  runId: string;
  mode: 'api';
  dataDir: string;
  rawBodyStore: RawBodyStore;
  localMeta: RunStore;
  dedup: PageDedupTracker;
  begin(): Promise<void>;
  markRunning(): Promise<void>;
  markComplete(): Promise<void>;
  /** One patchRun(failed) attempt; never writes local authority on failure. */
  markFailed(errorSummary: string): Promise<void>;
  /** One patchRun(cancelled) attempt. Terminal — cancel is never a pause. */
  markCancelled(reason: string): Promise<void>;
  throwIfPersistenceFailed(): void;
  rootPersistenceError(): PersistenceError | null;
  noteReject(reason: RejectReason, url: string, detail?: string): void;
  savePage(page: PersistPageInput): Promise<{ pageId: string } | null>;
  saveLinks(pageId: string, links: CrawlLinkMeta[]): Promise<void>;
  stats(): Promise<
    {
      pagesSaved: number;
      linksSaved: number;
      duplicatePagesSkipped: number;
      dedupLedgerBackfilled: boolean;
    } & RejectCounters &
      DedupCounters
  >;
};

/** Serialize GeekAPI writes; first failure is terminal (no new outbound writes). */
function createPersistCoordinator() {
  let chain: Promise<void> = Promise.resolve();
  let rootFailure: PersistenceError | null = null;

  return {
    rootFailure(): PersistenceError | null {
      return rootFailure;
    },
    setFailed(err: PersistenceError): void {
      rootFailure ??= err;
    },
    async run<T>(fn: () => Promise<T>): Promise<T> {
      const runExclusive = async (): Promise<T> => {
        if (rootFailure) throw rootFailure;
        try {
          const result = await fn();
          if (rootFailure) throw rootFailure;
          return result;
        } catch (err) {
          const pe = isPersistenceError(err)
            ? err
            : new PersistenceError(err instanceof Error ? err.message : String(err), {
                cause: err,
              });
          rootFailure ??= pe;
          throw rootFailure;
        }
      };
      const next = chain.then(runExclusive, runExclusive);
      chain = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
}

export function createCrawlPersist(input: {
  crawlType: CrawlType;
  seeds: string[];
  dataDir: string;
}): CrawlPersist {
  const seeds = normalizeSeeds(input.seeds);
  if (seeds.length === 0) throw new PersistenceError('No valid seed URLs');

  const client: GeekApiClient = createGeekApiClient();
  const mode = 'api' as const;

  const rawBodyStore = createFilesystemRawBodyStore(input.dataDir);
  const localMeta = createJsonRunStore(input.dataDir);
  const seedKey = computeSeedKey(seeds);
  const coordinator = createPersistCoordinator();

  let runId = '';
  let pagesSaved = 0;
  let pagesWithoutMarkdown = 0;
  let linksSaved = 0;
  const rejectCounters = emptyRejectCounters();
  const rejectSamples = new RejectSampleLog();
  let dedup = createPageDedupTracker({ dataDir: input.dataDir, runId: 'pending' });

  function rebuildDedup(): void {
    dedup = createPageDedupTracker({ dataDir: input.dataDir, runId });
  }

  function recordReject(reason: RejectReason, url: string, detail?: string): void {
    bumpRejectCounter(rejectCounters, reason);
    const sampled = rejectSamples.note(reason, url, detail);
    if (sampled) {
      log.info(
        `Reject ${reason}: ${sampled.url}${sampled.detail ? ` (${sampled.detail})` : ''}`,
      );
    }
  }

  function hostProgressJson(): string {
    return JSON.stringify([
      rejectStatsHostProgressEntry(
        rejectCounters,
        pagesSaved,
        rejectSamples.snapshot(),
        dedup.counters,
      ),
    ]);
  }

  return {
    get runId() {
      return runId;
    },
    mode,
    dataDir: input.dataDir,
    rawBodyStore,
    localMeta,
    get dedup() {
      return dedup;
    },

    async begin() {
      const created = await coordinator.run(() =>
        client.createRun({
          crawlType: input.crawlType,
          seeds,
        }),
      );
      const id = typeof created.runId === 'string' ? created.runId.trim() : '';
      if (!id) {
        throw new PersistenceError(`GeekAPI createRun returned no runId`);
      }
      runId = id;
      rebuildDedup();
      // Engine scratch for in-process control plane only — not crawl authority.
      await localMeta.createRun({
        runId,
        crawlType: input.crawlType,
        seeds,
      });
      console.log(
        `Persist mode=api runId=${runId} seedKey=${seedKey.slice(0, 12)}… via GeekAPI`,
      );
    },

    async markRunning() {
      await localMeta.markRunning(runId);
    },

    async markComplete() {
      const completedAtUtc = new Date().toISOString();
      const markdownReady = pagesSaved > 0 && pagesWithoutMarkdown === 0;
      await coordinator.run(() =>
        client.patchRun(runId, {
          status: 'complete',
          completedAtUtc,
          markdownReadyAt: markdownReady ? completedAtUtc : undefined,
          clearMarkdownReadyAt: !markdownReady,
          hostProgressJson: hostProgressJson(),
        }),
      );
      await localMeta.markComplete(runId);
    },

    async markCancelled(reason: string) {
      const bounded = reason.slice(0, 500);
      const completedAtUtc = new Date().toISOString();
      try {
        await coordinator.run(() =>
          client.patchRun(runId, {
            status: 'cancelled',
            errorSummary: bounded,
            completedAtUtc,
            clearMarkdownReadyAt: true,
            hostProgressJson: hostProgressJson(),
          }),
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.error(
          JSON.stringify({
            code: 'STATUS_PATCH_FAILED',
            runId,
            message: detail.slice(0, 500),
            rootError: bounded,
          }),
        );
      }
    },

    async markFailed(errorSummary: string) {
      const bounded = errorSummary.slice(0, 500);
      const completedAtUtc = new Date().toISOString();
      try {
        await coordinator.run(() =>
          client.patchRun(runId, {
            status: 'failed',
            errorSummary: bounded,
            completedAtUtc,
            hostProgressJson: hostProgressJson(),
          }),
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.error(
          JSON.stringify({
            code: 'STATUS_PATCH_FAILED',
            runId,
            message: detail.slice(0, 500),
            rootError: bounded,
          }),
        );
      }
    },

    throwIfPersistenceFailed() {
      const root = coordinator.rootFailure();
      if (root) throw root;
    },

    rootPersistenceError() {
      return coordinator.rootFailure();
    },

    noteReject(reason, url, detail) {
      recordReject(reason, url, detail);
    },

    async savePage(page) {
      const finalUrl = page.finalUrl || page.url;
      const rejectReason = !page.robotsAllowed
        ? 'robots_disallowed'
        : page.failureReason?.trim()
          ? 'request_failed'
          : classifyReject({ finalUrl, markdown: page.markdown });
      if (rejectReason) {
        recordReject(rejectReason, finalUrl, page.failureReason);
        if (page.dedup) {
          dedup.release({
            urlKey: page.dedup.urlKey,
            htmlHash: page.dedup.htmlHash,
          });
        }
        return null;
      }

      const markdown = page.markdown ?? '';
      const owned = page.dedup?.owned ?? new Set<string>();
      const contentCheck = await dedup.checkContentAndNear({
        markdown,
        url: finalUrl,
        title: page.title,
        canonicalUrl: page.dedup?.canonicalKey,
      });

      if (contentCheck.skip) {
        await dedup.recordSkip({
          v: 1,
          at: new Date().toISOString(),
          reason: contentCheck.reason,
          cause: 'accepted',
          requestedUrl: page.url,
          finalUrl,
          requestedUrlKey: page.dedup?.requestedUrlKey,
          finalUrlKey: page.dedup?.urlKey,
          htmlHash: page.dedup?.htmlHash,
          contentHash: contentCheck.contentHash,
          near: contentCheck.near,
        });
        if (page.dedup) {
          dedup.release({
            urlKey: page.dedup.urlKey,
            htmlHash: page.dedup.htmlHash,
          });
        }
        return null;
      }

      const contentReserve = await dedup.reserve(
        { contentHash: contentCheck.contentHash },
        owned,
      );
      const contentWait = await dedup.awaitInFlight(contentReserve, 60_000);
      if (contentWait.skip) {
        await dedup.recordSkip({
          v: 1,
          at: new Date().toISOString(),
          reason: contentWait.reason,
          cause: contentWait.cause,
          requestedUrl: page.url,
          finalUrl,
          requestedUrlKey: page.dedup?.requestedUrlKey,
          finalUrlKey: page.dedup?.urlKey,
          htmlHash: page.dedup?.htmlHash,
          contentHash: contentCheck.contentHash,
        });
        if (page.dedup) {
          dedup.release({
            urlKey: page.dedup.urlKey,
            htmlHash: page.dedup.htmlHash,
          });
        }
        return null;
      }

      const origin = originOf(finalUrl);

      let pageId: string;
      try {
        const created = await coordinator.run(() =>
          client.createPagesBatch(runId, [
            {
              origin,
              url: page.url,
              finalUrl: page.finalUrl ?? page.url,
              statusCode: page.statusCode ?? 0,
              robotsAllowed: page.robotsAllowed,
              html: page.html ?? null,
              markdown: page.markdown ?? null,
              title: page.title ?? null,
              excerpt: page.excerpt ?? null,
              failureReason: page.failureReason ?? null,
            },
          ]),
        );
        pageId = created[0]!.pageId;
      } catch (error) {
        dedup.release({
          urlKey: page.dedup?.urlKey,
          htmlHash: page.dedup?.htmlHash,
          contentHash: contentCheck.contentHash,
        });
        throw isPersistenceError(error)
          ? error
          : new PersistenceError(`page persistence ${finalUrl}`, { cause: error });
      }

      await localMeta.recordAcceptedPage(runId, true);

      await dedup.commitAccepted({
        v: 1,
        pageId,
        at: new Date().toISOString(),
        requestedUrlKey: page.dedup?.requestedUrlKey ?? page.dedup?.urlKey ?? finalUrl,
        finalUrlKey: page.dedup?.urlKey ?? finalUrl,
        aliasKeys: page.dedup?.aliasKeys,
        canonicalKey: page.dedup?.canonicalKey ?? undefined,
        htmlHash: page.dedup?.htmlHash,
        contentHash: contentCheck.contentHash,
        simhash: contentCheck.simhash,
        markdownLength: markdown.length,
      });
      if (page.dedup?.canonicalKey) {
        dedup.registerCanonicalGroup(page.dedup.canonicalKey, pageId, page.dedup.urlKey);
      }
      dedup.noteContentAccepted({
        simhash: contentCheck.simhash,
        contentHash: contentCheck.contentHash,
        pageId,
        url: finalUrl,
        title: page.title,
        markdownLength: markdown.length,
        canonicalUrl: page.dedup?.canonicalKey,
        excerpt: markdown.replace(/\s+/g, ' ').trim().slice(0, 500),
      });

      pagesSaved += 1;
      if (!page.markdown?.trim()) pagesWithoutMarkdown += 1;
      return { pageId };
    },

    async saveLinks(pageId, links) {
      if (links.length === 0) return;
      await coordinator.run(() =>
        client.createLinksBatch(
          runId,
          links.map((l) => ({
            pageId,
            fromUrl: l.fromUrl,
            linkUrl: l.linkUrl,
            isSameOrigin: l.isSameOrigin,
          })),
        ),
      );
      await localMeta.recordAcceptedLinks(runId, links.length);
      linksSaved += links.length;
    },

    async stats() {
      const d = dedup.counters;
      return {
        pagesSaved,
        linksSaved,
        duplicatePagesSkipped:
          d.skippedUrl +
          d.skippedHtml +
          d.skippedCanonicalAlias +
          d.skippedContent +
          d.skippedNearDuplicate,
        dedupLedgerBackfilled: dedup.dedupLedgerBackfilled,
        ...rejectCounters,
        ...d,
      };
    },
  };
}

export { isGeekApiConfigured } from './geek-api-client.js';
export { PersistenceError, ConfigError, RobotsBlockedError, isPersistenceError } from './errors.js';
