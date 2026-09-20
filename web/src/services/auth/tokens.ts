import { authConfig } from "@/lib/auth/config";

export type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
};

export async function exchangeAuthorizationCode(
  code: string,
  codeVerifier: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: authConfig.clientId,
    code,
    code_verifier: codeVerifier,
    redirect_uri: authConfig.redirectUri,
  });
  return postToken(body);
}

export async function refreshAccessToken(
  refreshToken: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: authConfig.clientId,
    refresh_token: refreshToken,
  });
  return postToken(body);
}

async function postToken(body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(authConfig.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Token request failed (${res.status})`);
  }
  return res.json() as Promise<TokenResponse>;
}

export function isSessionDeadError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /invalid_grant|invalid_token|expired_token/i.test(msg);
}
