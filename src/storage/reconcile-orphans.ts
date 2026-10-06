import type { RunPresence } from './geek-api-client.js';
import type { RunStore } from './runs.js';

/**
 * Reconcile runs that claim to be active but have nobody writing to them.
 *
 * A run is marked running by the process that crawls it, and that status is
 * only ever cleared by the same process finishing, failing or being cancelled.
 * When the process dies instead - a killed terminal, a crashed serve, a
 * machine restart - the record is left saying running forever. Nothing clears
 * it, because the only thing that could is gone.
 *
 * Observed on 2026-09-28: twenty-one such records. Ten stopped writing within
 * the same second when one serve process died, eleven more dated from four
 * days earlier. They are not harmless. GET /crawls lists them as live, the
 * operator UI shows them as in progress, and a frozen page count reads as live
 * progress - a netsuite run dead for two hours forty minutes was reported as
 * "currently running, 490 pages" on the strength of its record.
 *
 * An orphan is an interrupted run, and an interrupted run is deleted (Jeff,
 * 2026-10-05): its pages, links and vectors on GeekAPI, then its run directory
 * and request queue here, through the same purge the DELETE route performs.
 * Until then this only marked the local record failed, which left the GeekAPI
 * copy behind as a run nobody would ever finish.
 *
 * A purge that fails is reported in problems and leaves the record as it was,
 * so the next startup tries again rather than hiding the run under a status.
 *
 * GeekAPI is asked before anything is deleted, because the local record is not
 * the authority on whether a run finished. ramp.com 4563f7ec was completed by
 * hand on 2026-10-06: published in GeekAPI as complete while its run.json still
 * said running, so a stale running record alone would have purged a finished
 * corpus. A run GeekAPI shows complete is left alone. So is a run GeekAPI gave
 * no usable answer about, because deletion requires an answer.
 */

/**
 * How long a record may go unwritten before it is treated as abandoned.
 *
 * A live crawl rewrites run.json on every accepted page, so an active run is
 * normally seconds old. The measured orphans were 176 minutes and 4.3 days
 * stale. Fifteen minutes sits far outside normal write cadence and far inside
 * the gap that identifies a dead run, which leaves room for a slow crawl on a
 * politely rate-limited host without leaving room to mistake one for dead.
 */
export const DEFAULT_ORPHAN_STALE_MS = 15 * 60 * 1000;

/** Statuses that assert something is still working on the run. */
const ACTIVE_STATUSES = ['pending', 'running'] as const;
type ActiveStatus = (typeof ACTIVE_STATUSES)[number];

export type OrphanReconcileResult = {
  /** Orphaned runs deleted, on GeekAPI and locally. */
  reconciled: Array<{
    runId: string;
    previousStatus: ActiveStatus;
    staleForMs: number;
    summary: string;
  }>;
  /** Active in this process, so genuinely running and left alone. */
  skippedLive: string[];
  /** Written too recently to call dead - another process may own it. */
  skippedRecent: string[];
  /** GeekAPI shows the run complete, so it is finished, not interrupted. */
  skippedComplete: string[];
  /** GeekAPI gave no usable answer. Left alone, because deletion requires one. */
  unknown: Array<{ runId: string; reason: string }>;
  /** Could not be read or could not be written. Reported, never swallowed. */
  problems: Array<{ runId: string; reason: string }>;
};

function isActiveStatus(status: string): status is ActiveStatus {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}

export async function reconcileOrphanedRuns(input: {
  meta: RunStore;
  /** True when this process is the one crawling that run. */
  isLive: (runId: string) => boolean;
  /** What GeekAPI holds for the run, asked before any deletion. */
  presence: (runId: string) => Promise<RunPresence>;
  /** Deletes the run on GeekAPI and locally. Rejects when the deletion did not happen. */
  purge: (runId: string) => Promise<void>;
  staleAfterMs?: number;
  now?: number;
}): Promise<OrphanReconcileResult> {
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_ORPHAN_STALE_MS;
  const now = input.now ?? Date.now();

  const result: OrphanReconcileResult = {
    reconciled: [],
    skippedLive: [],
    skippedRecent: [],
    skippedComplete: [],
    unknown: [],
    problems: [],
  };

  let runs: Awaited<ReturnType<RunStore['listRuns']>>;
  try {
    runs = await input.meta.listRuns();
  } catch (error) {
    result.problems.push({
      runId: '(listing)',
      reason: error instanceof Error ? error.message : String(error),
    });
    return result;
  }

  for (const run of runs) {
    if (!isActiveStatus(run.status)) continue;

    if (input.isLive(run.runId)) {
      result.skippedLive.push(run.runId);
      continue;
    }

    const lastWrite = await input.meta.lastWriteAt(run.runId);
    if (!lastWrite) {
      // The listing found a record and the stat did not. Reported rather than
      // assumed dead: an unreadable record is not evidence of an absent writer.
      result.problems.push({ runId: run.runId, reason: 'no run.json timestamp' });
      continue;
    }

    const staleForMs = now - lastWrite.getTime();
    if (staleForMs < staleAfterMs) {
      result.skippedRecent.push(run.runId);
      continue;
    }

    let presence: RunPresence;
    try {
      presence = await input.presence(run.runId);
    } catch (error) {
      result.problems.push({
        runId: run.runId,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (presence.kind === 'unknown') {
      result.unknown.push({ runId: run.runId, reason: presence.reason });
      continue;
    }
    if (presence.kind === 'present') {
      if (presence.status === null) {
        result.unknown.push({ runId: run.runId, reason: 'GeekAPI answered without a run status' });
        continue;
      }
      if (presence.status === 'complete') {
        result.skippedComplete.push(run.runId);
        continue;
      }
    }

    const minutes = Math.round(staleForMs / 60000);
    const summary =
      `orphaned: status ${run.status} with no writer at API startup ` +
      `(last write ${lastWrite.toISOString()}, ${minutes} min earlier)`;

    try {
      await input.purge(run.runId);
      result.reconciled.push({
        runId: run.runId,
        previousStatus: run.status,
        staleForMs,
        summary,
      });
    } catch (error) {
      // One run that could not be deleted must not stop the rest, and must not
      // be hidden either - it comes back in problems and the caller logs it.
      result.problems.push({
        runId: run.runId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

/** One line per outcome, so a startup that changed state says what it changed. */
export function describeReconcileResult(result: OrphanReconcileResult): string[] {
  const lines: string[] = [];
  for (const entry of result.reconciled) {
    const minutes = Math.round(entry.staleForMs / 60000);
    lines.push(
      `  orphan deleted: ${entry.runId} was ${entry.previousStatus}, unwritten ${minutes} min`,
    );
  }
  for (const runId of result.skippedComplete) {
    lines.push(`  left alone, complete on GeekAPI: ${runId} (local record says running)`);
  }
  for (const entry of result.unknown) {
    lines.push(`  left alone, no answer from GeekAPI: ${entry.runId} - ${entry.reason}`);
  }
  for (const entry of result.problems) {
    lines.push(`  orphan check problem: ${entry.runId} - ${entry.reason}`);
  }
  if (result.skippedRecent.length > 0) {
    lines.push(
      `  left alone, written recently: ${result.skippedRecent.length} run(s)`,
    );
  }
  return lines;
}

/**
 * Clear local records for completed runs GeekAPI no longer holds.
 *
 * GeekAPI keys a run by its seed, so every re-crawl replaces the previous run of
 * that site and the old id stops resolving. The local record survives, and
 * nothing removed it: the orphan pass above only looks at pending and running,
 * because a completed run is finished rather than abandoned.
 *
 * They accumulate one per re-crawl. On 2026-09-29 there were 42 of them -
 * lightyear.cloud four times, dext four, stampli three - 128 MB of page counts
 * for corpus that no longer exists anywhere, rendered by the seed report as
 * though they did.
 *
 * Safety is the whole design here, because the action is deletion. A run is
 * removed only on an explicit 404. A transport failure, a 5xx, an auth problem
 * - anything that is merely not an answer - leaves the record alone. If GeekAPI
 * is unreachable every lookup returns unknown, so nothing is removed at all,
 * which is the correct behaviour for "I cannot tell".
 */
export type SupersededReconcileResult = {
  removed: Array<{ runId: string; seeds: string[] }>;
  /** GeekAPI still holds these. */
  kept: string[];
  /** No usable answer. Left alone, and reported so the silence is visible. */
  unknown: Array<{ runId: string; reason: string }>;
  problems: Array<{ runId: string; reason: string }>;
};

export async function reconcileSupersededRuns(input: {
  meta: RunStore;
  presence: (runId: string) => Promise<RunPresence>;
  /** Clears everything the run owns on this machine, not just its record. */
  remove: (runId: string) => Promise<void>;
  isLive: (runId: string) => boolean;
}): Promise<SupersededReconcileResult> {
  const result: SupersededReconcileResult = {
    removed: [],
    kept: [],
    unknown: [],
    problems: [],
  };

  let runs: Awaited<ReturnType<RunStore['listRuns']>>;
  try {
    runs = await input.meta.listRuns();
  } catch (error) {
    result.problems.push({
      runId: '(listing)',
      reason: error instanceof Error ? error.message : String(error),
    });
    return result;
  }

  for (const run of runs) {
    // Only completed runs. A failed run's record is its post-mortem and is the
    // one thing worth keeping after the data is gone.
    if (run.status !== 'complete') continue;
    if (input.isLive(run.runId)) {
      result.kept.push(run.runId);
      continue;
    }

    let presence: RunPresence;
    try {
      presence = await input.presence(run.runId);
    } catch (error) {
      result.problems.push({
        runId: run.runId,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (presence.kind === 'present') {
      result.kept.push(run.runId);
      continue;
    }
    if (presence.kind === 'unknown') {
      result.unknown.push({ runId: run.runId, reason: presence.reason });
      continue;
    }

    try {
      await input.remove(run.runId);
      result.removed.push({ runId: run.runId, seeds: run.seeds ?? [] });
    } catch (error) {
      result.problems.push({
        runId: run.runId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

/** One line per outcome, so a startup that deleted data says what it deleted. */
export function describeSupersededResult(result: SupersededReconcileResult): string[] {
  const lines: string[] = [];
  for (const entry of result.removed) {
    lines.push(
      `  superseded, removed: ${entry.runId} ${entry.seeds.join(', ') || '(no seed)'}`,
    );
  }
  for (const entry of result.unknown) {
    lines.push(`  left alone, no answer from GeekAPI: ${entry.runId} - ${entry.reason}`);
  }
  for (const entry of result.problems) {
    lines.push(`  superseded check problem: ${entry.runId} - ${entry.reason}`);
  }
  return lines;
}
