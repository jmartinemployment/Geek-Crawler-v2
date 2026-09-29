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
 * operator UI shows them as in progress, resume-all would re-attach every one
 * of them, and a frozen page count reads as live progress - a netsuite run
 * dead for two hours forty minutes was reported as "currently running, 490
 * pages" on the strength of its record.
 *
 * Marking failed is local only. RunStore.markFailed writes status, summary and
 * a completion timestamp to run.json and nothing else: no GeekAPI call, no
 * purge, no archive. A run that actually succeeded server side keeps its rows
 * there, and this only corrects the local claim. Deleting instead would be
 * worse - the post-mortem is the whole value of keeping the record.
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
  /** Records corrected from an active status to failed. */
  reconciled: Array<{ runId: string; previousStatus: ActiveStatus; staleForMs: number }>;
  /** Active in this process, so genuinely running and left alone. */
  skippedLive: string[];
  /** Written too recently to call dead - another process may own it. */
  skippedRecent: string[];
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
  staleAfterMs?: number;
  now?: number;
}): Promise<OrphanReconcileResult> {
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_ORPHAN_STALE_MS;
  const now = input.now ?? Date.now();

  const result: OrphanReconcileResult = {
    reconciled: [],
    skippedLive: [],
    skippedRecent: [],
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

    const minutes = Math.round(staleForMs / 60000);
    const summary =
      `orphaned: status ${run.status} with no writer at API startup ` +
      `(last write ${lastWrite.toISOString()}, ${minutes} min earlier)`;

    try {
      await input.meta.markFailed(run.runId, summary);
      result.reconciled.push({ runId: run.runId, previousStatus: run.status, staleForMs });
    } catch (error) {
      // One unwritable record must not stop the rest being corrected, and must
      // not be hidden either - it comes back in problems and the caller logs it.
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
      `  orphan reconciled: ${entry.runId} was ${entry.previousStatus}, unwritten ${minutes} min`,
    );
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
