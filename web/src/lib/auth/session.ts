import { cache } from "react";
import { cookies } from "next/headers";
import { ACCESS_COOKIE, REFRESH_COOKIE, cookieOpts } from "@/lib/auth/cookies";
import { isAccessTokenUsable } from "@/lib/auth/jwt-expiry";
import { isSessionDeadError, refreshAccessToken } from "@/lib/auth/tokens";

export const getAccessToken = cache(async (): Promise<string | null> => {
  const jar = await cookies();
  return jar.get(ACCESS_COOKIE)?.value ?? null;
});

export async function getAccessTokenWithRefresh(): Promise<string | null> {
  const jar = await cookies();
  const existing = jar.get(ACCESS_COOKIE)?.value;
  if (existing && isAccessTokenUsable(existing)) return existing;

  const refresh = jar.get(REFRESH_COOKIE)?.value;
  if (!refresh) return null;

  try {
    const tokens = await refreshAccessToken(refresh);
    if (tokens.refresh_token) {
      jar.set(REFRESH_COOKIE, tokens.refresh_token, cookieOpts.refresh);
    }
    const maxAge = Math.max(30, Math.min(tokens.expires_in - 60, 60 * 10));
    jar.set(ACCESS_COOKIE, tokens.access_token, {
      ...cookieOpts.access,
      maxAge,
    });
    return tokens.access_token;
  } catch (error) {
    if (isSessionDeadError(error)) {
      jar.set(REFRESH_COOKIE, "", cookieOpts.clear);
      jar.set(ACCESS_COOKIE, "", cookieOpts.clear);
    }
    return null;
  }
}
