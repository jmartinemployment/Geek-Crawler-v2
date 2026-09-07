import { crawleeApiUrl, geekApiHeaders, geekApiUrl } from "@/lib/server-env";
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

/** Fail fast when Hostinger / GeekAPI is down so reports use local stubs. */
const GEEK_API_MS = 8_000;

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
  if (sitemapTotal > 0) {
    return `${Math.min(100, Math.round((100 * pageCount) / sitemapTotal))}%`;
  }
  if (s === "complete") return "100%";
  if (s === "failed" || s === "cancelled") return "0%";
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

type LocalRunStub = {
  runId: string;
  status: string;
  crawlType: string;
  seeds: string[];
  pagesSaved: number;
  errorSummary: string | null;
};

type GeekSnap = {
  status: string;
  crawlType: string;
  seedUrls: string[];
  hosts: HostRow[];
  errorSummary: string | null;
};

async function loadLocalRun(runId: string): Promise<LocalRunStub | null> {
  try {
    const res = await fetch(
      `${crawleeApiUrl()}/crawls/${encodeURIComponent(runId)}`,
      { cache: "no-store", signal: AbortSignal.timeout(5_000) },
    );
    if (!res.ok) return null;
    const body = await res.json();
    return {
      runId,
      status: String(body.status ?? ""),
      crawlType: String(body.crawlType ?? ""),
      seeds: Array.isArray(body.seeds) ? body.seeds.map(String) : [],
      pagesSaved: Number(body.pagesSaved ?? 0) || 0,
      errorSummary:
        typeof body.errorSummary === "string" ? body.errorSummary : null,
    };
  } catch {
    return null;
  }
}

async function loadGeekSnap(runId: string): Promise<GeekSnap | null> {
  try {
    const headers = geekApiHeaders();
    const res = await fetch(
      `${geekApiUrl()}/api/geek-crawler/crawls/${encodeURIComponent(runId)}`,
      {
        headers,
        cache: "no-store",
        signal: AbortSignal.timeout(GEEK_API_MS),
      },
    );
    if (!res.ok) return null;
    const snap = await res.json();
    return {
      status: String(snap.status ?? ""),
      crawlType: String(snap.crawlType ?? ""),
      seedUrls: Array.isArray(snap.seedUrls) ? snap.seedUrls.map(String) : [],
      hosts: Array.isArray(snap.hosts) ? snap.hosts : [],
      errorSummary:
        typeof snap.errorSummary === "string" ? snap.errorSummary : null,
    };
  } catch {
    return null;
  }
}

async function tallyPageUrlsByOrigin(
  runId: string,
): Promise<Map<string, number>> {
  const pageCountByOrigin = new Map<string, number>();
  let headers: HeadersInit;
  try {
    headers = geekApiHeaders();
  } catch {
    return pageCountByOrigin;
  }
  const base = geekApiUrl();
  let offset = 0;
  const limit = 500;
  for (;;) {
    let urlRes: Response;
    try {
      urlRes = await fetch(
        `${base}/api/geek-crawler/crawls/${encodeURIComponent(runId)}/page-urls?limit=${limit}&offset=${offset}`,
        {
          headers,
          cache: "no-store",
          signal: AbortSignal.timeout(GEEK_API_MS),
        },
      );
    } catch {
      break;
    }
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

async function tallyLocalPagesByOrigin(
  runId: string,
): Promise<Map<string, number>> {
  const pageCountByOrigin = new Map<string, number>();
  try {
    const res = await fetch(
      `${crawleeApiUrl()}/crawls/${encodeURIComponent(runId)}/pages`,
      { cache: "no-store", signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return pageCountByOrigin;
    const body = await res.json();
    const pages = Array.isArray(body.pages) ? body.pages : [];
    for (const page of pages) {
      const url = String(page.finalUrl ?? page.url ?? "");
      if (!url) continue;
      const key = originKey(url);
      pageCountByOrigin.set(key, (pageCountByOrigin.get(key) ?? 0) + 1);
    }
  } catch {
    /* empty local pages is normal in api-only persist mode */
  }
  return pageCountByOrigin;
}

/**
 * Build seed-report rows for one run.
 * Prefers GeekAPI when reachable; falls back to local Crawlee stubs so
 * Hostinger outages still produce seed rows (sitemap counts + local status).
 */
export async function buildSeedReportForRun(
  runId: string,
): Promise<{
  runId: string;
  status: string;
  crawlType: string;
  rows: SeedReportRow[];
  source: "geekapi" | "local" | "merged";
} | null> {
  const [local, geek] = await Promise.all([
    loadLocalRun(runId),
    loadGeekSnap(runId),
  ]);

  if (!local && !geek) return null;

  const status = geek?.status || local?.status || "";
  const crawlType = geek?.crawlType || local?.crawlType || "";
  const errorSummary = geek?.errorSummary ?? local?.errorSummary ?? null;
  const hosts = geek?.hosts ?? [];
  const hostByOrigin = new Map(
    hosts
      .filter((h) => h.origin)
      .map((h) => [originKey(String(h.origin)), h]),
  );

  let pageCountByOrigin = await tallyPageUrlsByOrigin(runId);
  if (pageCountByOrigin.size === 0) {
    pageCountByOrigin = await tallyLocalPagesByOrigin(runId);
  }

  const seeds =
    (geek?.seedUrls?.length ? geek.seedUrls : null) ||
    (local?.seeds?.length ? local.seeds : null) ||
    [...pageCountByOrigin.keys()].map(
      (k) => `https://${k.replace(/^https?:\/\//, "")}`,
    );

  if (seeds.length === 0) return null;

  const sitemapBySeed = new Map<
    string,
    Awaited<ReturnType<typeof countSitemapPages>>
  >();
  await mapPool(seeds, 2, async (seedUrl) => {
    const result = await countSitemapPages(seedUrl);
    sitemapBySeed.set(seedUrl, result);
  });

  const singleSeedLocalPages =
    seeds.length === 1 && local && local.pagesSaved > 0
      ? local.pagesSaved
      : null;

  const rows = seeds.map((seedUrl) => {
    const key = originKey(seedUrl);
    const host = hostByOrigin.get(key);
    const pageCount =
      pageCountByOrigin.get(key) ??
      host?.pagesWithHtml ??
      host?.pagesAttempted ??
      singleSeedLocalPages ??
      0;
    const sm = sitemapBySeed.get(seedUrl);
    const sitemapUrlCount = sm?.sitemapUrlCount ?? 0;
    const sitemapPathCount = sm?.sitemapPathCount ?? 0;
    const totalForPct = sitemapPathCount || sitemapUrlCount;
    const failureReason =
      host?.lastFailureReason ||
      errorSummary ||
      (sm?.error && sitemapUrlCount === 0 ? sm.error : null) ||
      (!geek ? "GeekAPI unreachable — local stub only" : null);
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

  const source: "geekapi" | "local" | "merged" =
    geek && local ? "merged" : geek ? "geekapi" : "local";

  return { runId, status, crawlType, rows, source };
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
