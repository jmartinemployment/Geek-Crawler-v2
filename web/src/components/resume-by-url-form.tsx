"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

/** Resume by seed URL from the report (1 runId ↔ 1 URL going forward). */
export function ResumeByUrlForm() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    setNote(null);
    try {
      const seed = url.trim();
      if (!seed) {
        setError("Enter the seed URL from the report");
        return;
      }
      const res = await fetch("/api/crawls/resume-by-url", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: seed }),
      });
      const body = await res.json();
      if (!res.ok || !body.runId) {
        setError(
          `${res.status}: ${body.error ?? body.message ?? JSON.stringify(body)}`,
        );
        return;
      }
      setNote(
        body.note
          ? `Resumed ${body.runId}. ${body.note}`
          : `Resumed run ${body.runId}`,
      );
      router.push(`/runs/${encodeURIComponent(body.runId)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <label className="field">
        <span>Seed URL to resume</span>
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.anomalo.com"
          required
        />
      </label>
      <button type="submit" disabled={pending}>
        {pending ? "Resuming…" : "Resume by URL"}
      </button>
      {note ? <p className="muted">{note}</p> : null}
      {error ? <pre className="result">{error}</pre> : null}
    </form>
  );
}
