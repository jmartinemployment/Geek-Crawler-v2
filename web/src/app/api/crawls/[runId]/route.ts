import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { geekApiHeaders, geekApiUrl } from "@/lib/server-env";

type Ctx = { params: Promise<{ runId: string }> };

/** Authoritative run snapshot from GeekAPI only — no local substitute. */
export async function GET(_req: Request, ctx: Ctx) {
  const { runId } = await ctx.params;
  const correlationId = randomUUID();
  try {
    const apiRes = await fetch(
      `${geekApiUrl()}/api/geek-crawler/crawls/${encodeURIComponent(runId)}`,
      { headers: geekApiHeaders(), cache: "no-store" },
    );
    if (apiRes.ok) {
      const snapshot = await apiRes.json();
      return NextResponse.json({ source: "geekapi", ...snapshot });
    }
    const upstreamBody = (await apiRes.text()).slice(0, 500);
    console.error(
      JSON.stringify({
        code: "UPSTREAM_UNAVAILABLE",
        correlationId,
        route: `/api/crawls/${runId}`,
        status: apiRes.status,
        upstreamBody,
      }),
    );
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "UPSTREAM_UNAVAILABLE",
          message: "Upstream crawl service request failed",
          correlationId,
        },
      },
      { status: 502 },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        code: "UPSTREAM_UNAVAILABLE",
        correlationId,
        route: `/api/crawls/${runId}`,
        message: detail.slice(0, 500),
      }),
    );
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "UPSTREAM_UNAVAILABLE",
          message: "Upstream crawl service request failed",
          correlationId,
        },
      },
      { status: 502 },
    );
  }
}
