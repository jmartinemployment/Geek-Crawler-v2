import { NextResponse } from "next/server";
import { geekApiHeaders, geekApiUrl } from "@/lib/server-env";

type Ctx = { params: Promise<{ runId: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const { runId } = await ctx.params;
  const { searchParams } = new URL(req.url);
  const limit = Math.min(
    500,
    Math.max(1, Number(searchParams.get("limit") ?? "100") || 100),
  );
  const offset = Math.max(0, Number(searchParams.get("offset") ?? "0") || 0);
  try {
    const res = await fetch(
      `${geekApiUrl()}/api/geek-crawler/crawls/${encodeURIComponent(runId)}/page-urls?limit=${limit}&offset=${offset}`,
      { headers: geekApiHeaders(), cache: "no-store" },
    );
    const body = await res.json();
    if (!res.ok) {
      return NextResponse.json(
        { error: body, urls: [], limit, offset, hasMore: false },
        { status: res.status },
      );
    }
    const urls = Array.isArray(body) ? body : body.urls ?? [];
    return NextResponse.json({
      runId,
      urls,
      limit,
      offset,
      hasMore: urls.length >= limit,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : String(err),
        urls: [],
        limit,
        offset,
        hasMore: false,
      },
      { status: 502 },
    );
  }
}
