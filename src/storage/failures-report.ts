/**
 * Render the failure archive as something an operator will actually read.
 *
 * The archive existed and nothing read it. Fifteen post-mortems accumulated in
 * `<DATA_DIR>/failures/` recording roughly 4,000 pages of finished crawl work discarded at the
 * ingest boundary, and the first anyone looked was 2026-09-30, prompted by a report rather than by
 * the system. A record nobody reads is the same as no record: the whole failure class was invisible
 * from Mongo too, because a purged run is deleted from GeekAPI and `Status=failed` returns zero
 * rows.
 *
 * Diagnostics only, in the same sense as the archive itself — nothing here decides what to crawl,
 * resume or dedup.
 */

import { listFailures, type FailureRecord } from './failure-archive.js';

export type FailureSummary = {
  total: number;
  /**
   * Runs archived without a purge. Nothing can re-post them: no command exists, and nothing
   * ingests from the extract cache, which is diagnostics. Since fabb42f (2026-10-05) every failed
   * run is purged, so these predate it.
   */
  kept: number;
  /** Runs that were purged: the pages are gone and only the record is left. */
  purged: number;
  pagesLost: number;
  pagesKept: number;
  /** One line per distinct cause, most pages first. */
  byCause: Array<{ cause: string; runs: number; pages: number }>;
  records: FailureRecord[];
};

/**
 * Collapse an error summary to the cause it shares with other runs.
 *
 * The message carries a run id, a URL and a response body, all of which differ per run, so grouping
 * on the raw string puts every failure in its own bucket and says nothing. These patterns are for
 * grouping a report only — nothing branches on them. The classification that decides whether a run
 * is purged is `PersistenceError.unreachable`, set by an allowlist in `geek-api-client.ts`, and it
 * must stay the only such decision.
 */
export function causeOf(record: FailureRecord): string {
  const message = record.errorSummary ?? '';
  if (message === '') return 'no reason recorded';

  // pages/links before runs: every ingest URL contains `/runs/<id>/`, so matching leftmost-first
  // labelled every pages/batch failure "on runs" and merged two unrelated causes into one line.
  const endpoint =
    /\/((?:pages|links)\/batch)\b/.exec(message)?.[1] ??
    (/\/runs\b/.test(message) ? 'runs' : undefined);
  const on = endpoint ? ` on ${endpoint}` : '';

  // Only the `→ NNN` form the client writes. A bare three-digit match finds digits inside a run
  // id and reports a status the response never carried.
  const status = /→ (\d{3})\b/.exec(message)?.[1];

  // 1,767 pages -- ramp 1,426 and zoneandco 341 -- were purged on this, and it is the one message
  // carrying no status at all, so it fell through to raw truncated text and grouped with nothing.
  if (/→ transport:/.test(message)) return `transport failure (no response)${on}`;

  if (/Application not found/i.test(message)) {
    return `platform proxy 404 (service not running)${on}`;
  }
  if (/no usable pages/i.test(message)) return 'GeekAPI: crawl complete with no usable pages';
  if (/no extracted content/i.test(message)) return 'GeekAPI: pages carry no extracted content';
  if (/exceeds atomic max/i.test(message)) return 'batch exceeded the atomic maximum';
  if (/Nothing extractable/i.test(message)) return 'early abort: nothing extractable';
  if (/robots/i.test(message)) return 'robots.txt disallowed the crawl';
  if (/Cancelled by operator/i.test(message)) return 'cancelled by operator';
  if (status) return `HTTP ${status}${on}`;
  return message.slice(0, 80);
}

export async function summarizeFailures(dataDir: string): Promise<FailureSummary> {
  const records = await listFailures(dataDir);

  const causes = new Map<string, { runs: number; pages: number }>();
  let kept = 0;
  let purged = 0;
  let pagesLost = 0;
  let pagesKept = 0;

  for (const record of records) {
    // purgedAtUtc null is the archive's own marker for a run that was kept. Reading `purge` for it
    // would be reading an outcome that never happened.
    if (record.purgedAtUtc === null) {
      kept += 1;
      pagesKept += record.pagesSaved;
    } else {
      purged += 1;
      pagesLost += record.pagesSaved;
    }

    const cause = causeOf(record);
    const entry = causes.get(cause) ?? { runs: 0, pages: 0 };
    entry.runs += 1;
    entry.pages += record.pagesSaved;
    causes.set(cause, entry);
  }

  const byCause = [...causes.entries()]
    .map(([cause, v]) => ({ cause, runs: v.runs, pages: v.pages }))
    .sort((a, b) => b.pages - a.pages || b.runs - a.runs || a.cause.localeCompare(b.cause));

  return {
    total: records.length,
    kept,
    purged,
    pagesLost,
    pagesKept,
    byCause,
    records,
  };
}

/** Fixed-width so the columns line up in a terminal without a table library. */
export function renderFailures(summary: FailureSummary, dataDir: string): string {
  if (summary.total === 0) return `No failure post-mortems in ${dataDir}/failures`;

  const lines: string[] = [];
  lines.push(`${summary.total} failure post-mortem(s) in ${dataDir}/failures`);
  lines.push(
    `  ${summary.purged} purged (${summary.pagesLost} page(s) gone), ` +
      `${summary.kept} kept (${summary.pagesKept} page(s) not purged)`,
  );

  lines.push('');
  lines.push('By cause:');
  const causeWidth = Math.max(...summary.byCause.map((c) => c.cause.length));
  for (const { cause, runs, pages } of summary.byCause) {
    lines.push(
      `  ${cause.padEnd(causeWidth)}  ${String(runs).padStart(3)} run(s)  ` +
        `${String(pages).padStart(5)} page(s)`,
    );
  }

  lines.push('');
  lines.push('Runs, newest first:');
  for (const record of summary.records) {
    const kept = record.purgedAtUtc === null;
    lines.push(
      `  ${record.createdAtUtc}  ${kept ? 'KEPT  ' : 'purged'}  ` +
        `${String(record.pagesSaved).padStart(5)} page(s)  ${record.runId}  ${record.seed}`,
    );
    lines.push(`      ${causeOf(record)}`);
  }

  if (summary.kept > 0) {
    lines.push('');
    lines.push(
      'KEPT means the run was archived without a purge, because it failed when GeekAPI could ' +
        'not be reached. It cannot be re-posted: no command exists, and nothing ingests from ' +
        `${dataDir}/extract-cache, which is diagnostics. Whatever it wrote to GeekAPI was not ` +
        'deleted when it failed. It may have gone since: the startup orphan pass purges a run ' +
        'still marked running without updating this record, and a later crawl of the same seed ' +
        'replaces it. Since 2026-10-05 a failed run is purged, so KEPT runs predate that.',
    );
  }

  return lines.join('\n');
}
