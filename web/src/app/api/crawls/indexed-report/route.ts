import { NextResponse } from "next/server";
import { geekApiHeaders, geekApiUrl } from "@/lib/server-env";
import { mapPool } from "@/lib/seed-report";

type CrawlSnapshot = {
  runId?: string;
  crawlType?: string;
  seedUrls?: string[];
};

type RagIndexStatus = {
  state?: string;
  mongoPageCount?: number;
  pagesEnglish?: number;
  chunksUpserted?: number;
  attempt?: number;
  trigger?: string;
  finishedAtUtc?: string;
};

const CONCURRENCY = 20;
const STATUS_TIMEOUT_MS = 4_000;

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
      try {
        const response = await fetch(
          `${base}/api/geek-crawler/crawls/${encodeURIComponent(crawl.runId)}/rag-index`,
          {
            headers,
            cache: "no-store",
            signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
          },
        );
        if (!response.ok) {
          if (response.status >= 500) failedLookups += 1;
          return null;
        }

        const status = (await response.json()) as RagIndexStatus;
        if (status.state?.toLowerCase() !== "complete") return null;
        return {
          runId: crawl.runId,
          url: crawl.seedUrls?.[0] ?? "",
          crawlType: crawl.crawlType ?? "",
          mongoPageCount: status.mongoPageCount ?? 0,
          pagesEnglish: status.pagesEnglish ?? 0,
          chunksUpserted: status.chunksUpserted ?? 0,
          attempt: status.attempt ?? 0,
          trigger: status.trigger ?? "manual",
          finishedAtUtc: status.finishedAtUtc ?? null,
        };
      } catch {
        failedLookups += 1;
        return null;
      }
    });

    const rows = indexed
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .sort((a, b) => {
        const completed = (b.finishedAtUtc ?? "").localeCompare(
          a.finishedAtUtc ?? "",
        );
        return completed || a.url.localeCompare(b.url);
      });

    return NextResponse.json({
      ok: true,
      count: rows.length,
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
