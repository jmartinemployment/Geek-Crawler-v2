import { NextResponse } from "next/server";
import { crawleeApiUrl } from "@/lib/server-env";

type Ctx = { params: Promise<{ runId: string }> };

/** Delete a run's pages, links, and vectors. Irreversible. */
export async function POST(_req: Request, ctx: Ctx) {
  const { runId } = await ctx.params;
  try {
    const res = await fetch(
      `${crawleeApiUrl()}/crawls/${encodeURIComponent(runId)}`,
      { method: "DELETE", headers: { "content-type": "application/json" } },
    );
    const json = await res.json();
    return NextResponse.json(json, { status: res.status });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
