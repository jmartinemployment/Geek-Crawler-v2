import type { NextConfig } from "next";
import { existsSync } from "node:fs";
import path from "node:path";

const nextConfig = (phase: string): NextConfig => {
  // #region agent log
  fetch("http://127.0.0.1:7522/ingest/a1301922-e501-4d06-affc-47df584c3a01", { method: "POST", headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "8fdfbf" }, body: JSON.stringify({ sessionId: "8fdfbf", runId: "pre-fix", hypothesisId: "H1-H3", location: "web/next.config.ts:5", message: "Next configuration loaded", data: { phase, pid: process.pid, cwd: process.cwd(), nextVersion: process.env.npm_package_dependencies_next ?? null, runsManifestExists: existsSync(path.join(process.cwd(), ".next/server/app/runs/page/app-build-manifest.json")), rootManifestExists: existsSync(path.join(process.cwd(), "../.next/server/app/runs/page/app-build-manifest.json")) }, timestamp: Date.now() }) }).catch(() => {});
  // #endregion

  return {
    /* config options here */
  };
};

export default nextConfig;
