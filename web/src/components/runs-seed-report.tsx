"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type ReportRow = {
  runId: string;
  seedUrl: string;
  pageCount: number;
  sitemapUrlCount?: number;
  sitemapPathCount?: number;
  status: string;
  statusDescription: string;
  crawlType: string;
  completed: string;
  failureReason: string | null;
};

export function RunsSeedReport() {
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/crawls/report", { cache: "no-store" });
        const body = await res.json();
        if (!res.ok) {
          throw new Error(
            typeof body.error === "string"
              ? body.error
              : JSON.stringify(body.error ?? body),
          );
        }
        if (!cancelled) setRows(Array.isArray(body.rows) ? body.rows : []);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function downloadCsv() {
    const lines = [
      "runId,seedUrl,pageCount,sitemapUrlCount,sitemapPathCount,status,statusDescription,crawlType,completed,failureReason",
    ];
    for (const row of rows) {
      lines.push(
        [
          JSON.stringify(row.runId),
          JSON.stringify(row.seedUrl),
          row.pageCount,
          row.sitemapUrlCount ?? 0,
          row.sitemapPathCount ?? 0,
          JSON.stringify(row.status),
          JSON.stringify(row.statusDescription),
          JSON.stringify(row.crawlType),
          JSON.stringify(row.completed),
          JSON.stringify(row.failureReason ?? ""),
        ].join(","),
      );
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "crawls-seed-report.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <section className="stack" style={{ marginTop: "2rem" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "1rem",
        }}
      >
        <h2>Seed report (all local runs)</h2>
        <button
          type="button"
          onClick={downloadCsv}
          disabled={rows.length === 0}
        >
          Download report CSV
        </button>
      </div>
      <p className="muted">
        Includes partner, competitors, and local runs from DATA_DIR. Sitemap
        path count strips query strings; crawl uses the sitemap as the map when
        present.
      </p>
      {error ? <pre className="result">{error}</pre> : null}
      {loading ? (
        <div className="panel">Building seed report…</div>
      ) : rows.length === 0 ? (
        <div className="panel">No seed report rows yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>seedUrl</th>
              <th># crawled</th>
              <th>sitemap URLs</th>
              <th>sitemap paths</th>
              <th>status</th>
              <th>status (Description)</th>
              <th>crawlType</th>
              <th>100% Completed</th>
              <th>failureReason</th>
              <th>runId</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.runId}-${row.seedUrl}`}>
                <td>{row.seedUrl}</td>
                <td>{row.pageCount}</td>
                <td>{row.sitemapUrlCount ?? "—"}</td>
                <td>{row.sitemapPathCount ?? "—"}</td>
                <td>{row.status}</td>
                <td>{row.statusDescription}</td>
                <td>{row.crawlType}</td>
                <td>{row.completed}</td>
                <td>{row.failureReason ?? "—"}</td>
                <td>
                  <Link href={`/runs/${encodeURIComponent(row.runId)}`}>
                    {row.runId}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
