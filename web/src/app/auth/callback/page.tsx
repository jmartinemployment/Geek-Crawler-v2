import { Suspense } from "react";
import { AuthCallbackClient } from "./callback-client";

export default function AuthCallbackPage() {
  return (
    <Suspense fallback={<p className="muted">Loading sign-in…</p>}>
      <AuthCallbackClient />
    </Suspense>
  );
}
