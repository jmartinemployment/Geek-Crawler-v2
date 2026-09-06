import { geekApiHeaders, geekApiUrl } from "@/lib/server-env";
import { countSitemapPages } from "@/lib/sitemap-count";

export type HostRow = {
  origin?: string;
  pagesAttempted?: number;
  pagesWithHtml?: number;
  lastFailureReason?: string | null;
  pagesInQueue?: number | null;
  inFlightCount?: number | null;
};

export type UrlRow = { origin?: string; url?: string; hasHtml?: boolean };

export type SeedReportRow = {
  runId: string;
  seedUrl: string;
  pageCount: number;
  /** Unique sitemap URLs (with query strings). */
  sitemapUrlCount: number;
  /** Unique sitemap paths (query stripped) — closer to “distinct pages”. */
  sitemapPathCount: number;
  status: string;
  statusDescription: string;
  crawlType: string;
  completed: string;
  failureReason: string | null;
};

export function statusDescription(status: string): string {
  switch (status.toLowerCase()) {
    case "external":
      return "External crawler (Crawlee) owns this run";
    case "complete":
      return "Crawl finished successfully";
    case "failed":
      return "Crawl failed";
    case "cancelled":
      return "Crawl cancelled";
    case "running":
      return "Crawl in progress";
    case "pending":
      return "Waiting to start";
    default:
      return status || "Unknown";
  }
}

export function originKey(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.hostname.replace(/^www\./i, "").toLowerCase()}`;
  } catch {
    return raw.trim().toLowerCase();
  }
}

export function completedLabel(
  status: string,
  host: HostRow | undefined,
  pageCount: number,
  sitemapTotal: number,
): string {
  const s = status.toLowerCase();
  if (s === "complete") return "100%";
  if (s === "failed" || s === "cancelled") return "0%";
  if (sitemapTotal > 0) {
    return `${Math.min(100, Math.round((100 * pageCount) / sitemapTotal))}%`;
  }
  if (host?.pagesAttempted && host.pagesAttempted > 0) {
    const pct = Math.round(
      (100 * (host.pagesWithHtml ?? 0)) / host.pagesAttempted,
    );
    return `${pct}%`;
  }
  if (s === "external" || s === "running") {
    return pageCount > 0 ? "In progress" : "0%";
  }
  return "—";
}

async function tallyPageUrlsByOrigin(
  runId: string,
  headers: HeadersInit,
  base: string,
): Promise<Map<string, number>> {
  const pageCountByOrigin = new Map<string, number>();
  let offset = 0;
  const limit = 500;
  for (;;) {
    const urlRes = await fetch(
      `${base}/api/geek-crawler/crawls/${encodeURIComponent(runId)}/page-urls?limit=${limit}&offset=${offset}`,
      { headers, cache: "no-store" },
    );
    if (!urlRes.ok) break;
    const chunk = (await urlRes.json()) as UrlRow[];
    if (!Array.isArray(chunk) || chunk.length === 0) break;
    for (const row of chunk) {
      const origin = row.origin || row.url || "";
      if (!origin) continue;
      const key = originKey(origin);
      pageCountByOrigin.set(key, (pageCountByOrigin.get(key) ?? 0) + 1);
    }
    if (chunk.length < limit) break;
    offset += limit;
    if (offset > 100_000) break;
  }
  return pageCountByOrigin;
}

/** Build seed-report rows for one GeekAPI run. Returns null if snapshot missing. */
export async function buildSeedReportForRun(
  runId: string,
): Promise<{
  runId: string;
  status: string;
  crawlType: string;
  rows: SeedReportRow[];
} | null> {
  const headers = geekApiHeaders();
  const base = geekApiUrl();

  const snapRes = await fetch(
    `${base}/api/geek-crawler/crawls/${encodeURIComponent(runId)}`,
    { headers, cache: "no-store" },
  );
  if (!snapRes.ok) return null;

  const snap = await snapRes.json();
  const status = String(snap.status ?? "");
  const crawlType = String(snap.crawlType ?? "");
  const errorSummary =
    typeof snap.errorSummary === "string" ? snap.errorSummary : null;
  const seedUrls: string[] = Array.isArray(snap.seedUrls)
    ? snap.seedUrls.map(String)
    : [];
  const hosts: HostRow[] = Array.isArray(snap.hosts) ? snap.hosts : [];
  const hostByOrigin = new Map(
    hosts
      .filter((h) => h.origin)
      .map((h) => [originKey(String(h.origin)), h]),
  );

  const pageCountByOrigin = await tallyPageUrlsByOrigin(runId, headers, base);

  const seeds =
    seedUrls.length > 0
      ? seedUrls
      : [...pageCountByOrigin.keys()].map(
          (k) => `https://${k.replace(/^https?:\/\//, "")}`,
        );

  // Sitemap fetches are network-bound; cap concurrency per run.
  const sitemapBySeed = new Map<
    string,
    Awaited<ReturnType<typeof countSitemapPages>>
  >();
  await mapPool(seeds, 2, async (seedUrl) => {
    const result = await countSitemapPages(seedUrl);
    sitemapBySeed.set(seedUrl, result);
  });

  const rows = seeds.map((seedUrl) => {
    const key = originKey(seedUrl);
    const host = hostByOrigin.get(key);
    const pageCount =
      pageCountByOrigin.get(key) ??
      host?.pagesWithHtml ??
      host?.pagesAttempted ??
      0;
    const sm = sitemapBySeed.get(seedUrl);
    const sitemapUrlCount = sm?.sitemapUrlCount ?? 0;
    const sitemapPathCount = sm?.sitemapPathCount ?? 0;
    // Prefer path count for “total pages” / % complete (ignores ?query variants).
    const totalForPct = sitemapPathCount || sitemapUrlCount;
    const failureReason =
      host?.lastFailureReason ||
      errorSummary ||
      (sm?.error && sitemapUrlCount === 0 ? sm.error : null) ||
      null;
    return {
      runId,
      seedUrl,
      pageCount,
      sitemapUrlCount,
      sitemapPathCount,
      status,
      statusDescription: statusDescription(status),
      crawlType,
      completed: completedLabel(status, host, pageCount, totalForPct),
      failureReason,
    };
  });

  return { runId, status, crawlType, rows };
}

/** Run async work with a concurrency cap. */
export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}
