import { NextResponse } from "next/server";
import { createPkcePair, randomOAuthState } from "@/lib/auth/pkce";
import { PKCE_COOKIE, cookieOpts } from "@/lib/auth/cookies";
import { authConfig } from "@/lib/auth/config";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    if (!authConfig.authorizeUrl.startsWith("http")) {
      throw new Error(
        `Invalid authorize URL "${authConfig.authorizeUrl}". Set NEXT_PUBLIC_AUTH_URL.`,
      );
    }

    const { verifier, challenge } = await createPkcePair();
    const url = new URL(authConfig.authorizeUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", authConfig.clientId);
    url.searchParams.set("redirect_uri", authConfig.redirectUri);
    url.searchParams.set("scope", authConfig.scope);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", randomOAuthState());
    // Prefer SSO cookie on auth.geekatyourspot.com. Only force the password form when asked.
    const force = new URL(request.url).searchParams.get("force");
    if (force === "1" || force === "login") {
      url.searchParams.set("prompt", "login");
    }

    const res = NextResponse.redirect(url.toString());
    res.cookies.set(PKCE_COOKIE, verifier, cookieOpts.pkce);
    return res;
  } catch (error) {
    const message = error instanceof Error ? error.message : "OAuth start failed";
    console.error("[auth/start]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
