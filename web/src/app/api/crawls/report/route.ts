import { NextResponse } from "next/server";
import { crawleeApiUrl } from "@/lib/server-env";
import {
  buildSeedReportForRun,
  mapPool,
  type SeedReportRow,
} from "@/lib/seed-report";

const CONCURRENCY = 3;

export async function GET() {
  try {
    const listRes = await fetch(`${crawleeApiUrl()}/crawls`, {
      cache: "no-store",
    });
    const listBody = await listRes.json().catch(() => ({ runs: [] }));
    const runs: { runId?: string }[] = Array.isArray(listBody.runs)
      ? listBody.runs
      : [];
    const runIds = [
      ...new Set(
        runs
          .map((r) => r.runId)
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      ),
    ];

    const reports = await mapPool(runIds, CONCURRENCY, (runId) =>
      buildSeedReportForRun(runId).catch(() => null),
    );

    const rows: SeedReportRow[] = [];
    for (const report of reports) {
      if (!report) continue;
      rows.push(...report.rows);
    }

    // Prefer crawlType then seedUrl for a stable operator view.
    rows.sort((a, b) => {
      const t = a.crawlType.localeCompare(b.crawlType);
      if (t !== 0) return t;
      return a.seedUrl.localeCompare(b.seedUrl);
    });

    return NextResponse.json({
      ok: true,
      runCount: runIds.length,
      rows,
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
