function trimOrEmpty(value: string | undefined): string {
  return value?.trim() ?? "";
}

function envOr(value: string | undefined, fallback: string): string {
  const v = trimOrEmpty(value);
  return v.length > 0 ? v : fallback;
}

function resolveAppUrl(): string {
  const explicit = trimOrEmpty(process.env.NEXT_PUBLIC_APP_URL);
  if (explicit) return explicit.replace(/\/$/, "");
  return "http://localhost:3000";
}

const authUrl = envOr(
  process.env.NEXT_PUBLIC_AUTH_URL,
  "https://auth.geekatyourspot.com",
).replace(/\/$/, "");

const appUrl = resolveAppUrl();

export const authConfig = {
  authUrl,
  authorizeUrl: `${authUrl}/connect/authorize`,
  tokenUrl: `${authUrl}/connect/token`,
  clientId: envOr(process.env.NEXT_PUBLIC_OAUTH_CLIENT_ID, "geek-crawler"),
  redirectUri: `${appUrl}/auth/callback`,
  scope: "openid profile email offline_access",
  appUrl,
};
