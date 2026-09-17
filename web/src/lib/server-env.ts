/** Server-only env for BFF routes — required values, no silent host defaults. */

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new Error(`${name} is required`);
  }
  return v;
}

export function crawleeApiUrl(): string {
  return requireEnv("CRAWLEE_API_URL").replace(/\/$/, "");
}

export function geekApiUrl(): string {
  const explicit =
    process.env.GEEK_API_URL?.trim() ||
    process.env.NEXT_PUBLIC_GEEK_API_URL?.trim();
  if (!explicit) {
    throw new Error("GEEK_API_URL or NEXT_PUBLIC_GEEK_API_URL is required");
  }
  return explicit.replace(/\/$/, "");
}

export function geekApiHeaders(): HeadersInit {
  const key = requireEnv("GEEK_BACKEND_API_KEY");
  const userId = requireEnv("GEEK_USER_ID");
  return {
    Accept: "application/json",
    "X-API-Key": key,
    "X-Geek-User-Id": userId,
  };
}
