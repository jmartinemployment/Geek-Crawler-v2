/**
 * Post-mortem archive for purged runs.
 *
 * A failed or cancelled run is destroyed — pages, links, vectors, and local scratch all go. What
 * survives is this: the record of why it ended that way. The analysis used to live on the GeekAPI
 * run row, which meant deleting the run deleted its own explanation; writing it here first is what
 * makes the purge safe to perform.
 *
 * Diagnostics only. Nothing reads this to decide what to crawl, resume, or dedup, so it is not a
 * second source of crawl authority and does not breach the no-mirror law.
 */

import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RejectSample } from '../crawl/reject.js';
import type { CrawlReport } from './geek-api-client.js';

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
  purgedAtUtc: string;
  pagesSaved: number;
  linksSaved: number;
  report: CrawlReport;
  rejectSamples: Record<string, RejectSample[]>;
  dedup: Record<string, number | boolean>;
  purge: PurgeOutcome;
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
 * Every record, newest purge first.
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

  records.sort((a, b) => (b.purgedAtUtc ?? '').localeCompare(a.purgedAtUtc ?? ''));
  return records;
}
