/** Seconds before JWT exp to treat the token as stale and refresh early. */
const REFRESH_SKEW_SEC = 60;

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function jwtExpUnix(token: string): number | null {
  const payload = decodeJwtPayload(token);
  const exp = payload?.exp;
  if (typeof exp === "number" && Number.isFinite(exp)) return exp;
  if (typeof exp === "string" && /^\d+$/.test(exp)) return Number(exp);
  return null;
}

/** True when the access token exists and is not within REFRESH_SKEW_SEC of expiry. */
export function isAccessTokenUsable(
  token: string,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  const exp = jwtExpUnix(token);
  if (exp === null) return true;
  return exp - nowSec > REFRESH_SKEW_SEC;
}
