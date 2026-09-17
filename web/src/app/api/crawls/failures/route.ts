import { NextResponse } from "next/server";
import { crawleeApiUrl } from "@/lib/server-env";

/**
 * Post-mortems for purged runs. The runs are gone — pages, links, vectors and
 * local scratch — so this archive is the only record of why they ended.
 */
export async function GET() {
  try {
    const res = await fetch(`${crawleeApiUrl()}/failures`, { cache: "no-store" });
    const body = await res.json();
    return NextResponse.json(body, { status: res.status });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        failures: [],
      },
      { status: 502 },
    );
  }
}
