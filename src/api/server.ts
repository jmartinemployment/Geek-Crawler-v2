import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { prepareCrawl, startCrawl } from '../crawl/orchestrator.js';
import { CRAWL_TYPE_VALUES } from '../crawl/types.js';
import { createGeekApiClient, requireGeekApiEnv } from '../storage/geek-api-client.js';
import { requestCancel } from '../crawl/cancel-registry.js';
import { createJsonRunStore } from '../storage/runs.js';
import {
  DEFAULT_ORPHAN_STALE_MS,
  describeReconcileResult,
  describeSupersededResult,
  reconcileOrphanedRuns,
  reconcileSupersededRuns,
} from '../storage/reconcile-orphans.js';
import { computeSeedKey, normalizeSeeds } from '../storage/seed-key.js';
import { listFailures, readFailure } from '../storage/failure-archive.js';
import { summarizeFailures } from '../storage/failures-report.js';

type Json = Record<string, unknown>;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(res: ServerResponse, status: number, body: Json | unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Recursive byte total, so a sweep can report what it actually reclaimed. */
async function directorySize(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(full);
    } else {
      const info = await stat(full);
      total += info.size;
    }
  }
  return total;
}

export function createCrawlApiServer(options?: { dataDir?: string; port?: number }) {
  requireGeekApiEnv();
  const dataDir = path.resolve(options?.dataDir ?? process.env.DATA_DIR ?? './data');
  const port = options?.port ?? Number(process.env.PORT ?? 8787);
  // Minutes a run record may go unwritten before startup treats it as abandoned.
  // Overridable because write cadence depends on host politeness and page size.
  const orphanStaleMs = (() => {
    const minutes = Number(process.env.ORPHAN_STALE_MINUTES);
    return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : DEFAULT_ORPHAN_STALE_MS;
  })();
  const meta = createJsonRunStore(dataDir);
  const inFlight = new Map<string, Promise<unknown>>();
  /**
   * seedKey -> runId holding it. GeekAPI keys a run by its seed
   * (`GeekCrawlerSeedNormalizer.ComputeSeedKey`, mirrored in seed-key.ts), and
   * registering a second run for a key silently drops the first: the older run
   * starts taking 404 on pages/batch mid-crawl and fails closed. Refusing the
   * submission is the only point at which that is still preventable.
   */
  const inFlightSeedKeys = new Map<string, string>();

  /**
   * Delete a run everywhere: GeekAPI's pages, links and vectors first, then the run directory and
   * request queue here. The one implementation, used by DELETE /crawls/:runId and by the startup
   * orphan pass, so the two cannot disagree about what deleting a run means.
   *
   * Authority first. GeekAPI owns the pages, links and vectors; if that purge fails the local
   * record stays and the run is still accounted for. Clearing scratch first would leave rows alive
   * with nothing on this machine pointing at them. Rejects when GeekAPI's purge fails.
   */
  async function deleteRunEverywhere(runId: string) {
    const result = await createGeekApiClient().deleteRun(runId);

    // The rest of the run's footprint on this machine. `GET /crawls/:runId` reads local meta,
    // so a run whose rows are gone keeps rendering with its old page count until these go.
    const localPaths = [path.join(dataDir, 'runs', runId), path.join(dataDir, '.crawlee', runId)];
    const localRemoved: string[] = [];
    const localFailed: Array<{ path: string; error: string }> = [];
    for (const target of localPaths) {
      try {
        await rm(target, { recursive: true, force: true });
        localRemoved.push(target);
      } catch (err) {
        localFailed.push({
          path: target,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { ...result, localRemoved, localFailed };
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const { pathname } = url;

      if (req.method === 'GET' && (pathname === '/health' || pathname === '/')) {
        return send(res, 200, {
          ok: true,
          service: 'geek-crawler-v2',
          phase: 4,
          egressMode: process.env.EGRESS_MODE ?? 'off',
          inFlight: inFlight.size,
        });
      }

      if (req.method === 'GET' && pathname === '/crawls') {
        const runs = await meta.listRuns();
        return send(res, 200, { ok: true, runs });
      }

      if (req.method === 'POST' && pathname === '/crawls') {
        const raw = await readBody(req);
        const body = raw ? (JSON.parse(raw) as Json) : {};
        const seeds = Array.isArray(body.seeds)
          ? body.seeds.map(String)
          : body.seed
            ? [String(body.seed)]
            : [];
        if (seeds.length === 0) {
          return send(res, 400, { error: 'seed or seeds[] required' });
        }
        if (seeds.length !== 1) {
          return send(res, 400, {
            error: 'exactly one seed URL per run (1 runId = 1 URL)',
          });
        }
        const crawlType = String(body.crawlType ?? 'partner');
        const maxRaw = body.maxRequestsPerCrawl != null ? Number(body.maxRequestsPerCrawl) : NaN;
        const maxRequestsPerCrawl =
          Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : undefined;
        const maxConcurrency = body.maxConcurrency
          ? Number(body.maxConcurrency)
          : undefined;
        const wait = body.wait === true || body.wait === '1';

        const seedKey = computeSeedKey(normalizeSeeds(seeds));
        const holder = inFlightSeedKeys.get(seedKey);
        if (holder) {
          return send(res, 409, {
            error:
              'A crawl of this seed is already running — a second run would supersede it on GeekAPI and destroy the first',
            code: 'SEED_IN_FLIGHT',
            runId: holder,
          });
        }
        // Claimed before the first await, so two simultaneous submissions of one
        // seed cannot both pass the check above.
        inFlightSeedKeys.set(seedKey, 'pending');

        if (wait) {
          try {
            const result = await startCrawl({
              seeds,
              crawlType,
              dataDir,
              maxRequestsPerCrawl,
              maxConcurrency,
            });
            return send(res, 200, {
              ok: true,
              runId: result.runId,
              pagesSaved: result.pagesSaved,
              linksSaved: result.linksSaved,
              pagesRejectedLocale: result.pagesRejectedLocale,
              pagesRejectedChallenge: result.pagesRejectedChallenge,
              pagesRejectedExtractEmpty: result.pagesRejectedExtractEmpty,
              dataDir: result.dataDir,
              persistMode: result.persistMode,
            });
          } finally {
            // The wait path owns the claim for exactly as long as it blocks.
            inFlightSeedKeys.delete(seedKey);
          }
        }

        let prepared: Awaited<ReturnType<typeof prepareCrawl>>;
        try {
          prepared = await prepareCrawl({
            seeds,
            crawlType,
            dataDir,
            maxRequestsPerCrawl,
            maxConcurrency,
          });
        } catch (err) {
          // Nothing was started, so the seed must not stay claimed.
          inFlightSeedKeys.delete(seedKey);
          throw err;
        }
        inFlightSeedKeys.set(seedKey, prepared.runId);

        const work = prepared.run().catch((err) => {
          console.error(`Crawl ${prepared.runId} failed:`, err);
          return err;
        });
        inFlight.set(prepared.runId, work);
        void work.finally(() => {
          inFlight.delete(prepared.runId);
          inFlightSeedKeys.delete(seedKey);
        });

        return send(res, 202, {
          ok: true,
          runId: prepared.runId,
          persistMode: prepared.persistMode,
          dataDir: prepared.dataDir,
          status: 'running',
        });
      }

      const runMatch = pathname.match(/^\/crawls\/([^/]+)$/);
      if (req.method === 'GET' && runMatch) {
        const runId = decodeURIComponent(runMatch[1]!);
        const run = await meta.getRun(runId);
        if (!run) return send(res, 404, { error: 'run not found' });
        return send(res, 200, run as unknown as Json);
      }

      if (
        req.method === 'POST' &&
        (pathname === '/crawls/resume-by-url' ||
          pathname === '/crawls/resume-running' ||
          /^\/crawls\/[^/]+\/resume$/.test(pathname))
      ) {
        return send(res, 409, {
          error:
            'Resume is forbidden under fail-closed policy — start a new crawl run instead',
          code: 'RESUME_FORBIDDEN',
        });
      }

      const cancelMatch = pathname.match(/^\/crawls\/([^/]+)\/cancel$/);
      if (req.method === 'POST' && cancelMatch) {
        const runId = decodeURIComponent(cancelMatch[1]!);
        const live = inFlight.has(runId);

        // A live run stops itself and writes its own terminal status, keeping
        // one writer per run. An orphan has no writer, so the API is it.
        if (live) {
          requestCancel(runId);
          return send(res, 202, { ok: true, runId, cancelling: true, orphan: false });
        }

        const snapshot = await createGeekApiClient().patchRun(runId, {
          status: 'cancelled',
          errorSummary: 'Cancelled by operator (no live crawl process)',
          completedAtUtc: new Date().toISOString(),
          clearContentReadyAt: true,
        });
        return send(res, 200, {
          ok: true,
          runId,
          cancelling: false,
          orphan: true,
          status: snapshot.status,
        });
      }

      const deleteMatch = pathname.match(/^\/crawls\/([^/]+)$/);
      if (req.method === 'DELETE' && deleteMatch) {
        const runId = decodeURIComponent(deleteMatch[1]!);
        if (inFlight.has(runId)) {
          return send(res, 409, {
            error: 'Run is in flight — cancel it before deleting',
            code: 'RUN_IN_FLIGHT',
            runId,
          });
        }
        const { localFailed, ...result } = await deleteRunEverywhere(runId);
        return send(res, 200, {
          ok: true,
          runId,
          ...result,
          ...(localFailed.length > 0 ? { localFailed } : {}),
        });
      }

      const pagesMatch = pathname.match(/^\/crawls\/([^/]+)\/pages$/);
      if (req.method === 'GET' && pagesMatch) {
        const runId = decodeURIComponent(pagesMatch[1]!);
        // Page rows are not kept on this machine. They go to GeekAPI, which is
        // the store, and the local pages.jsonl this used to read was written by
        // nothing: insertPage had no caller in any mode, so createRun made the
        // file empty and it stayed empty for the life of the run.
        //
        // Reading it returned 200 with an empty array, which reads exactly like
        // a run that crawled nothing. Saying so outright is the difference
        // between an answer and a silence that looks like one.
        return send(res, 410, {
          error: 'Page rows are not stored locally — read them from GeekAPI',
          code: 'PAGES_NOT_LOCAL',
          runId,
        });
      }

      // Post-mortems. A purged run is gone and this is what is left of it; a kept run still has its
      // pages on disk, and `purgedAtUtc: null` is how the two are told apart.
      if (req.method === 'GET' && pathname === '/failures') {
        const failures = await listFailures(dataDir);
        return send(res, 200, { ok: true, failures });
      }

      // The counts, because the raw list is what nobody read. 15 post-mortems and ~4,000 discarded
      // pages sat here unnoticed until someone happened to look on 2026-09-30.
      if (req.method === 'GET' && pathname === '/failures/summary') {
        const summary = await summarizeFailures(dataDir);
        const { records: _records, ...counts } = summary;
        return send(res, 200, { ok: true, ...counts });
      }

      const failureMatch = pathname.match(/^\/failures\/([^/]+)$/);
      if (req.method === 'GET' && failureMatch) {
        const runId = decodeURIComponent(failureMatch[1]!);
        const failure = await readFailure(dataDir, runId);
        if (!failure) return send(res, 404, { error: 'no post-mortem for that run' });
        return send(res, 200, failure);
      }

      // Request-queue directories whose run is already gone. Pure engine scratch — no run owns
      // them, nothing reads them, and they are where the reclaimable disk actually is.
      if (req.method === 'POST' && pathname === '/maintenance/sweep-scratch') {
        const scratchDir = path.join(dataDir, '.crawlee');
        let scratchIds: string[];
        try {
          scratchIds = await readdir(scratchDir);
        } catch {
          return send(res, 200, { ok: true, swept: [], bytesFreed: 0 });
        }

        const swept: string[] = [];
        const failures: Array<{ runId: string; error: string }> = [];
        let bytesFreed = 0;
        for (const id of scratchIds) {
          const runDir = path.join(dataDir, 'runs', id);
          try {
            await stat(runDir);
            continue; // the run still exists — not orphaned
          } catch {
            // no run directory, so this queue belongs to nothing
          }
          const target = path.join(scratchDir, id);
          try {
            bytesFreed += await directorySize(target);
            await rm(target, { recursive: true, force: true });
            swept.push(id);
          } catch (err) {
            failures.push({
              runId: id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        return send(res, 200, {
          ok: true,
          swept,
          bytesFreed,
          ...(failures.length > 0 ? { failures } : {}),
        });
      }

      return send(res, 404, { error: 'not found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return send(res, err instanceof SyntaxError ? 400 : 500, { error: message });
    }
  });

  return {
    async listen() {
      // Before the socket opens, so no request can read a run record that says
      // running when the process that was writing it is gone. At startup this
      // process owns nothing yet, so inFlight is empty by construction and the
      // staleness window is what separates a dead record from one a concurrent
      // CLI crawl is still writing.
      // An orphan is an interrupted run, and an interrupted run is deleted (Jeff, 2026-10-05).
      // GeekAPI is asked first: a run it shows complete is finished, whatever run.json says.
      const orphanClient = createGeekApiClient();
      const reconciled = await reconcileOrphanedRuns({
        meta,
        isLive: (runId) => inFlight.has(runId),
        presence: (runId) => orphanClient.runPresence(runId),
        purge: async (runId) => {
          const { localFailed } = await deleteRunEverywhere(runId);
          if (localFailed.length > 0) {
            throw new Error(
              `GeekAPI copy deleted, local files remain: ${localFailed.map((f) => f.path).join(', ')}`,
            );
          }
        },
        staleAfterMs: orphanStaleMs,
      });
      if (
        reconciled.reconciled.length > 0 ||
        reconciled.problems.length > 0 ||
        reconciled.skippedRecent.length > 0 ||
        reconciled.skippedComplete.length > 0 ||
        reconciled.unknown.length > 0
      ) {
        if (reconciled.reconciled.length > 0) {
          console.log(
            `startup: ${reconciled.reconciled.length} orphaned run(s) deleted`,
          );
        } else {
          // Saying "0 orphaned run(s) deleted" above a list of real
          // problems reads as "nothing happened" and buries the thing that
          // needed attention.
          console.log('startup: orphan check found nothing to correct');
        }
        for (const line of describeReconcileResult(reconciled)) console.log(line);
      }

      // After the local pass, and after the socket is up, because this one asks
      // GeekAPI about every completed run and must not hold startup on the
      // network. Nothing is deleted without an explicit 404, so an unreachable
      // GeekAPI removes nothing.
      void (async () => {
        const client = createGeekApiClient();
        const superseded = await reconcileSupersededRuns({
          meta,
          isLive: (runId) => inFlight.has(runId),
          presence: (runId) => client.runPresence(runId),
          remove: async (runId) => {
            await meta.remove(runId);
            await rm(path.join(dataDir, '.crawlee', runId), {
              recursive: true,
              force: true,
            });
          },
        });
        if (
          superseded.removed.length > 0 ||
          superseded.unknown.length > 0 ||
          superseded.problems.length > 0
        ) {
          console.log(
            `startup: ${superseded.removed.length} superseded run record(s) removed, ` +
              `${superseded.kept.length} still held by GeekAPI`,
          );
          for (const line of describeSupersededResult(superseded)) console.log(line);
        }
      })();

      return new Promise<void>((resolve) => {
        // Loopback only. This surface has no authentication, so a non-loopback bind puts
        // POST /crawls and DELETE /crawls/:runId on the network. It is scheduled for deletion
        // outright — plans/move-crawl-reads-to-geekapi.md.
        server.listen(port, '127.0.0.1', () => {
          console.log(`geek-crawler-v2 API on http://127.0.0.1:${port}`);
          console.log(`  GET  /health`);
          console.log(`  GET  /crawls`);
          console.log(`  POST /crawls  { seed|seeds[1], crawlType?, maxRequestsPerCrawl?, maxConcurrency? } → 202`
          );
          console.log(
            `        crawlType: ${CRAWL_TYPE_VALUES.join(' | ')}`);
          console.log(`  POST /crawls/resume-*  → 409 RESUME_FORBIDDEN (start a new run)`);
          console.log(`  GET  /crawls/:runId`);
          console.log(`  GET  /crawls/:runId/pages  → 410 PAGES_NOT_LOCAL (read from GeekAPI)`);
          console.log(`  POST /crawls/:runId/cancel`);
          console.log(`  GET  /failures            post-mortems, newest first`);
          console.log(`  GET  /failures/summary    counts by cause, and what can still be re-posted`);
          resolve();
        });
      });
    },
    server,
    dataDir,
    inFlight,
  };
}
