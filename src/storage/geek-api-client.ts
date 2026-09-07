/**
 * GeekAPI ingest client for external Crawlee runs.
 * Auth: X-API-Key + X-Geek-User-Id
 */

export type CreatedPage = { url: string; pageId: string };

export type GeekApiPage = {
  id: string;
  runId: string;
  origin: string;
  url: string;
  finalUrl: string;
  statusCode: number;
  robotsAllowed: boolean;
  html?: string | null;
  title?: string | null;
  markdown?: string | null;
  excerpt?: string | null;
  markdownBackfilledAt?: string | null;
  failureReason?: string | null;
  crawledAtUtc: string;
};

export type GeekApiRun = {
  id: string;
  ownerUserId: string;
  crawlType: string;
  status: string;
  seedUrlsJson: string;
  createdAtUtc: string;
};

export type GeekApiClient = {
  baseUrl: string;
  createRun(input: { crawlType: string; seeds: string[] }): Promise<{ id: string }>;
  patchRun(
    runId: string,
    patch: {
      status?: string;
      errorSummary?: string;
      hostProgressJson?: string;
      startedAtUtc?: string;
      completedAtUtc?: string;
    },
  ): Promise<void>;
  createPagesBatch(
    runId: string,
    pages: Array<{
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
    }>,
  ): Promise<CreatedPage[]>;
  createLinksBatch(
    runId: string,
    links: Array<{
      pageId: string;
      fromUrl: string;
      linkUrl: string;
      isSameOrigin: boolean;
    }>,
  ): Promise<void>;
  listPages(runId: string, limit: number, offset: number): Promise<GeekApiPage[]>;
  listRuns(limit?: number): Promise<GeekApiRun[]>;
  markdownBackfill(
    runId: string,
    pages: Array<{
      pageId: string;
      title?: string | null;
      markdown?: string | null;
      excerpt?: string | null;
    }>,
  ): Promise<{ count: number; requested: number }>;
};

function headers(apiKey: string, userId: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'X-API-Key': apiKey,
    'X-Geek-User-Id': userId,
  };
}

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GeekAPI ${res.status}: ${text.slice(0, 500)}`);
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export function createGeekApiClient(options: {
  baseUrl: string;
  apiKey: string;
  userId: string;
}): GeekApiClient {
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  const h = headers(options.apiKey, options.userId);

  return {
    baseUrl,

    async createRun(input) {
      const res = await fetch(`${baseUrl}/api/geek-crawler/ingest/runs`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ crawlType: input.crawlType, seeds: input.seeds }),
      });
      const body = await readJson<{ id?: string; runId?: string }>(res);
      const id = body.id ?? body.runId;
      if (!id) throw new Error('GeekAPI createRun missing id');
      return { id };
    },

    async patchRun(runId, patch) {
      const res = await fetch(`${baseUrl}/api/geek-crawler/ingest/runs/${runId}`, {
        method: 'PATCH',
        headers: h,
        body: JSON.stringify(patch),
      });
      await readJson(res);
    },

    async createPagesBatch(runId, pages) {
      const res = await fetch(
        `${baseUrl}/api/geek-crawler/ingest/runs/${runId}/pages/batch`,
        {
          method: 'POST',
          headers: h,
          body: JSON.stringify({ pages }),
        },
      );
      const body = await readJson<{
        pages?: Array<{ url: string; pageId: string }>;
        Pages?: Array<{ Url: string; PageId: string }>;
      }>(res);
      const list = body.pages ?? body.Pages ?? [];
      return list.map((p) => ({
        url: 'url' in p ? p.url : (p as { Url: string }).Url,
        pageId: 'pageId' in p ? String(p.pageId) : String((p as { PageId: string }).PageId),
      }));
    },

    async createLinksBatch(runId, links) {
      const res = await fetch(
        `${baseUrl}/api/geek-crawler/ingest/runs/${runId}/links/batch`,
        {
          method: 'POST',
          headers: h,
          body: JSON.stringify({ links }),
        },
      );
      await readJson(res);
    },

    async listPages(runId, limit, offset) {
      const res = await fetch(
        `${baseUrl}/api/geek-crawler/crawls/${runId}/pages?limit=${limit}&offset=${offset}`,
        { headers: h },
      );
      const body = await readJson<GeekApiPage[] | { pages?: GeekApiPage[] }>(res);
      return Array.isArray(body) ? body : (body.pages ?? []);
    },

    async listRuns(limit = 50) {
      const res = await fetch(`${baseUrl}/api/geek-crawler/crawls?limit=${limit}`, {
        headers: h,
      });
      const body = await readJson<GeekApiRun[] | { runs?: GeekApiRun[] }>(res);
      return Array.isArray(body) ? body : (body.runs ?? []);
    },

    async markdownBackfill(runId, pages) {
      const res = await fetch(
        `${baseUrl}/api/geek-crawler/ingest/runs/${runId}/pages/markdown-backfill`,
        {
          method: 'POST',
          headers: h,
          body: JSON.stringify({ pages }),
        },
      );
      const body = await readJson<{ count?: number; requested?: number; Count?: number; Requested?: number }>(
        res,
      );
      return {
        count: body.count ?? body.Count ?? 0,
        requested: body.requested ?? body.Requested ?? pages.length,
      };
    },
  };
}

export function tryCreateGeekApiClientFromEnv(): GeekApiClient | null {
  const baseUrl = process.env.GEEK_API_URL?.trim();
  const apiKey = process.env.GEEK_BACKEND_API_KEY?.trim();
  const userId = process.env.GEEK_USER_ID?.trim();
  if (!baseUrl || !apiKey || !userId) return null;
  return createGeekApiClient({ baseUrl, apiKey, userId });
}
