import { NextResponse } from "next/server";
import { getAccessTokenWithRefresh } from "@/lib/auth/session";

/**
 * JWT for SignalR hub — prefers session cookies from GeekOAuth login.
 * Optional fallback: GEEK_USER_ACCESS_TOKEN in web/.env.local.
 */
export async function GET() {
  const sessionToken = await getAccessTokenWithRefresh();
  if (sessionToken) {
    return NextResponse.json({ accessToken: sessionToken });
  }

  const envToken =
    process.env.GEEK_USER_ACCESS_TOKEN?.trim() ||
    process.env.GEEK_ACCESS_TOKEN?.trim() ||
    null;
  if (envToken) {
    return NextResponse.json({ accessToken: envToken });
  }

  return NextResponse.json(
    {
      accessToken: null,
      message: "Sign in required — open /api/auth/start",
    },
    { status: 401 },
  );
}
