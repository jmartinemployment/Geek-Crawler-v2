"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

export function AuthCallbackClient() {
  const params = useSearchParams();
  const [exchangeError, setExchangeError] = useState<string | null>(null);
  const exchanged = useRef<string | null>(null);

  const code = params.get("code");
  const oauthError = params.get("error");
  const errorDescription = params.get("error_description");

  const paramError = oauthError
    ? errorDescription || oauthError
    : code
      ? null
      : "Missing authorization code";

  useEffect(() => {
    if (!code || oauthError) return;
    if (exchanged.current === code) return;
    exchanged.current = code;

    (async () => {
      try {
        const res = await fetch("/api/auth/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            error?: string;
          } | null;
          setExchangeError(body?.error || "Sign-in failed");
          return;
        }
        window.location.assign("/");
      } catch {
        setExchangeError("Sign-in failed — could not reach the server.");
      }
    })();
  }, [code, oauthError]);

  const error = paramError ?? exchangeError;

  if (error) {
    return (
      <div className="stack" style={{ textAlign: "center", marginTop: "3rem" }}>
        <h1>Sign-in failed</h1>
        <p className="muted">{error}</p>
        <a href="/api/auth/start">Try again</a>
      </div>
    );
  }

  return <p className="muted">Completing sign-in…</p>;
}
