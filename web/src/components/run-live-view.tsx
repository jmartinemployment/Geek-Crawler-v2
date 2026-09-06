"use client";

import { useEffect, useState } from "react";
import {
  createCrawlHubConnection,
  joinCrawlRun,
  onCrawlEvent,
  type GeekCrawlerEvent,
} from "@/lib/crawl-hub";

type UrlRow = { origin?: string; url?: string; hasHtml?: boolean };

type ReportRow = {
  runId?: string;
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

const PAGE_SIZE = 100;

export function RunLiveView({ runId }: { runId: string }) {
  const [snapshot, setSnapshot] = useState<Record<string, unknown> | null>(null);
  const [reportRows, setReportRows] = useState<ReportRow[]>([]);
  const [reportLoading, setReportLoading] = useState(true);
  const [urls, setUrls] = useState<UrlRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
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

  async function loadReport() {
    setReportLoading(true);
    try {
      const res = await fetch(
        `/api/crawls/${encodeURIComponent(runId)}/report`,
        { cache: "no-store" },
      );
      const body = await res.json();
      if (!res.ok) throw new Error(JSON.stringify(body.error ?? body));
      setReportRows(Array.isArray(body.rows) ? body.rows : []);
    } finally {
      setReportLoading(false);
    }
  }

  async function loadUrls(opts?: { offset?: number; append?: boolean }) {
    const offset = opts?.offset ?? 0;
    const append = opts?.append ?? false;
    const res = await fetch(
      `/api/crawls/${encodeURIComponent(runId)}/urls?limit=${PAGE_SIZE}&offset=${offset}`,
      { cache: "no-store" },
    );
    const body = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(body.error ?? body));
    const next = Array.isArray(body.urls) ? (body.urls as UrlRow[]) : [];
    setUrls((prev) => (append ? [...prev, ...next] : next));
    setHasMore(Boolean(body.hasMore));
  }

  async function loadMore() {
    setLoadingMore(true);
    setError(null);
    try {
      await loadUrls({ offset: urls.length, append: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadSnapshot();
        await loadReport();
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
      void loadReport();
      void loadUrls();
    });

    (async () => {
      try {
        await joinCrawlRun(connection, runId);
        if (!cancelled) setHubNote("SignalR connected");
      } catch {
        if (!cancelled) setHubNote(null);
      }
    })();

    return () => {
      cancelled = true;
      offEvent();
      void connection.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount once per runId
  }, [runId]);

  function downloadReportCsv() {
    const lines = [
      "seedUrl,pageCount,sitemapUrlCount,sitemapPathCount,status,statusDescription,crawlType,completed,failureReason",
    ];
    for (const row of reportRows) {
      lines.push(
        [
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
    a.download = `crawl-${runId}-report.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function downloadUrlsCsv() {
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
          <h2>Seed report</h2>
          <button
            type="button"
            onClick={downloadReportCsv}
            disabled={reportRows.length === 0}
          >
            Download report CSV
          </button>
        </div>
        <p className="muted">
          Sitemap totals from robots.txt / sitemap.xml. When a sitemap exists,
          the crawler treats it as the map (only those URLs). Path count strips
          query strings for reporting.
        </p>
        {reportLoading ? (
          <div className="panel">Building seed report…</div>
        ) : reportRows.length === 0 ? (
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
              </tr>
            </thead>
            <tbody>
              {reportRows.map((row) => (
                <tr key={row.seedUrl}>
                  <td>{row.seedUrl}</td>
                  <td>{row.pageCount}</td>
                  <td>{row.sitemapUrlCount ?? "—"}</td>
                  <td>{row.sitemapPathCount ?? "—"}</td>
                  <td>{row.status}</td>
                  <td>{row.statusDescription}</td>
                  <td>{row.crawlType}</td>
                  <td>{row.completed}</td>
                  <td>{row.failureReason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
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
          <button
            type="button"
            onClick={downloadUrlsCsv}
            disabled={urls.length === 0}
          >
            Download URL CSV
          </button>
        </div>
        {urls.length === 0 ? (
          <div className="panel">No URL rows yet (page-urls).</div>
        ) : (
          <>
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
            {hasMore ? (
              <button type="button" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
