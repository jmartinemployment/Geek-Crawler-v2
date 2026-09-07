"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

type CrawlType = "partner" | "competitors" | "local";

export function SubmitCrawlForm() {
  const router = useRouter();
  const [seed, setSeed] = useState("");
  const [crawlType, setCrawlType] = useState<CrawlType>("partner");
  /** Polite default — was env-driven 8 before this control existed. */
  const [maxConcurrency, setMaxConcurrency] = useState("1");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const url = seed.trim();
      if (!url) {
        setError("Enter one seed URL");
        return;
      }
      const concurrency = Math.max(
        1,
        Math.min(32, Math.floor(Number(maxConcurrency) || 1)),
      );
      const res = await fetch("/api/crawls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          seed: url,
          crawlType,
          maxConcurrency: concurrency,
        }),
      });
      const body = await res.json();
      if (!res.ok || !body.runId) {
        setError(
          `${res.status}: ${body.error ?? body.message ?? JSON.stringify(body)}`,
        );
        return;
      }
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
        <span>Seed URL (one URL = one run)</span>
        <input
          type="url"
          value={seed}
          onChange={(e) => setSeed(e.target.value)}
          placeholder="https://www.example.com"
          required
        />
      </label>
      <label className="field">
        <span>Crawl type</span>
        <select
          value={crawlType}
          onChange={(e) => setCrawlType(e.target.value as CrawlType)}
        >
          <option value="partner">partner</option>
          <option value="competitors">competitors</option>
          <option value="local">local</option>
        </select>
      </label>
      <label className="field">
        <span>Max concurrency</span>
        <input
          type="number"
          min={1}
          max={32}
          value={maxConcurrency}
          onChange={(e) => setMaxConcurrency(e.target.value)}
        />
      </label>
      <p className="muted">
        Parallel page fetches for this run (1–32). Lower is more polite; default
        1. Request budget = sitemap URL count when a map exists (no manual max).
      </p>
      <button type="submit" disabled={pending}>
        {pending ? "Starting…" : "Start crawl"}
      </button>
      {error ? <pre className="result">{error}</pre> : null}
    </form>
  );
}
