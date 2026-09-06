import { NextResponse } from "next/server";
import { buildSeedReportForRun } from "@/lib/seed-report";

type Ctx = { params: Promise<{ runId: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { runId } = await ctx.params;
  try {
    const report = await buildSeedReportForRun(runId);
    if (!report) {
      return NextResponse.json(
        { error: "run not found", rows: [] },
        { status: 404 },
      );
    }
    return NextResponse.json(report);
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : String(err),
        rows: [],
      },
      { status: 502 },
    );
  }
}
