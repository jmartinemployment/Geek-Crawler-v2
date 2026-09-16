import { NextResponse } from "next/server";
import { getAccessTokenWithRefresh } from "@/lib/auth/session";

/** JWT for SignalR hub — session cookies only (no env-token substitute). */
export async function GET() {
  const sessionToken = await getAccessTokenWithRefresh();
  if (sessionToken) {
    return NextResponse.json({ accessToken: sessionToken });
  }

  return NextResponse.json(
    {
      accessToken: null,
      error: {
        code: "AUTH_REQUIRED",
        message: "Sign in required — open /api/auth/start",
      },
    },
    { status: 401 },
  );
}
