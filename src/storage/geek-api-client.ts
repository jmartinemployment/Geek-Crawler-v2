/**
 * GeekAPI ingest client — Crawlee → GeekAPI → GeekRepository → Mongo.
 * Auth: X-API-Key (GEEK_BACKEND_API_KEY) + X-Geek-User-Id (GEEK_USER_ID).
 */

export type ApiRunSnapshot = {
  runId: string;
  crawlType: string;
  status: string;
  seedUrls?: string[];
};

export type CreatedPage = { url: string; pageId: string };

function env(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

export function isGeekApiConfigured(): boolean {
  return Boolean(env('GEEK_API_URL') && env('GEEK_BACKEND_API_KEY') && env('GEEK_USER_ID'));
}

export class GeekApiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly userId: string;

  constructor(
    baseUrl = env('GEEK_API_URL'),
    apiKey = env('GEEK_BACKEND_API_KEY'),
    userId = env('GEEK_USER_ID'),
  ) {
    this.baseUrl = (baseUrl ?? '').replace(/\/$/, '');
    this.apiKey = apiKey ?? '';
    this.userId = userId ?? '';
    if (!this.baseUrl || !this.apiKey || !this.userId) {
      throw new Error('GEEK_API_URL, GEEK_BACKEND_API_KEY, and GEEK_USER_ID are required');
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        Accept: 'application/json',
        'X-API-Key': this.apiKey,
        'X-Geek-User-Id': this.userId,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
    }
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
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
    },
  ): Promise<ApiRunSnapshot> {
    return this.request<ApiRunSnapshot>('PATCH', `/api/geek-crawler/ingest/runs/${runId}`, patch);
  }

  async createPagesBatch(
    runId: string,
    pages: Array<{
      origin: string;
      url: string;
      finalUrl?: string | null;
      statusCode: number;
      robotsAllowed: boolean;
      html?: string | null;
      /** Clean markdown — requires GeekAPI/Repo schema support (ignored until then). */
      markdown?: string | null;
      title?: string | null;
      excerpt?: string | null;
      failureReason?: string | null;
    }>,
  ): Promise<CreatedPage[]> {
    const result = await this.request<{
      count?: number;
      Count?: number;
      pages?: Array<{ url?: string; Url?: string; pageId?: string; PageId?: string }>;
      Pages?: Array<{ url?: string; Url?: string; pageId?: string; PageId?: string }>;
    }>('POST', `/api/geek-crawler/ingest/runs/${runId}/pages/batch`, { pages });

    const list = result.pages ?? result.Pages ?? [];
    return list.map((p) => ({
      url: String(p.url ?? p.Url ?? ''),
      pageId: String(p.pageId ?? p.PageId ?? ''),
    }));
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
    const result = await this.request<{ count?: number; Count?: number }>(
      'POST',
      `/api/geek-crawler/ingest/runs/${runId}/links/batch`,
      { links },
    );
    return result.count ?? result.Count ?? links.length;
  }
}

export function createGeekApiClient(): GeekApiClient | null {
  if (!isGeekApiConfigured()) return null;
  return new GeekApiClient();
}
