"use client";

import { Fragment, useEffect, useState } from "react";

type RejectSample = { url: string; detail?: string };

type FailureRecord = {
  runId: string;
  seed: string;
  crawlType: string;
  status: "failed" | "cancelled";
  errorSummary: string | null;
  purgedAtUtc: string;
  pagesSaved: number;
  linksSaved: number;
  report: {
    linksStored: number;
    excludedByPolicy: { robotsDisallowed: number; localeExcluded: number };
    failed: {
      requestFailed: number;
      challengePage: number;
      extractEmpty: number;
    };
    samples: Array<{ reason: string; url: string; detail?: string }>;
  };
  rejectSamples: Record<string, RejectSample[]>;
  purge: {
    vectorsPurged: boolean;
    crawlDataDeleted: boolean;
    localRemoved: string[];
    errors?: string[];
  };
};

/**
 * Why runs did not become corpus.
 *
 * These runs no longer exist — their pages, links, vectors and local scratch
 * were destroyed when they ended. This report is what was deliberately kept.
 */
export function FailedRunsReport() {
  const [rows, setRows] = useState<FailureRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/crawls/failures", {
          cache: "no-store",
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Failure report failed");
        if (!cancelled) {
          setRows(Array.isArray(body.failures) ? body.failures : []);
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
      "seed,runId,crawlType,status,pagesSaved,linksSaved,robotsDisallowed,localeExcluded,requestFailed,challengePage,extractEmpty,errorSummary,purgedAtUtc",
      ...rows.map((row) =>
        [
          JSON.stringify(row.seed),
          JSON.stringify(row.runId),
          JSON.stringify(row.crawlType),
          JSON.stringify(row.status),
          row.pagesSaved,
          row.linksSaved,
          row.report.excludedByPolicy.robotsDisallowed,
          row.report.excludedByPolicy.localeExcluded,
          row.report.failed.requestFailed,
          row.report.failed.challengePage,
          row.report.failed.extractEmpty,
          JSON.stringify(row.errorSummary ?? ""),
          JSON.stringify(row.purgedAtUtc),
        ].join(","),
      ),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = "purged-runs.csv";
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
        <h1>Purged Runs</h1>
        <button type="button" onClick={downloadCsv} disabled={rows.length === 0}>
          Download report CSV
        </button>
      </div>
      <p className="lede">
        Runs that failed or were cancelled. Their pages, links, vectors and local
        scratch were destroyed; this is the post-mortem that was kept. Select a
        row to see the URLs behind each reject reason.
      </p>
      {error ? <pre className="result">{error}</pre> : null}
      {loading ? (
        <div className="panel">Loading purged runs…</div>
      ) : rows.length === 0 ? (
        <div className="panel">No purged runs.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Seed</th>
              <th>Type</th>
              <th>Status</th>
              <th>Pages</th>
              <th>Robots</th>
              <th>Locale</th>
              <th>Request</th>
              <th>Challenge</th>
              <th>Empty</th>
              <th>Purged (UTC)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const open = expanded === row.runId;
              const samples = Object.entries(row.rejectSamples ?? {}).filter(
                ([, entries]) => entries.length > 0,
              );
              return (
                <Fragment key={row.runId}>
                  <tr
                    onClick={() => setExpanded(open ? null : row.runId)}
                    style={{ cursor: "pointer" }}
                  >
                    <td>{row.seed || "—"}</td>
                    <td>{row.crawlType}</td>
                    <td>{row.status}</td>
                    <td>{row.pagesSaved}</td>
                    <td>{row.report.excludedByPolicy.robotsDisallowed}</td>
                    <td>{row.report.excludedByPolicy.localeExcluded}</td>
                    <td>{row.report.failed.requestFailed}</td>
                    <td>{row.report.failed.challengePage}</td>
                    <td>{row.report.failed.extractEmpty}</td>
                    <td className="muted">{row.purgedAtUtc}</td>
                  </tr>
                  {open ? (
                    <tr>
                      <td colSpan={10}>
                        <div className="stack">
                          <p className="muted">
                            runId {row.runId} · vectors purged{" "}
                            {String(row.purge?.vectorsPurged)} · rows deleted{" "}
                            {String(row.purge?.crawlDataDeleted)}
                          </p>
                          {row.errorSummary ? (
                            <pre className="result">{row.errorSummary}</pre>
                          ) : null}
                          {row.purge?.errors?.length ? (
                            <pre className="result">
                              {row.purge.errors.join("\n")}
                            </pre>
                          ) : null}
                          {samples.length === 0 ? (
                            <p className="muted">No sample URLs recorded.</p>
                          ) : (
                            samples.map(([reason, entries]) => (
                              <div key={reason}>
                                <strong>{reason}</strong>
                                <ul>
                                  {entries.map((entry) => (
                                    <li key={entry.url} className="muted">
                                      {entry.url}
                                      {entry.detail ? ` — ${entry.detail}` : ""}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ))
                          )}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
