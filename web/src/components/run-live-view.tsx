"use client";

import { useEffect, useState } from "react";
import {
  createCrawlHubConnection,
  joinCrawlRun,
  onCrawlEvent,
  type GeekCrawlerEvent,
} from "@/lib/crawl-hub";

type UrlRow = { origin?: string; url?: string; hasHtml?: boolean };

export function RunLiveView({ runId }: { runId: string }) {
  const [snapshot, setSnapshot] = useState<Record<string, unknown> | null>(null);
  const [urls, setUrls] = useState<UrlRow[]>([]);
  const [hubNote, setHubNote] = useState<string | null>(null);
  const [lastEvent, setLastEvent] = useState<GeekCrawlerEvent | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadSnapshot() {
    const res = await fetch(`/api/crawls/${encodeURIComponent(runId)}`, {
      cache: "no-store",
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? res.statusText);
    setSnapshot(body);
  }

  async function loadUrls(offset = 0) {
    const res = await fetch(
      `/api/crawls/${encodeURIComponent(runId)}/urls?limit=200&offset=${offset}`,
      { cache: "no-store" },
    );
    const body = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(body.error ?? body));
    setUrls(Array.isArray(body.urls) ? body.urls : []);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadSnapshot();
        await loadUrls();
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      }
    })();

    const connection = createCrawlHubConnection();
    const offEvent = onCrawlEvent(connection, (evt) => {
      setLastEvent(evt);
      void loadSnapshot();
      void loadUrls();
    });

    (async () => {
      try {
        await joinCrawlRun(connection, runId);
        if (!cancelled) setHubNote("SignalR connected");
      } catch (err) {
        if (!cancelled)
          setHubNote(
            err instanceof Error
              ? `SignalR: ${err.message}`
              : "SignalR unavailable — REST snapshot only",
          );
      }
    })();

    return () => {
      cancelled = true;
      offEvent();
      void connection.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount once per runId
  }, [runId]);

  function downloadCsv() {
    const lines = ["origin,url,hasHtml"];
    for (const row of urls) {
      const o = JSON.stringify(row.origin ?? "");
      const u = JSON.stringify(row.url ?? "");
      lines.push(`${o},${u},${row.hasHtml ? "1" : "0"}`);
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `crawl-${runId}-urls.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="stack">
      {hubNote ? <p className="muted">{hubNote}</p> : null}
      {error ? <pre className="result">{error}</pre> : null}
      <section>
        <h2>Status</h2>
        <pre className="result">
          {JSON.stringify(lastEvent ?? snapshot, null, 2)}
        </pre>
      </section>
      <section>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "1rem",
          }}
        >
          <h2>URLs ({urls.length} loaded)</h2>
          <button type="button" onClick={downloadCsv} disabled={urls.length === 0}>
            Download CSV
          </button>
        </div>
        {urls.length === 0 ? (
          <div className="panel">No URL rows yet (page-urls).</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>URL</th>
                <th>HTML</th>
              </tr>
            </thead>
            <tbody>
              {urls.map((row, i) => (
                <tr key={`${row.url}-${i}`}>
                  <td>{row.url}</td>
                  <td>{row.hasHtml ? "yes" : "no"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
