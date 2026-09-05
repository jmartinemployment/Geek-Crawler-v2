import { NextResponse } from "next/server";

/**
 * Short-lived (or long-lived local) JWT for SignalR hub.
 * Set GEEK_USER_ACCESS_TOKEN in web/.env.local (same user as GEEK_USER_ID).
 */
export async function GET() {
  const accessToken =
    process.env.GEEK_USER_ACCESS_TOKEN?.trim() ||
    process.env.GEEK_ACCESS_TOKEN?.trim() ||
    null;
  if (!accessToken) {
    return NextResponse.json(
      {
        accessToken: null,
        message:
          "Set GEEK_USER_ACCESS_TOKEN in web/.env.local for SignalR. REST snapshots still work via API key.",
      },
      { status: 501 },
    );
  }
  return NextResponse.json({ accessToken });
}
