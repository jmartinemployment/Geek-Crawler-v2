function trimOrEmpty(value: string | undefined): string {
  return value?.trim() ?? "";
}

function requireEnv(name: string): string {
  const v = trimOrEmpty(process.env[name]);
  if (!v) {
    throw new Error(`${name} is required`);
  }
  return v;
}

/** Lazy auth config — resolves at call time, not module import. */
export function getAuthConfig() {
  const authUrl = requireEnv("NEXT_PUBLIC_AUTH_URL").replace(/\/$/, "");
  const appUrl = requireEnv("NEXT_PUBLIC_APP_URL").replace(/\/$/, "");
  const clientId = requireEnv("NEXT_PUBLIC_OAUTH_CLIENT_ID");
  return {
    authUrl,
    authorizeUrl: `${authUrl}/connect/authorize`,
    tokenUrl: `${authUrl}/connect/token`,
    clientId,
    redirectUri: `${appUrl}/auth/callback`,
    scope: "openid profile email offline_access",
    appUrl,
  };
}

/** @deprecated Prefer getAuthConfig() — kept for gradual call-site migration via proxy. */
export const authConfig = new Proxy({} as ReturnType<typeof getAuthConfig>, {
  get(_target, prop, receiver) {
    return Reflect.get(getAuthConfig(), prop, receiver);
  },
});
