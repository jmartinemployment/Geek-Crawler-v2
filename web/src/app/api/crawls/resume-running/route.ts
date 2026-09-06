import { NextResponse } from "next/server";
import { crawleeApiUrl } from "@/lib/server-env";

export async function POST(req: Request) {
  try {
    let body: unknown = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    const res = await fetch(`${crawleeApiUrl()}/crawls/resume-running`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const json = await res.json();
    return NextResponse.json(json, { status: res.status });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
