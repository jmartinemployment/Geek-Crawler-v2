import { rm } from 'node:fs/promises';
import path from 'node:path';
import { createFilesystemRawBodyStore, type RawBodyStore } from './raw-body.js';
import { createGeekApiClient, type CrawlReport, type GeekApiClient } from './geek-api-client.js';
import { PersistenceError, isPersistenceError } from './errors.js';
import { archiveRun, type PurgeOutcome } from './failure-archive.js';
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
  type RejectSample,
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
  /** Clean semantic HTML fragment: the corpus body. */
  contentHtml?: string | null;
  /** Prose only. Drives the reject floor, the content hash and the simhash. */
  text?: string | null;
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
  /**
   * Write the post-mortem, then destroy everything else the run owns.
   *
   * Called only after a terminal non-success transition. The archive is written first: a purge
   * that leaves no explanation behind is the one outcome this exists to prevent.
   */
  archiveAndPurge(status: 'failed' | 'cancelled', errorSummary: string): Promise<void>;
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
  let pagesWithoutContent = 0;
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

  /**
   * The completion report, from the counters this crawler already keeps.
   *
   * robots, locale and JavaScript-dependent pages sit under excludedByPolicy rather than failures:
   * the crawler was told not to take those pages, or cannot by design, and did not take them. A site
   * whose robots.txt excludes 500 URLs is a crawl working correctly, and reporting 500 "errors"
   * would bury the handful that actually failed. Needing a browser is the same kind of fact: this
   * crawler runs no JavaScript on purpose, so a page that has nothing to say without it was never
   * in scope.
   */
  function crawlReport(): CrawlReport {
    return {
      linksStored: linksSaved,
      excludedByPolicy: {
        robotsDisallowed: rejectCounters.pagesRejectedRobots,
        localeExcluded: rejectCounters.pagesRejectedLocale,
        requiresJavascript: rejectCounters.pagesRejectedRequiresJavascript,
      },
      failed: {
        requestFailed: rejectCounters.pagesRejectedRequestFailed,
        challengePage: rejectCounters.pagesRejectedChallenge,
        extractEmpty: rejectCounters.pagesRejectedExtractEmpty,
      },
      // snapshot() is keyed by reason; flatten so each sample carries the reason it belongs to.
      // A sample URL without its reason is not actionable.
      samples: Object.entries(rejectSamples.snapshot()).flatMap(([reason, entries]) =>
        entries.map((entry) => ({ reason, url: entry.url, detail: entry.detail })),
      ),
    };
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
      // createRun validates the acknowledgment and throws on a runless one, so a snapshot that
      // gets here always carries a runId.
      runId = created.runId;
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
      const contentReady = pagesSaved > 0 && pagesWithoutContent === 0;
      await coordinator.run(() =>
        client.patchRun(runId, {
          status: 'complete',
          report: crawlReport(),
          completedAtUtc,
          contentReadyAt: contentReady ? completedAtUtc : undefined,
          clearContentReadyAt: !contentReady,
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
            report: crawlReport(),
            errorSummary: bounded,
            completedAtUtc,
            clearContentReadyAt: true,
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
            report: crawlReport(),
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

    async archiveAndPurge(status: 'failed' | 'cancelled', errorSummary: string) {
      const purgedAtUtc = new Date().toISOString();
      const errors: string[] = [];

      // The authority purge and the local sweep are attempted after the archive, and their outcome
      // is recorded rather than retried. A run whose rows survive is reported as such; there is no
      // second attempt and no alternate route.
      let vectorsPurged = false;
      let crawlDataDeleted = false;
      const localRemoved: string[] = [];

      const record = {
        runId,
        seed: seeds[0] ?? '',
        crawlType: input.crawlType,
        status,
        errorSummary: errorSummary.slice(0, 500) || null,
        createdAtUtc: purgedAtUtc,
        purgedAtUtc,
        pagesSaved,
        linksSaved,
        report: crawlReport(),
        rejectSamples: rejectSamples.snapshot() as Record<string, RejectSample[]>,
        dedup: { ...dedup.counters } as Record<string, number | boolean>,
        purge: { vectorsPurged, crawlDataDeleted, localRemoved } as PurgeOutcome,
      };

      // Archive before destroying anything. If this throws, the run keeps its data and the caller
      // sees the failure — losing the corpus and the explanation together is the worst outcome.
      await archiveRun(input.dataDir, record);

      try {
        const purged = await client.deleteRun(runId);
        vectorsPurged = purged.vectorsPurged;
        crawlDataDeleted = purged.crawlDataDeleted;
      } catch (err) {
        errors.push(`deleteRun: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Only once the authority has actually dropped the run. A purge that failed leaves rows
      // alive, and clearing the local record then would strand them with nothing on this machine
      // pointing at them — the exact orphan state this plan exists to remove.
      if (crawlDataDeleted) {
        for (const target of [
          path.join(input.dataDir, 'runs', runId),
          path.join(input.dataDir, '.crawlee', runId),
        ]) {
          try {
            await rm(target, { recursive: true, force: true });
            localRemoved.push(target);
          } catch (err) {
            errors.push(`${target}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      // Rewrite with what actually happened. The first write guaranteed the post-mortem exists;
      // this one makes it accurate.
      record.purge = {
        vectorsPurged,
        crawlDataDeleted,
        localRemoved,
        ...(errors.length > 0 ? { errors } : {}),
      };
      await archiveRun(input.dataDir, record);

      console.log(
        JSON.stringify({
          event: 'run_purged',
          runId,
          status,
          pagesSaved,
          linksSaved,
          vectorsPurged,
          crawlDataDeleted,
          localRemoved: localRemoved.length,
          ...(errors.length > 0 ? { errors } : {}),
        }),
      );
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
          // A body supplied with no prose measurement is a caller that forgot
          // `text`; treat the prose as empty and reject rather than admit a page
          // nothing has measured.
          : classifyReject({
              finalUrl,
              text: page.contentHtml === undefined ? page.text : (page.text ?? ''),
            });
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

      // Hashing and near-duplicate detection run over prose, not over the
      // fragment: tags are identical on every page of a site, so a simhash of
      // markup is dominated by boilerplate tokens and stops discriminating.
      const text = page.text ?? '';
      const owned = page.dedup?.owned ?? new Set<string>();
      const contentCheck = await dedup.checkContentAndNear({
        text,
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
              contentHtml: page.contentHtml ?? null,
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
        contentLength: text.length,
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
        contentLength: text.length,
        canonicalUrl: page.dedup?.canonicalKey,
        excerpt: text.replace(/\s+/g, ' ').trim().slice(0, 500),
      });

      pagesSaved += 1;
      if (!page.contentHtml?.trim()) pagesWithoutContent += 1;
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
