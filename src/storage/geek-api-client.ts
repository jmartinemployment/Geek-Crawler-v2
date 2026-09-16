/**
 * GeekAPI ingest client — one attempt, one canonical schema, no retries.
 * Auth: X-API-Key (GEEK_BACKEND_API_KEY) + X-Geek-User-Id (GEEK_USER_ID).
 */

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

export type IngestPageInput = {
  origin: string;
  url: string;
  finalUrl?: string | null;
  statusCode: number;
  robotsAllowed: boolean;
  html?: string | null;
  markdown?: string | null;
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
      throw new PersistenceError(`${method} ${path} → transport: ${detail.slice(0, 500)}`, {
        cause: err,
      });
    }
    const text = await res.text();
    if (!res.ok) {
      throw new PersistenceError(formatIngestFailure(method, path, res.status, text));
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

  createRun(input: { crawlType: string; seeds: string[] }): Promise<ApiRunSnapshot> {
    return this.request<ApiRunSnapshot>('POST', '/api/geek-crawler/ingest/runs', {
      crawlType: input.crawlType,
      seeds: input.seeds,
    });
  }

  patchRun(
    runId: string,
    patch: {
      status?: string;
      errorSummary?: string | null;
      hostProgressJson?: string | null;
      startedAtUtc?: string | null;
      completedAtUtc?: string | null;
      markdownReadyAt?: string | null;
      clearMarkdownReadyAt?: boolean;
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
        `links/batch size ${links.length} exceeds atomic max ${MAX_LINKS_PER_BATCH}`,
      );
    }
    const result = await this.request<{ count?: number }>(
      'POST',
      `/api/geek-crawler/ingest/runs/${runId}/links/batch`,
      { links },
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
   */
  async deleteRun(runId: string): Promise<{ pagesDeleted: number; linksDeleted: number }> {
    const result = await this.request<{ pagesDeleted?: number; linksDeleted?: number }>(
      'DELETE',
      `/api/geek-crawler/ingest/runs/${runId}`,
      undefined,
    );
    return {
      pagesDeleted: typeof result?.pagesDeleted === 'number' ? result.pagesDeleted : 0,
      linksDeleted: typeof result?.linksDeleted === 'number' ? result.linksDeleted : 0,
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
