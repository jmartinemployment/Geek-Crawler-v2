/**
 * Post-mortem archive for runs that ended badly.
 *
 * A purged run is destroyed — pages, links, vectors, and local scratch all go. What survives is
 * this: the record of why it ended that way. The analysis used to live on the GeekAPI run row,
 * which meant deleting the run deleted its own explanation; writing it here first is what makes
 * the purge safe to perform.
 *
 * From 2026-09-30 to 2026-10-05 a run that failed because GeekAPI could not be reached was kept
 * instead of purged, on the premise that it could be re-posted. It could not: no command exists, and
 * nothing ingests from the extract cache, which is diagnostics. Such a run is archived with `purgedAtUtc` and `purge`
 * both null, because a kept run with no record is invisible, and being invisible to the operator is
 * how 603 pages sat unnoticed. The two null fields mark a run that was never purged and is waiting
 * on an operator to delete or re-crawl it. Since fabb42f every failed run is purged.
 *
 * Diagnostics only. Nothing reads this to decide what to crawl, resume, or dedup, so it is not a
 * second source of crawl authority and does not breach the no-mirror law.
 */

import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RejectSample } from '../crawl/reject.js';
import type { CrawlReport } from './geek-api-client.js';
import type { DiscoveryReport } from '../crawl/discovery-ledger.js';

export type PurgeOutcome = {
  vectorsPurged: boolean;
  crawlDataDeleted: boolean;
  localRemoved: string[];
  /** Populated only when a step failed; the record is written either way. */
  errors?: string[];
};

export type FailureRecord = {
  runId: string;
  seed: string;
  crawlType: string;
  status: 'failed' | 'cancelled';
  errorSummary: string | null;
  createdAtUtc: string;
  /** Null when the run was kept rather than purged — its crawl data is still on disk. */
  purgedAtUtc: string | null;
  pagesSaved: number;
  linksSaved: number;
  report: CrawlReport;
  rejectSamples: Record<string, RejectSample[]>;
  dedup: Record<string, number | boolean>;
  /** What became of every URL the crawl discovered. Absent on records archived before 2026-10-04. */
  discovery?: DiscoveryReport;
  /** Null when nothing was purged, so an empty outcome is never read as a completed purge. */
  purge: PurgeOutcome | null;
};

function failuresDir(dataDir: string): string {
  return path.join(dataDir, 'failures');
}

function recordPath(dataDir: string, runId: string): string {
  return path.join(failuresDir(dataDir), `${runId}.json`);
}

/**
 * Write one record, atomically. Tmp-then-rename so a reader never sees a half-written post-mortem,
 * matching how runs.ts writes run.json.
 */
export async function archiveRun(dataDir: string, record: FailureRecord): Promise<string> {
  const dir = failuresDir(dataDir);
  await mkdir(dir, { recursive: true });
  const file = recordPath(dataDir, record.runId);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(record, null, 2), 'utf8');
  await rename(tmp, file);
  return file;
}

/** One record, or null when the run was never archived. */
export async function readFailure(
  dataDir: string,
  runId: string,
): Promise<FailureRecord | null> {
  try {
    const text = await readFile(recordPath(dataDir, runId), 'utf8');
    return JSON.parse(text) as FailureRecord;
  } catch {
    return null;
  }
}

/**
 * Every record, newest first.
 *
 * A file that will not parse is skipped rather than thrown: one corrupt post-mortem must not take
 * the whole report down, and there is no second copy to fall back to.
 */
export async function listFailures(dataDir: string): Promise<FailureRecord[]> {
  let names: string[];
  try {
    names = await readdir(failuresDir(dataDir));
  } catch {
    return [];
  }

  const records: FailureRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const text = await readFile(path.join(failuresDir(dataDir), name), 'utf8');
      records.push(JSON.parse(text) as FailureRecord);
    } catch {
      continue;
    }
  }

  // On createdAtUtc, not purgedAtUtc: a kept run has no purge time, and sorting on a null would
  // bury exactly the records that still have data to recover.
  records.sort((a, b) => (b.createdAtUtc ?? '').localeCompare(a.createdAtUtc ?? ''));
  return records;
}
