/** Server-only env for BFF routes. */
export function crawleeApiUrl(): string {
  return (process.env.CRAWLEE_API_URL?.trim() || "http://127.0.0.1:8787").replace(
    /\/$/,
    "",
  );
}

export function geekApiUrl(): string {
  return (
    process.env.GEEK_API_URL?.trim() ||
    process.env.NEXT_PUBLIC_GEEK_API_URL?.trim() ||
    "https://api.geekatyourspot.com"
  ).replace(/\/$/, "");
}

export function geekApiHeaders(): HeadersInit {
  const key = process.env.GEEK_BACKEND_API_KEY?.trim();
  const userId = process.env.GEEK_USER_ID?.trim();
  if (!key || !userId) {
    throw new Error("GEEK_BACKEND_API_KEY and GEEK_USER_ID required in web/.env.local");
  }
  return {
    Accept: "application/json",
    "X-API-Key": key,
    "X-Geek-User-Id": userId,
  };
}
