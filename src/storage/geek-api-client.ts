/**
 * GeekAPI ingest client — one attempt, one canonical schema, no retries.
 * Auth: X-API-Key (GEEK_BACKEND_API_KEY) + X-Geek-User-Id (GEEK_USER_ID).
 */

import type { Block } from '../crawl/extract-content.js';
import { ConfigError, PersistenceError } from './errors.js';
import {
  MAX_BATCH_BODY_BYTES,
  MAX_LINKS_PER_BATCH,
  MAX_PAGE_DOCUMENT_BYTES,
  MAX_PAGES_PER_BATCH,
  applyHtmlOmit,
  estimatePageDocumentBytes,
} from './ingest-limits.js';

export type ApiRunSnapshot = {
  runId: string;
  crawlType: string;
  status: string;
  seedUrls?: string[];
};

export type CreatedPage = { url: string; pageId: string };

export type { Block } from '../crawl/extract-content.js';

export type IngestPageInput = {
  origin: string;
  url: string;
  finalUrl?: string | null;
  statusCode: number;
  robotsAllowed: boolean;
  html?: string | null;
  contentHtml?: string | null;
  /**
   * The same content as typed blocks, in document order. Optional on purpose: a
   * request_failed or robots-rejected page has no body at all, and requiring
   * this would turn every failure row into a validation error and take the
   * post-mortem with it.
   */
  blocks?: Block[];
  title?: string | null;
  excerpt?: string | null;
  failureReason?: string | null;
};

export { MAX_LINKS_PER_BATCH, MAX_PAGE_DOCUMENT_BYTES, MAX_BATCH_BODY_BYTES };

function env(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

export function requireGeekApiEnv(): {
  baseUrl: string;
  apiKey: string;
  userId: string;
} {
  const baseUrl = env('GEEK_API_URL')?.replace(/\/$/, '') ?? '';
  const apiKey = env('GEEK_BACKEND_API_KEY') ?? '';
  const userId = env('GEEK_USER_ID') ?? '';
  if (!baseUrl || !apiKey || !userId) {
    throw new ConfigError(
      'GEEK_API_URL, GEEK_BACKEND_API_KEY, and GEEK_USER_ID are required',
    );
  }
  return { baseUrl, apiKey, userId };
}

export function isGeekApiConfigured(): boolean {
  try {
    requireGeekApiEnv();
    return true;
  } catch {
    return false;
  }
}

/**
 * What a crawl did, as the crawler saw it.
 *
 * Excluded is not failed: a page skipped because robots.txt disallows it, or because it duplicates
 * a page already held in the primary language, is policy working. Counting those as errors makes a
 * healthy crawl look broken and buries the real failures under them.
 */
export type CrawlReport = {
  linksStored: number;
  excludedByPolicy: {
    robotsDisallowed: number;
    localeExcluded: number;
    /** Needs JavaScript to render. Out of scope for a static crawler, not broken. */
    requiresJavascript: number;
  };
  failed: {
    /** Transport: DNS, reset, timeout, non-2xx. */
    requestFailed: number;
    /** Bot detection served an interstitial. Retrying cannot fix it — kept separate for that reason. */
    challengePage: number;
    /** Fetched, but extraction produced nothing usable. */
    extractEmpty: number;
  };
  samples: Array<{ reason: string; url: string; detail?: string }>;
};

/**
 * present  GeekAPI answered and has the run.
 * absent   GeekAPI answered 404 - a newer crawl of this seed replaced it, or it
 *          was deleted. The only state that justifies removing local data.
 * unknown  No answer worth acting on. Never delete on this.
 */
export type RunPresence =
  | { kind: 'present' }
  | { kind: 'absent' }
  | { kind: 'unknown'; reason: string };

/**
 * Whether a 404 came from GeekAPI or from something in front of it.
 *
 * An allowlist, deliberately, and not a match on the proxy's wording. Railway can reword
 * "Application not found" whenever it likes; what will not change is that GeekAPI answers with its
 * own JSON error contract. So absence has to be proven, and everything unproven is unknown --
 * because unknown keeps the data and absent destroys it.
 *
 * Three conditions, all required:
 *   1. the status is 404 (the caller has established this),
 *   2. the content type is JSON, and
 *   3. the body parses and carries GeekAPI's error shape.
 *
 * An HTML error page, an empty body, a proxy's JSON that is not our contract, or a body that will
 * not parse all mean the same thing here: we did not hear from GeekAPI, so we do not know.
 */
async function classify404(res: Response): Promise<RunPresence> {
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.includes('application/json')) {
    return {
      kind: 'unknown',
      reason: `HTTP 404 with content-type ${contentType || '(none)'} — not GeekAPI's error shape, ` +
        'so the application may simply be unreachable',
    };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: 'unknown', reason: 'HTTP 404 with an unparseable JSON body' };
  }

  if (!isGeekApiError(body)) {
    return {
      kind: 'unknown',
      reason: `HTTP 404 from something that is not GeekAPI: ${JSON.stringify(body).slice(0, 200)}`,
    };
  }

  return { kind: 'absent' };
}

/**
 * GeekAPI's own error contract, as ASP.NET produces it.
 *
 * Railway's 404 body carries `status`, `code`, `message` and `request_id` and would pass a loose
 * check, so the discriminator is a field GeekAPI emits and the proxy does not: ProblemDetails'
 * `title`/`type`/`traceId`, or a bare string body from a `NotFound("...")`.
 */
function isGeekApiError(body: unknown): boolean {
  if (typeof body === 'string') return true;
  if (typeof body !== 'object' || body === null) return false;
  const o = body as Record<string, unknown>;
  if ('request_id' in o && 'code' in o && 'status' in o) return false; // platform proxy shape
  return 'title' in o || 'type' in o || 'traceId' in o || 'detail' in o || 'error' in o;
}

/**
 * Whether a non-2xx came from GeekAPI itself, rather than from something standing in front of it.
 *
 * Only a determinate answer justifies destroying a finished crawl. 4xx that GeekAPI produced --
 * 400 for pages with no extracted content, 409 for a run reported complete with nothing usable --
 * are its judgements and are final. A 5xx, or a 404 carrying a proxy's body, is the deployment
 * being absent; the crawl is likely fine and the data must be kept.
 *
 * An allowlist on purpose. Railway can reword "Application not found" at any time; what will not
 * change is that GeekAPI answers JSON in its own error shape.
 */
function answeredByGeekApi(res: Response, body: string): boolean {
  if (res.status >= 500) return false;
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.includes('application/json')) {
    // A bare string body from NotFound("...") or BadRequest("...") is still GeekAPI answering.
    return res.status < 500 && body.trim().length > 0 && !body.trimStart().startsWith('<');
  }
  try {
    const parsed = JSON.parse(body) as unknown;
    return isGeekApiError(parsed);
  } catch {
    return false;
  }
}

export class GeekApiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly userId: string;

  constructor(baseUrl?: string, apiKey?: string, userId?: string) {
    if (baseUrl !== undefined || apiKey !== undefined || userId !== undefined) {
      this.baseUrl = (baseUrl ?? '').replace(/\/$/, '');
      this.apiKey = apiKey ?? '';
      this.userId = userId ?? '';
      if (!this.baseUrl || !this.apiKey || !this.userId) {
        throw new ConfigError(
          'GEEK_API_URL, GEEK_BACKEND_API_KEY, and GEEK_USER_ID are required',
        );
      }
      return;
    }
    const required = requireGeekApiEnv();
    this.baseUrl = required.baseUrl;
    this.apiKey = required.apiKey;
    this.userId = required.userId;
  }

  /**
   * Whether GeekAPI still holds this run.
   *
   * Deliberately not routed through request(): that throws a PersistenceError
   * with the status folded into a message string, and deciding whether to
   * delete local data by matching on message text is exactly the kind of
   * inference this codebase keeps getting burned by. Everything except a 404 that
   * GeekAPI itself produced - transport failure, 5xx, an auth problem, a proxy
   * page - is unknown, and a caller must never treat unknown as gone.
   *
   * "An explicit 404 is absence" was the rule until 2026-09-30 and it cost 603
   * pages in one minute. Railway's edge answers 404 with
   * {"status":"error","code":404,"message":"Application not found","request_id":...}
   * when the application is not running, which is what a redeploy looks like from
   * out here. Three finished crawls - parseur 180 pages, quickbooks 81,
   * zoneandco 342 - read that as "the run was deleted" and purged themselves.
   * See classify404.
   */
  async runPresence(runId: string): Promise<RunPresence> {
    let res: Response;
    try {
      res = await fetch(
        `${this.baseUrl}/api/geek-crawler/crawls/${encodeURIComponent(runId)}`,
        {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'X-API-Key': this.apiKey,
            'X-Geek-User-Id': this.userId,
          },
        },
      );
    } catch (err) {
      return {
        kind: 'unknown',
        reason: `transport: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (res.ok) return { kind: 'present' };
    if (res.status === 404) return await classify404(res);
    return { kind: 'unknown', reason: `HTTP ${res.status}` };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          Accept: 'application/json',
          'X-API-Key': this.apiKey,
          'X-Geek-User-Id': this.userId,
        },
        body: payload,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // Never reached the sink at all. Says nothing about the run.
      throw new PersistenceError(`${method} ${path} → transport: ${detail.slice(0, 500)}`, {
        cause: err,
        unreachable: true,
      });
    }
    const text = await res.text();
    if (!res.ok) {
      throw new PersistenceError(formatIngestFailure(method, path, res.status, text), {
        unreachable: !answeredByGeekApi(res, text),
      });
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new PersistenceError(
        `${method} ${path} → invalid JSON acknowledgment: ${text.slice(0, 200)}`,
        { cause: err },
      );
    }
  }

  /**
   * Create the run. One attempt, one schema.
   *
   * This is the only ingest response that wraps the run: `{ run, seedsAccepted, rejected }`.
   * `patchRun` returns the snapshot flat. The envelope is read here, once, so nothing downstream
   * has to guess which shape it holds.
   *
   * A seed the server rejected is not a crawlable run — it would fetch nothing and report
   * complete — so a short seed acceptance fails the run here rather than at the first empty batch.
   */
  async createRun(input: { crawlType: string; seeds: string[] }): Promise<ApiRunSnapshot> {
    const ack = await this.request<{
      run?: ApiRunSnapshot;
      seedsAccepted?: number;
      rejected?: Array<{ url?: string; reason?: string }>;
    }>('POST', '/api/geek-crawler/ingest/runs', {
      crawlType: input.crawlType,
      seeds: input.seeds,
    });

    const run = ack?.run;
    const runId = typeof run?.runId === 'string' ? run.runId.trim() : '';
    if (!run || !runId) {
      throw new PersistenceError('runs acknowledgment missing run.runId');
    }
    if (ack.seedsAccepted !== input.seeds.length) {
      const rejected = Array.isArray(ack.rejected)
        ? ack.rejected
            .map((r) => `${r?.url ?? '?'}: ${r?.reason ?? 'rejected'}`)
            .join('; ')
            .slice(0, 300)
        : '';
      throw new PersistenceError(
        `runs accepted ${ack.seedsAccepted ?? 0} of ${input.seeds.length} seeds${rejected ? ` — ${rejected}` : ''}`,
      );
    }

    return {
      runId,
      crawlType: run.crawlType,
      status: run.status,
      seedUrls: run.seedUrls,
    };
  }

  patchRun(
    runId: string,
    patch: {
      status?: string;
      errorSummary?: string | null;
      hostProgressJson?: string | null;
      startedAtUtc?: string | null;
      completedAtUtc?: string | null;
      contentReadyAt?: string | null;
      clearContentReadyAt?: boolean;
      /**
       * Completion report. Sent only on a terminal transition.
       *
       * This crawler is the only component that sees each fetch, so its classification of why a
       * page did not become corpus is the authoritative one. It was written to local disk and never
       * transmitted, leaving GeekAPI to re-derive a cruder count from whatever arrived in a batch —
       * so "2,000 pages did not make it, why?" had no answer on the server at all.
       */
      report?: CrawlReport;
    },
  ): Promise<ApiRunSnapshot> {
    return this.request<ApiRunSnapshot>('PATCH', `/api/geek-crawler/ingest/runs/${runId}`, patch);
  }

  async createPagesBatch(runId: string, pages: IngestPageInput[]): Promise<CreatedPage[]> {
    if (pages.length === 0) {
      throw new PersistenceError('pages/batch must not be called with an empty pages array');
    }
    if (pages.length > MAX_PAGES_PER_BATCH) {
      throw new PersistenceError(
        `pages/batch size ${pages.length} exceeds atomic max ${MAX_PAGES_PER_BATCH}`,
      );
    }

    const prepared: IngestPageInput[] = [];
    for (const page of pages) {
      const omit = applyHtmlOmit(page);
      if (!omit.fits) {
        throw new PersistenceError(
          `pages/batch page_document_too_large url=${page.url} estimatedBytes=${omit.estimatedBytes} max=${MAX_PAGE_DOCUMENT_BYTES}`,
        );
      }
      if (omit.htmlOmittedBytes > 0) {
        console.info(
          JSON.stringify({
            event: 'ingest_html_omitted',
            runId,
            url: page.url,
            htmlOmittedBytes: omit.htmlOmittedBytes,
            estimatedBytes: omit.estimatedBytes,
          }),
        );
      }
      prepared.push({ ...page, html: omit.html });
    }

    const body = { pages: prepared };
    const bodyBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
    if (bodyBytes > MAX_BATCH_BODY_BYTES) {
      throw new PersistenceError(
        `pages/batch body ${bodyBytes} exceeds max ${MAX_BATCH_BODY_BYTES} (split before network)`,
      );
    }

    const result = await this.request<{
      pages?: Array<{ url?: string; pageId?: string }>;
    }>('POST', `/api/geek-crawler/ingest/runs/${runId}/pages/batch`, body);

    if (!result || !Array.isArray(result.pages)) {
      throw new PersistenceError('pages/batch acknowledgment missing pages array');
    }
    if (result.pages.length !== pages.length) {
      throw new PersistenceError(
        `pages/batch acknowledgment length ${result.pages.length} !== submitted ${pages.length}`,
      );
    }
    return result.pages.map((p, i) => {
      const pageId = typeof p.pageId === 'string' ? p.pageId.trim() : '';
      const url = typeof p.url === 'string' ? p.url : pages[i]!.url;
      if (!pageId) {
        throw new PersistenceError(`pages/batch acknowledgment missing pageId at index ${i}`);
      }
      return { url, pageId };
    });
  }

  async createLinksBatch(
    runId: string,
    links: Array<{
      pageId: string;
      fromUrl: string;
      linkUrl: string;
      isSameOrigin: boolean;
    }>,
  ): Promise<number> {
    if (links.length === 0) return 0;
    if (links.length > MAX_LINKS_PER_BATCH) {
      throw new PersistenceError(
        `links/batch size ${links.length} exceeds max ${MAX_LINKS_PER_BATCH}`,
      );
    }
    const body = { links };
    // The count cap is calibrated against this ceiling, not instead of it. Raising the
    // count without checking bytes only moves the failure: 10,000 links of ordinary
    // length is ~1.8 MiB, but 10,000 carrying long query strings can pass the count
    // check and still exceed what the server will accept, which surfaces as an opaque
    // transport error rather than a stated limit.
    const bodyBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
    if (bodyBytes > MAX_BATCH_BODY_BYTES) {
      throw new PersistenceError(
        `links/batch body ${bodyBytes} exceeds max ${MAX_BATCH_BODY_BYTES} ` +
          `(${links.length} links)`,
      );
    }
    const result = await this.request<{ count?: number }>(
      'POST',
      `/api/geek-crawler/ingest/runs/${runId}/links/batch`,
      body,
    );
    if (!result || typeof result.count !== 'number' || !Number.isFinite(result.count)) {
      throw new PersistenceError('links/batch acknowledgment missing numeric count');
    }
    if (result.count !== links.length) {
      throw new PersistenceError(
        `links/batch count ${result.count} !== submitted ${links.length}`,
      );
    }
    return result.count;
  }

  /**
   * Delete a run and its pages and links. One attempt, no retry.
   * Requires `DELETE /api/geek-crawler/ingest/runs/{runId}` on GeekAPI.
   *
   * The server reports what it purged as booleans, not row counts. Reporting counts it never sent
   * meant every delete claimed "0 pages, 0 links" no matter what it removed.
   */
  async deleteRun(
    runId: string,
  ): Promise<{ vectorsPurged: boolean; crawlDataDeleted: boolean }> {
    const result = await this.request<{
      vectorsPurged?: boolean;
      crawlDataDeleted?: boolean;
    }>('DELETE', `/api/geek-crawler/ingest/runs/${runId}`, undefined);

    if (typeof result?.crawlDataDeleted !== 'boolean') {
      throw new PersistenceError('delete acknowledgment missing crawlDataDeleted');
    }
    return {
      vectorsPurged: result.vectorsPurged === true,
      crawlDataDeleted: result.crawlDataDeleted,
    };
  }
}

/** GeekAPI is required — never returns null. */
export function createGeekApiClient(): GeekApiClient {
  return new GeekApiClient();
}

function formatIngestFailure(
  method: string,
  path: string,
  status: number,
  text: string,
): string {
  const snippet = text.slice(0, 500);
  try {
    const parsed = JSON.parse(text) as {
      error?: { code?: string; message?: string; requestId?: string };
    };
    const err = parsed?.error;
    if (err && typeof err === 'object') {
      const parts = [
        `${method} ${path} → ${status}`,
        err.code ? `code=${err.code}` : null,
        err.requestId ? `requestId=${err.requestId}` : null,
        err.message ?? snippet,
      ].filter(Boolean);
      return parts.join(': ');
    }
  } catch {
    // not JSON — fall through
  }
  return `${method} ${path} → ${status}: ${snippet}`;
}

/** Exported for tests / preflight callers. */
export { applyHtmlOmit, estimatePageDocumentBytes };
