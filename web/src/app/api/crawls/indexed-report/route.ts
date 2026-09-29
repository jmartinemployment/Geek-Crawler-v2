import { NextResponse } from "next/server";
import { geekApiHeaders, geekApiUrl } from "@/lib/server-env";
import { mapPool } from "@/services/seed-report";

type CrawlSnapshot = {
  runId?: string;
  crawlType?: string;
  seedUrls?: string[];
};

type RagIndexStatus = {
  state?: string;
  error?: string | null;
  mongoPageCount?: number;
  pagesEnglish?: number;
  chunksUpserted?: number;
  attempt?: number;
  trigger?: string;
  finishedAtUtc?: string;
};

/**
 * The deadline is the setting that matters here, not the fan-out width.
 *
 * Measured against production on 2026-09-29 over the same 21 runs. GeekAPI
 * answers this endpoint in about 0.1s most of the time and then stalls for
 * seconds with no pattern: a single request took 5.07s cold, one run at
 * concurrency 1 took 15.14s while its 20 siblings averaged well under a second,
 * and a pass at concurrency 3 finished every lookup in 0.19s or less. The stall
 * is not a load curve - it does not grow with width and it does not disappear
 * when serialised.
 *
 * So the old 4s deadline was below the stall and above the normal case, which
 * is the worst place to put it: a report over 21 runs reliably reported 21
 * failed lookups and rendered no rows at all, and the data behind it was fine.
 * 20s sits clear of every stall measured. A slow report is a report; a report
 * that gives up at 4s is a blank page.
 *
 * Width stays modest so one stalled lookup delays a slot rather than the run.
 */
const CONCURRENCY = 5;
const STATUS_TIMEOUT_MS = 20_000;

export async function GET() {
  try {
    const base = geekApiUrl();
    const headers = geekApiHeaders();
    const crawlsResponse = await fetch(
      `${base}/api/geek-crawler/crawls?limit=200`,
      { headers, cache: "no-store", signal: AbortSignal.timeout(15_000) },
    );
    if (!crawlsResponse.ok) {
      throw new Error(`GeekAPI crawl list returned ${crawlsResponse.status}`);
    }

    const crawls = (await crawlsResponse.json()) as CrawlSnapshot[];
    let failedLookups = 0;
    const indexed = await mapPool(crawls, CONCURRENCY, async (crawl) => {
      if (!crawl.runId) return null;
      const base_row = {
        runId: crawl.runId,
        url: crawl.seedUrls?.[0] ?? "",
        crawlType: crawl.crawlType ?? "",
        mongoPageCount: 0,
        pagesEnglish: 0,
        chunksUpserted: 0,
        attempt: 0,
        trigger: "",
        finishedAtUtc: null as string | null,
        error: null as string | null,
      };
      try {
        const response = await fetch(
          `${base}/api/geek-crawler/crawls/${encodeURIComponent(crawl.runId)}/rag-index`,
          {
            headers,
            cache: "no-store",
            signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
          },
        );
        // A 404 is an answer, not a failure: this run has never been indexed.
        // Reported as its own state so a run nobody has queued is told apart
        // from one whose lookup did not come back.
        if (response.status === 404) {
          return { ...base_row, state: "not indexed" };
        }
        if (!response.ok) {
          failedLookups += 1;
          return { ...base_row, state: "unknown" };
        }

        const status = (await response.json()) as RagIndexStatus;
        return {
          ...base_row,
          state: (status.state ?? "unknown").toLowerCase(),
          mongoPageCount: status.mongoPageCount ?? 0,
          pagesEnglish: status.pagesEnglish ?? 0,
          chunksUpserted: status.chunksUpserted ?? 0,
          attempt: status.attempt ?? 0,
          trigger: status.trigger ?? "manual",
          finishedAtUtc: status.finishedAtUtc ?? null,
          error: status.error ?? null,
        };
      } catch {
        // The lookup itself did not answer. The run still appears, because a
        // run dropped from the table reads as a run that does not exist.
        failedLookups += 1;
        return { ...base_row, state: "unknown" };
      }
    });

    // Complete first, newest completion first, which is the order this report
    // has always promised. Everything else follows in the order an operator
    // acts on it: what broke, what is moving, what is waiting, what nobody has
    // asked for yet.
    const STATE_ORDER: Record<string, number> = {
      complete: 0,
      failed: 1,
      running: 2,
      pending: 3,
      "not indexed": 4,
      unknown: 5,
    };

    // A run nobody has queued has no dates, no pages and no chunks, and it
    // stays that way indefinitely. Fourteen such rows buried the five that
    // carry information, so the count stays and the rows do not. Same for a
    // lookup that did not answer: the warning already reports those.
    const LISTED = new Set(["complete", "failed", "running", "pending"]);

    const rows = indexed
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .filter((row) => LISTED.has(row.state))
      .sort((a, b) => {
        const rank =
          (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9);
        if (rank !== 0) return rank;
        const completed = (b.finishedAtUtc ?? "").localeCompare(
          a.finishedAtUtc ?? "",
        );
        return completed || a.url.localeCompare(b.url);
      });

    // Counted over every crawl, not just the listed ones, so "14 not indexed"
    // is still on the page even though those rows are not.
    const byState: Record<string, number> = {};
    for (const row of indexed) {
      if (row) byState[row.state] = (byState[row.state] ?? 0) + 1;
    }

    return NextResponse.json({
      ok: true,
      count: rows.length,
      indexedCount: byState.complete ?? 0,
      byState,
      rows,
      partial: failedLookups > 0,
      failedLookups,
      warning:
        failedLookups > 0
          ? `${failedLookups} index status lookup(s) timed out or failed; retry to refresh missing rows.`
          : null,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        rows: [],
      },
      { status: 502 },
    );
  }
}
