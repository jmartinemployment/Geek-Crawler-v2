import { NextResponse } from "next/server";
import { geekApiHeaders, geekApiUrl } from "@/lib/server-env";

type Ctx = { params: Promise<{ runId: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const { runId } = await ctx.params;
  const { searchParams } = new URL(req.url);
  const limit = searchParams.get("limit") ?? "100";
  const offset = searchParams.get("offset") ?? "0";
  try {
    const res = await fetch(
      `${geekApiUrl()}/api/geek-crawler/crawls/${encodeURIComponent(runId)}/page-urls?limit=${limit}&offset=${offset}`,
      { headers: geekApiHeaders(), cache: "no-store" },
    );
    const body = await res.json();
    if (!res.ok) {
      return NextResponse.json(
        { error: body, urls: [] },
        { status: res.status },
      );
    }
    const urls = Array.isArray(body) ? body : body.urls ?? [];
    return NextResponse.json({ runId, urls });
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : String(err),
        urls: [],
      },
      { status: 502 },
    );
  }
}
