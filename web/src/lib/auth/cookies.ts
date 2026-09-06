export const REFRESH_COOKIE = "gcv2_refresh";
export const ACCESS_COOKIE = "gcv2_access";
export const PKCE_COOKIE = "gcv2_pkce_verifier";

const secure =
  process.env.NODE_ENV === "production" || process.env.VERCEL === "1";

export const cookieOpts = {
  pkce: {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
    maxAge: 600,
  },
  refresh: {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  },
  access: {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
    maxAge: 60 * 5,
  },
  clear: {
    httpOnly: true,
    path: "/",
    maxAge: 0,
  },
};
