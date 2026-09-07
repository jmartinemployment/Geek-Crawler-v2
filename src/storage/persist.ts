import { randomUUID } from 'node:crypto';
import { createGeekApiClient, tryCreateGeekApiClientFromEnv, type GeekApiClient } from './geek-api-client.js';
import { createFilesystemRawBodyStore } from './raw-body.js';
import { createJsonRunStore, type CrawlPageMeta, type CrawlRunMeta } from './runs.js';

export type PersistMode = 'api' | 'local' | 'both';

export type PersistPageInput = {
  url: string;
  finalUrl?: string;
  statusCode?: number;
  html?: string;
  /** Clean article markdown (Readability + Turndown). */
  markdown?: string | null;
  title?: string | null;
  excerpt?: string | null;
  robotsAllowed: boolean;
  failureReason?: string;
  fetchMode: 'cheerio' | 'playwright';
};

export type CrawlPersist = {
  runId: string;
  mode: PersistMode;
  dataDir: string;
  begin(): Promise<void>;
  beginResume(): Promise<void>;
  markRunning(): Promise<void>;
  markComplete(): Promise<void>;
  markFailed(message: string): Promise<void>;
  savePage(page: PersistPageInput): Promise<{ pageId: string }>;
  saveLinks(
    pageId: string,
    links: Array<{ fromUrl: string; linkUrl: string; isSameOrigin: boolean }>,
  ): Promise<void>;
  stats(): Promise<{ pagesSaved: number; linksSaved: number }>;
};

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function resolveMode(): PersistMode {
  const client = tryCreateGeekApiClientFromEnv();
  if (!client) return 'local';
  if (process.env.KEEP_LOCAL_DATA === '1' || process.env.KEEP_LOCAL_DATA === 'true') {
    return 'both';
  }
  return 'api';
}

export function createCrawlPersist(input: {
  runIdHint?: string;
  crawlType: string;
  seeds: string[];
  dataDir: string;
}): CrawlPersist {
  const dataDir = input.dataDir;
  const mode = resolveMode();
  const localMeta = createJsonRunStore(dataDir);
  const rawBodyStore = createFilesystemRawBodyStore(dataDir);
  const client: GeekApiClient | null =
    mode === 'local' ? null : tryCreateGeekApiClientFromEnv();

  let runId = input.runIdHint ?? randomUUID();
  let pagesSaved = 0;
  let linksSaved = 0;
  let stub: CrawlRunMeta = {
    runId,
    crawlType: input.crawlType,
    seeds: input.seeds,
    status: 'pending',
    createdAtUtc: new Date().toISOString(),
  };

  async function syncLocal() {
    if (mode === 'api') {
      // Still keep a thin local stub so resume-by-url / list works offline.
    }
    await localMeta.upsertRun({ ...stub, pagesSaved, linksSaved });
  }

  return {
    get runId() {
      return runId;
    },
    mode,
    dataDir,

    async begin() {
      if (client) {
        const created = await client.createRun({
          crawlType: input.crawlType,
          seeds: input.seeds,
        });
        runId = created.id;
        stub = { ...stub, runId };
      }
      stub.status = 'pending';
      stub.createdAtUtc = new Date().toISOString();
      await syncLocal();
    },

    async beginResume() {
      runId = input.runIdHint ?? runId;
      const existing = await localMeta.getRun(runId);
      if (existing) stub = existing;
      else {
        stub = {
          runId,
          crawlType: input.crawlType,
          seeds: input.seeds,
          status: 'running',
          createdAtUtc: new Date().toISOString(),
        };
      }
      await syncLocal();
    },

    async markRunning() {
      stub.status = 'running';
      stub.startedAtUtc = new Date().toISOString();
      if (client) {
        await client.patchRun(runId, {
          status: 'external',
          startedAtUtc: stub.startedAtUtc,
        });
      }
      await syncLocal();
    },

    async markComplete() {
      stub.status = 'complete';
      stub.completedAtUtc = new Date().toISOString();
      if (client) {
        await client.patchRun(runId, {
          status: 'complete',
          completedAtUtc: stub.completedAtUtc,
        });
      }
      await syncLocal();
    },

    async markFailed(message: string) {
      stub.status = 'failed';
      stub.errorSummary = message.slice(0, 2000);
      stub.completedAtUtc = new Date().toISOString();
      if (client) {
        await client.patchRun(runId, {
          status: 'failed',
          errorSummary: stub.errorSummary,
          completedAtUtc: stub.completedAtUtc,
        });
      }
      await syncLocal();
    },

    async savePage(page) {
      let pageId: string = randomUUID();
      const origin = originOf(page.finalUrl || page.url);

      if (client) {
        const created = await client.createPagesBatch(runId, [
          {
            origin,
            url: page.url,
            finalUrl: page.finalUrl ?? page.url,
            statusCode: page.statusCode ?? 0,
            robotsAllowed: page.robotsAllowed,
            html: page.html ?? null,
            markdown: page.markdown ?? null,
            title: page.title ?? null,
            excerpt: page.excerpt ?? null,
            failureReason: page.failureReason ?? null,
          },
        ]);
        if (created[0]?.pageId) pageId = created[0].pageId;
      }

      if (mode !== 'api') {
        let bodyKey = '';
        let markdownBodyKey: string | undefined;
        if (page.html) {
          bodyKey = await rawBodyStore.put(runId, page.url, page.html);
        }
        if (page.markdown) {
          markdownBodyKey = await rawBodyStore.putMarkdown(
            runId,
            page.url,
            page.markdown,
          );
        }
        const metaPage: CrawlPageMeta = {
          url: page.url,
          finalUrl: page.finalUrl,
          statusCode: page.statusCode,
          bodyKey,
          markdownBodyKey,
          title: page.title ?? undefined,
          fetchMode: page.fetchMode,
          robotsAllowed: page.robotsAllowed,
          crawledAtUtc: new Date().toISOString(),
          failureReason: page.failureReason,
        };
        await localMeta.insertPage(runId, metaPage);
      }

      pagesSaved += 1;
      return { pageId };
    },

    async saveLinks(pageId, links) {
      if (links.length === 0) return;
      if (client) {
        await client.createLinksBatch(
          runId,
          links.map((l) => ({
            pageId,
            fromUrl: l.fromUrl,
            linkUrl: l.linkUrl,
            isSameOrigin: l.isSameOrigin,
          })),
        );
      }
      linksSaved += links.length;
    },

    async stats() {
      return { pagesSaved, linksSaved };
    },
  };
}

// Re-export for tests / scripts that construct clients explicitly.
export { createGeekApiClient };
