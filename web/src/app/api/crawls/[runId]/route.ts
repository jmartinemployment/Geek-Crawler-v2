import { NextResponse } from "next/server";
import { crawleeApiUrl, geekApiHeaders, geekApiUrl } from "@/lib/server-env";

type Ctx = { params: Promise<{ runId: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { runId } = await ctx.params;
  try {
    // Prefer GeekAPI snapshot (status/seeds); fall back to local Crawlee stub.
    try {
      const apiRes = await fetch(
        `${geekApiUrl()}/api/geek-crawler/crawls/${encodeURIComponent(runId)}`,
        { headers: geekApiHeaders(), cache: "no-store" },
      );
      if (apiRes.ok) {
        const snapshot = await apiRes.json();
        return NextResponse.json({ source: "geekapi", ...snapshot });
      }
    } catch {
      /* local fallback */
    }

    const local = await fetch(
      `${crawleeApiUrl()}/crawls/${encodeURIComponent(runId)}`,
      { cache: "no-store" },
    );
    const body = await local.json();
    return NextResponse.json(
      { source: "crawlee", ...body },
      { status: local.status },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
