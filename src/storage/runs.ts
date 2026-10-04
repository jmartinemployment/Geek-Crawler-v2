import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RejectSample } from '../crawl/reject.js';
import type { CrawlType } from '../crawl/types.js';
import type { DiscoveryReport } from '../crawl/discovery-ledger.js';

export type CrawlRunMeta = {
  runId: string;
  /** Version 2 stores accepted-page counts needed for safe resume readiness. */
  storageContractVersion?: 2;
  crawlType: CrawlType;
  status: 'pending' | 'running' | 'complete' | 'failed' | 'cancelled';
  seeds: string[];
  createdAtUtc: string;
  startedAtUtc?: string;
  completedAtUtc?: string;
  /**
   * When the run's content became ready for downstream indexing, mirroring what
   * was sent to GeekAPI on completion. Undefined means not ready.
   *
   * Kept locally because this is the signal the RAG library schedules on, and
   * without it a local record cannot say whether a completed run is eligible
   * for indexing. Nothing here decides readiness - GeekAPI owns that - this
   * only stops the local view having to guess.
   */
  contentReadyAt?: string;
  errorSummary?: string;
  pagesSaved: number;
  pagesWithoutContent?: number;
  linksSaved: number;
  pagesRejectedLocale?: number;
  pagesRejectedRequiresJavascript?: number;
  pagesRejectedChallenge?: number;
  pagesRejectedExtractEmpty?: number;
  pagesRejectedRobots?: number;
  pagesRejectedRequestFailed?: number;
  /** Rows not written because the resolved final URL was already saved this run. */
  duplicatePagesSkipped?: number;
  dedupLedgerBackfilled?: boolean;
  enqueueAttempts?: number;
  enqueueSuppressedLocal?: number;
  enqueueSuppressedQueue?: number;
  httpRequests?: number;
  browserRenders?: number;
  extractionInvocations?: number;
  skippedUrl?: number;
  skippedHtml?: number;
  skippedCanonicalAlias?: number;
  skippedContent?: number;
  skippedNearDuplicate?: number;
  skipCauseAccepted?: number;
  skipCauseInFlight?: number;
  aliasesLearned?: number;
  rejectSamples?: {
    locale_excluded?: RejectSample[];
    requires_javascript?: RejectSample[];
    challenge_page?: RejectSample[];
    extract_empty?: RejectSample[];
    robots_disallowed?: RejectSample[];
    request_failed?: RejectSample[];
  };
  /** What became of every URL the crawl discovered. See discovery-ledger.ts. */
  discovery?: DiscoveryReport;
};

export type CrawlLinkMeta = {
  fromUrl: string;
  linkUrl: string;
  isSameOrigin: boolean;
};

export type RunStore = {
  createRun(input: {
    runId: string;
    crawlType: CrawlType;
    seeds: string[];
  }): Promise<CrawlRunMeta>;
  markRunning(runId: string): Promise<void>;
  markComplete(runId: string, contentReadyAt?: string | null): Promise<void>;
  markFailed(runId: string, errorSummary: string): Promise<void>;
  /** Merge reject counters + samples into run.json (no page body). */
  recordRejectStats(
    runId: string,
    stats: {
      pagesRejectedLocale?: number;
      pagesRejectedRequiresJavascript?: number;
      pagesRejectedChallenge?: number;
      pagesRejectedExtractEmpty?: number;
      pagesRejectedRobots?: number;
      pagesRejectedRequestFailed?: number;
      duplicatePagesSkipped?: number;
      dedupLedgerBackfilled?: boolean;
      enqueueAttempts?: number;
      enqueueSuppressedLocal?: number;
      enqueueSuppressedQueue?: number;
      httpRequests?: number;
      browserRenders?: number;
      extractionInvocations?: number;
      skippedUrl?: number;
      skippedHtml?: number;
      skippedCanonicalAlias?: number;
      skippedContent?: number;
      skippedNearDuplicate?: number;
      skipCauseAccepted?: number;
      skipCauseInFlight?: number;
      aliasesLearned?: number;
      rejectSamples?: CrawlRunMeta['rejectSamples'];
      discovery?: DiscoveryReport;
    },
  ): Promise<void>;
  recordAcceptedPage(runId: string, hasContent: boolean): Promise<void>;
  recordAcceptedLinks(runId: string, count: number): Promise<void>;
  getRun(runId: string): Promise<CrawlRunMeta | null>;
  listRuns(): Promise<CrawlRunMeta[]>;
  /**
   * When this run's record was last written, or null when it has none on disk.
   *
   * A run that claims to be running is only believable while something is still
   * writing to it, and the store owns its own file layout, so that question is
   * answered here rather than by a caller rebuilding the path from dataDir. Two
   * places computing the same path is the drift this repo keeps paying for.
   */
  lastWriteAt(runId: string): Promise<Date | null>;
  /**
   * Mark the run as still being worked on, without changing what it says.
   *
   * lastWriteAt is what tells a restarting API whether a run still has a writer,
   * and the record is only rewritten when a page or its links are accepted. A
   * crawl grinding through a long run of rejected URLs is working hard and
   * looks idle. This closes that gap: the timestamp tracks activity, which is
   * what every reader of it already assumed.
   */
  touch(runId: string): Promise<void>;
  /** Delete this run's own directory. The store owns its layout; callers do not. */
  remove(runId: string): Promise<void>;
};

async function readJson<T>(file: string): Promise<T | null> {
  try {
    const raw = await readFile(file, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Atomic replace so concurrent readers never see a truncated run.json. */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await rename(tmp, file);
}

export function createJsonRunStore(dataDir: string): RunStore {
  const root = path.resolve(dataDir);
  const memory = new Map<string, CrawlRunMeta>();
  const locks = new Map<string, Promise<void>>();

  const runPath = (runId: string) => path.join(root, 'runs', runId, 'run.json');

  async function withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(runId) ?? Promise.resolve();
    let result!: T;
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        result = await fn();
      });
    locks.set(
      runId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    await next;
    return result;
  }

  async function loadRun(runId: string): Promise<CrawlRunMeta> {
    const cached = memory.get(runId);
    if (cached) return cached;
    const run = await readJson<CrawlRunMeta>(runPath(runId));
    if (!run) throw new Error(`Run not found: ${runId}`);
    memory.set(runId, run);
    return run;
  }

  async function saveRun(run: CrawlRunMeta): Promise<void> {
    memory.set(run.runId, run);
    await writeJsonAtomic(runPath(run.runId), run);
  }

  return {
    async createRun({ runId, crawlType, seeds }) {
      return withRunLock(runId, async () => {
        const run: CrawlRunMeta = {
          runId,
          storageContractVersion: 2,
          crawlType,
          status: 'pending',
          seeds,
          createdAtUtc: new Date().toISOString(),
          pagesSaved: 0,
          pagesWithoutContent: 0,
          linksSaved: 0,
        };
        await saveRun(run);
        return run;
      });
    },

    async markRunning(runId) {
      await withRunLock(runId, async () => {
        const run = await loadRun(runId);
        run.status = 'running';
        run.startedAtUtc = run.startedAtUtc ?? new Date().toISOString();
        delete run.completedAtUtc;
        delete run.errorSummary;
        await saveRun(run);
      });
    },

    async markComplete(runId, contentReadyAt) {
      await withRunLock(runId, async () => {
        const run = await loadRun(runId);
        run.status = 'complete';
        run.completedAtUtc = new Date().toISOString();
        if (contentReadyAt) {
          run.contentReadyAt = contentReadyAt;
        } else {
          delete run.contentReadyAt;
        }
        await saveRun(run);
      });
    },

    async markFailed(runId, errorSummary) {
      await withRunLock(runId, async () => {
        const run = await loadRun(runId);
        run.status = 'failed';
        run.errorSummary = errorSummary;
        run.completedAtUtc = new Date().toISOString();
        await saveRun(run);
      });
    },

    async recordRejectStats(runId, stats) {
      await withRunLock(runId, async () => {
        const run = await loadRun(runId);
        if (stats.pagesRejectedLocale !== undefined) {
          run.pagesRejectedLocale = stats.pagesRejectedLocale;
        }
        if (stats.pagesRejectedRequiresJavascript !== undefined) {
          run.pagesRejectedRequiresJavascript = stats.pagesRejectedRequiresJavascript;
        }
        if (stats.pagesRejectedChallenge !== undefined) {
          run.pagesRejectedChallenge = stats.pagesRejectedChallenge;
        }
        if (stats.pagesRejectedExtractEmpty !== undefined) {
          run.pagesRejectedExtractEmpty = stats.pagesRejectedExtractEmpty;
        }
        if (stats.duplicatePagesSkipped !== undefined) {
          run.duplicatePagesSkipped = stats.duplicatePagesSkipped;
        }
        if (stats.pagesRejectedRobots !== undefined) {
          run.pagesRejectedRobots = stats.pagesRejectedRobots;
        }
        if (stats.pagesRejectedRequestFailed !== undefined) {
          run.pagesRejectedRequestFailed = stats.pagesRejectedRequestFailed;
        }
        const copyKeys = [
          'dedupLedgerBackfilled',
          'enqueueAttempts',
          'enqueueSuppressedLocal',
          'enqueueSuppressedQueue',
          'httpRequests',
          'browserRenders',
          'extractionInvocations',
          'skippedUrl',
          'skippedHtml',
          'skippedCanonicalAlias',
          'skippedContent',
          'skippedNearDuplicate',
          'skipCauseAccepted',
          'skipCauseInFlight',
          'aliasesLearned',
        ] as const;
        for (const k of copyKeys) {
          if (stats[k] !== undefined) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (run as any)[k] = stats[k];
          }
        }
        if (stats.rejectSamples) run.rejectSamples = stats.rejectSamples;
        if (stats.discovery) run.discovery = stats.discovery;
        await saveRun(run);
      });
    },

    async recordAcceptedPage(runId, hasContent) {
      await withRunLock(runId, async () => {
        const run = await loadRun(runId);
        run.pagesSaved += 1;
        run.pagesWithoutContent =
          (run.pagesWithoutContent ?? 0) + (hasContent ? 0 : 1);
        await saveRun(run);
      });
    },

    async recordAcceptedLinks(runId, count) {
      if (count <= 0) return;
      await withRunLock(runId, async () => {
        const run = await loadRun(runId);
        run.linksSaved += count;
        await saveRun(run);
      });
    },


    async getRun(runId) {
      // Multiple store instances are expected (API status reads vs. crawl
      // workers). Always refresh from disk so a server does not keep returning
      // the state cached by an earlier listRuns() call.
      const run = await readJson<CrawlRunMeta>(runPath(runId));
      if (run) memory.set(runId, run);
      return run ? { ...run } : null;
    },

    async remove(runId) {
      memory.delete(runId);
      await rm(path.join(root, 'runs', runId), { recursive: true, force: true });
    },

    async touch(runId) {
      try {
        const now = new Date();
        await utimes(runPath(runId), now, now);
      } catch {
        // No record to touch. Nothing to report: the caller is recording a
        // reject, not asserting the run exists.
      }
    },

    async lastWriteAt(runId) {
      try {
        return (await stat(runPath(runId))).mtime;
      } catch {
        return null;
      }
    },

    async listRuns() {
      const runsDir = path.join(root, 'runs');
      let dirs: string[] = [];
      try {
        dirs = await readdir(runsDir);
      } catch {
        return [];
      }
      const out: CrawlRunMeta[] = [];
      for (const id of dirs) {
        const run = await readJson<CrawlRunMeta>(runPath(id));
        if (run) {
          memory.set(run.runId, run);
          out.push({ ...run });
        }
      }
      out.sort((a, b) => (b.createdAtUtc || '').localeCompare(a.createdAtUtc || ''));
      return out;
    },
  };
}
