"use client";

import { useState } from "react";

type ResumeRow = { runId: string; seedUrl: string; reason?: string; error?: string };

/**
 * One-click re-attach for local stubs stuck in status=running
 * (e.g. after `serve` restart orphaned in-memory workers).
 */
export function ResumeAllRunningButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [details, setDetails] = useState<string | null>(null);

  async function onClick() {
    setPending(true);
    setError(null);
    setSummary(null);
    setDetails(null);
    try {
      const res = await fetch("/api/crawls/resume-running", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxConcurrency: 1 }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(
          `${res.status}: ${body.error ?? body.message ?? JSON.stringify(body)}`,
        );
        return;
      }
      const resumed = (body.resumed ?? []) as ResumeRow[];
      const skipped = (body.skipped ?? []) as ResumeRow[];
      const failed = (body.failed ?? []) as ResumeRow[];
      setSummary(
        `Resumed ${resumed.length}, skipped ${skipped.length}, failed ${failed.length} (of ${body.candidateCount ?? "?"} running stubs).`,
      );
      const lines: string[] = [];
      for (const r of resumed) {
        lines.push(`resumed  ${r.seedUrl || r.runId}`);
      }
      for (const r of skipped) {
        lines.push(`skipped  ${r.seedUrl || r.runId} — ${r.reason ?? ""}`);
      }
      for (const r of failed) {
        lines.push(`failed   ${r.seedUrl || r.runId} — ${r.error ?? ""}`);
      }
      if (lines.length > 0) setDetails(lines.join("\n"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="stack">
      <p className="muted">
        Orphaned after a <code>serve</code> restart? Re-attach every local stub
        still marked <code>running</code> (skips ones already in flight).
      </p>
      <button type="button" onClick={onClick} disabled={pending}>
        {pending ? "Resuming all running…" : "Resume all running"}
      </button>
      {summary ? <p className="muted">{summary}</p> : null}
      {details ? <pre className="result">{details}</pre> : null}
      {error ? <pre className="result">{error}</pre> : null}
    </div>
  );
}
