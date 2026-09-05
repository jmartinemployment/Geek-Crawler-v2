"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

type CrawlType = "partner" | "competitors" | "local";

export function SubmitCrawlForm() {
  const router = useRouter();
  const [seeds, setSeeds] = useState("");
  const [crawlType, setCrawlType] = useState<CrawlType>("partner");
  const [maxRequests, setMaxRequests] = useState("50");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const seedList = seeds
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await fetch("/api/crawls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          seeds: seedList,
          crawlType,
          maxRequestsPerCrawl: Number(maxRequests) || 50,
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
        <span>Seeds (one URL per line)</span>
        <textarea
          rows={6}
          value={seeds}
          onChange={(e) => setSeeds(e.target.value)}
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
        <span>Max requests</span>
        <input
          type="number"
          min={1}
          value={maxRequests}
          onChange={(e) => setMaxRequests(e.target.value)}
        />
      </label>
      <button type="submit" disabled={pending}>
        {pending ? "Starting…" : "Start crawl"}
      </button>
      {error ? <pre className="result">{error}</pre> : null}
    </form>
  );
}
