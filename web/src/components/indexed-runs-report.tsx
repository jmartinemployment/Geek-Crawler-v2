"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type IndexedRunRow = {
  runId: string;
  url: string;
  crawlType: string;
  mongoPageCount: number;
  pagesEnglish: number;
  chunksUpserted: number;
  finishedAtUtc: string | null;
};

export function IndexedRunsReport() {
  const [rows, setRows] = useState<IndexedRunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/crawls/indexed-report", {
          cache: "no-store",
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Report failed");
        if (!cancelled) {
          setRows(Array.isArray(body.rows) ? body.rows : []);
          setWarning(typeof body.warning === "string" ? body.warning : null);
        }
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
      "url,runId,crawlType,mongoPageCount,pagesEnglish,chunksUpserted,indexedAtUtc",
      ...rows.map((row) =>
        [
          JSON.stringify(row.url),
          JSON.stringify(row.runId),
          JSON.stringify(row.crawlType),
          row.mongoPageCount,
          row.pagesEnglish,
          row.chunksUpserted,
          JSON.stringify(row.finishedAtUtc ?? ""),
        ].join(","),
      ),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = "indexed-runs.csv";
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  return (
    <section className="stack">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "1rem",
        }}
      >
        <h1>Successfully Indexed Runs</h1>
        <button type="button" onClick={downloadCsv} disabled={rows.length === 0}>
          Download report CSV
        </button>
      </div>
      <p className="lede">
        One authoritative report from GeekAPI crawl metadata joined with RAG
        index status. Newest indexing completion appears first.
      </p>
      {error ? <pre className="result">{error}</pre> : null}
      {warning ? <pre className="result">{warning}</pre> : null}
      {loading ? (
        <div className="panel">Loading indexed runs…</div>
      ) : rows.length === 0 ? (
        <div className="panel">No successfully indexed runs.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>URL</th>
              <th>Type</th>
              <th>Pages</th>
              <th>English</th>
              <th>Chunks</th>
              <th>Indexed (UTC)</th>
              <th>runId</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.runId}>
                <td>
                  <a href={row.url} target="_blank" rel="noreferrer">
                    {row.url || "—"}
                  </a>
                </td>
                <td>{row.crawlType}</td>
                <td>{row.mongoPageCount}</td>
                <td>{row.pagesEnglish}</td>
                <td>{row.chunksUpserted}</td>
                <td>{row.finishedAtUtc ?? "—"}</td>
                <td className="muted">
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
