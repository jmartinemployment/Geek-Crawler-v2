import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { ACCESS_COOKIE, REFRESH_COOKIE, cookieOpts } from "@/lib/auth/cookies";
import { authConfig } from "@/lib/auth/config";
import { isAccessTokenUsable } from "@/lib/auth/jwt-expiry";

function requestHostname(request: NextRequest): string {
  const hostHeader = request.headers.get("host") ?? "";
  return (hostHeader.split(":")[0] || request.nextUrl.hostname || "").toLowerCase();
}

function localhostOrigin(request: NextRequest): string {
  const hostHeader = request.headers.get("host") ?? "localhost:3000";
  const port = hostHeader.includes(":") ? hostHeader.split(":")[1] : "";
  return port ? `http://localhost:${port}` : "http://localhost";
}

/** Dev-only: keep OAuth PKCE cookies on localhost (registered redirect URI). */
function needsLocalhostCanon(request: NextRequest): boolean {
  if (process.env.NODE_ENV === "production") return false;
  const hostname = requestHostname(request);
  return hostname !== "localhost" && hostname !== "";
}

export async function middleware(request: NextRequest) {
  if (needsLocalhostCanon(request)) {
    const dest = `${localhostOrigin(request)}${request.nextUrl.pathname}${request.nextUrl.search}`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${dest}"><title>Redirecting…</title></head><body><script>location.replace(${JSON.stringify(dest)})</script><p><a href="${dest}">Continue on localhost</a></p></body></html>`;
    return new NextResponse(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  const access = request.cookies.get(ACCESS_COOKIE)?.value;
  const hasAccess = access ? isAccessTokenUsable(access) : false;
  const refresh = request.cookies.get(REFRESH_COOKIE)?.value;

  if (hasAccess || !refresh) return NextResponse.next();

  try {
    const res = await fetch(authConfig.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: authConfig.clientId,
        refresh_token: refresh,
      }).toString(),
      cache: "no-store",
    });
    if (!res.ok) {
      const dead = NextResponse.next();
      dead.cookies.set(REFRESH_COOKIE, "", cookieOpts.clear);
      dead.cookies.set(ACCESS_COOKIE, "", cookieOpts.clear);
      return dead;
    }
    const tokens = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    const headers = new Headers(request.headers);
    const jar = request.cookies;
    jar.set(ACCESS_COOKIE, tokens.access_token);
    if (tokens.refresh_token) jar.set(REFRESH_COOKIE, tokens.refresh_token);
    headers.set("cookie", jar.toString());

    const response = NextResponse.next({ request: { headers } });
    const maxAge = Math.max(30, Math.min(tokens.expires_in - 60, 60 * 10));
    response.cookies.set(ACCESS_COOKIE, tokens.access_token, {
      ...cookieOpts.access,
      maxAge,
    });
    if (tokens.refresh_token) {
      response.cookies.set(
        REFRESH_COOKIE,
        tokens.refresh_token,
        cookieOpts.refresh,
      );
    }
    return response;
  } catch {
    return NextResponse.next();
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
