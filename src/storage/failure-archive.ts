/**
 * Post-mortem archive for runs that ended badly.
 *
 * A purged run is destroyed — pages, links, vectors, and local scratch all go. What survives is
 * this: the record of why it ended that way. The analysis used to live on the GeekAPI run row,
 * which meant deleting the run deleted its own explanation; writing it here first is what makes
 * the purge safe to perform.
 *
 * Every failed or cancelled run is purged, and its record carries the purge time and outcome.
 * Records written from 2026-09-30 to 2026-10-05 may carry `purgedAtUtc` and `purge` both null:
 * in that window a run that failed on an unreachable GeekAPI was archived without a purge. That
 * path is removed (Jeff, 2026-10-06).
 *
 * Diagnostics only. Nothing reads this to decide what to crawl, resume, or dedup, so it is not a
 * second source of crawl authority and does not breach the no-mirror law.
 */

import { mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RejectSample } from '../crawl/reject.js';
import type { CrawlReport } from './geek-api-client.js';
import type { DiscoveryReport } from '../crawl/discovery-ledger.js';
import { isMissing, logUnreadable, readJsonRecord, type RecordRead } from './read-record.js';

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
  /** Null only on records from 2026-09-30 to 2026-10-05, archived without a purge. */
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

/** One record: missing when the run was never archived, unreadable with its reason, or the record. */
export async function readFailure(
  dataDir: string,
  runId: string,
): Promise<RecordRead<FailureRecord>> {
  return readJsonRecord<FailureRecord>(recordPath(dataDir, runId));
}

/**
 * Every record, newest first.
 *
 * A file that will not parse is left out rather than thrown, so one corrupt post-mortem does not
 * take the whole report down. It is logged with its path and reason by readJsonRecord, so it is
 * never left out silently.
 */
export async function listFailures(dataDir: string): Promise<FailureRecord[] | null> {
  let names: string[];
  try {
    names = await readdir(failuresDir(dataDir));
  } catch (err) {
    // No failures directory means no post-mortems. Any other error is not an empty archive: it
    // is logged and answered null.
    if (isMissing(err)) return [];
    logUnreadable(failuresDir(dataDir), err instanceof Error ? err.message : String(err));
    return null;
  }

  const records: FailureRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const read = await readJsonRecord<FailureRecord>(path.join(failuresDir(dataDir), name));
    if (read.kind === 'ok') records.push(read.value);
  }

  // On createdAtUtc, not purgedAtUtc: a record archived without a purge has no purge time, and
  // sorting on a null would misplace it.
  records.sort((a, b) => (b.createdAtUtc ?? '').localeCompare(a.createdAtUtc ?? ''));
  return records;
}
