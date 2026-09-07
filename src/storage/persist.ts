import { createFilesystemRawBodyStore, type RawBodyStore } from './raw-body.js';
import { createGeekApiClient, isGeekApiConfigured, type GeekApiClient } from './geek-api-client.js';
import { createJsonRunStore, type CrawlLinkMeta, type CrawlPageMeta, type RunStore } from './runs.js';
import { computeSeedKey, normalizeSeeds, originOf } from './seed-key.js';
import type { CrawlType } from '../crawl/types.js';
import {
  bumpRejectCounter,
  emptyRejectCounters,
  RejectSampleLog,
  rejectStatsHostProgressEntry,
  type RejectCounters,
  type RejectReason,
} from '../crawl/reject.js';
import { randomUUID } from 'node:crypto';
import { log } from 'crawlee';

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
  mode: 'api' | 'local' | 'both';
  dataDir: string;
  /** Local mirrors (always created for Crawlee storage path; may be empty of HTML if api-only). */
  rawBodyStore: RawBodyStore;
  localMeta: RunStore;
  begin(): Promise<void>;
  /** Attach to an existing GeekAPI + local run (no createRun). */
  beginResume(): Promise<void>;
  markRunning(): Promise<void>;
  markComplete(): Promise<void>;
  markFailed(errorSummary: string): Promise<void>;
  /** Count + sample-log a reject; never persists page HTML. */
  noteReject(reason: RejectReason, url: string): void;
  savePage(page: PersistPageInput): Promise<{ pageId: string }>;
  saveLinks(pageId: string, links: CrawlLinkMeta[]): Promise<void>;
  stats(): Promise<
    {
      pagesSaved: number;
      linksSaved: number;
    } & RejectCounters
  >;
};

function keepLocalData(): boolean {
  return process.env.KEEP_LOCAL_DATA === '1' || process.env.KEEP_LOCAL_DATA === 'true';
}

export function createCrawlPersist(input: {
  runIdHint?: string;
  crawlType: CrawlType;
  seeds: string[];
  dataDir: string;
}): CrawlPersist {
  const seeds = normalizeSeeds(input.seeds);
  if (seeds.length === 0) throw new Error('No valid seed URLs');

  const api = createGeekApiClient();
  const mode: CrawlPersist['mode'] = api
    ? keepLocalData()
      ? 'both'
      : 'api'
    : 'local';

  const rawBodyStore = createFilesystemRawBodyStore(input.dataDir);
  const localMeta = createJsonRunStore(input.dataDir);
  const seedKey = computeSeedKey(seeds);

  let runId = input.runIdHint ?? randomUUID();
  let pagesSaved = 0;
  let linksSaved = 0;
  const rejectCounters = emptyRejectCounters();
  const rejectSamples = new RejectSampleLog();
  const client: GeekApiClient | null = api;

  async function flushRejectStatsToLocal(): Promise<void> {
    await localMeta.recordRejectStats(runId, {
      ...rejectCounters,
      rejectSamples: rejectSamples.snapshot(),
    });
  }

  return {
    get runId() {
      return runId;
    },
    mode,
    dataDir: input.dataDir,
    rawBodyStore,
    localMeta,

    async begin() {
      if (client) {
        const created = await client.createRun({
          crawlType: input.crawlType,
          seeds,
        });
        const id = String(created.runId ?? '');
        if (!id) throw new Error(`GeekAPI createRun returned no runId: ${JSON.stringify(created)}`);
        runId = id;
        console.log(
          `Persist mode=${mode} runId=${runId} seedKey=${seedKey.slice(0, 12)}… via GeekAPI → GeekRepository → Mongo`,
        );
      } else {
        console.log(
          `Persist mode=local (set GEEK_API_URL + GEEK_BACKEND_API_KEY + GEEK_USER_ID for Mongo via GeekAPI)`,
        );
      }

      // Always create a local run stub so concurrent local mirrors / GET /crawls/:id work.
      // HTML bodies are only written when mode is local|both.
      await localMeta.createRun({
        runId,
        crawlType: input.crawlType,
        seeds,
      });
    },

    async beginResume() {
      const existing = await localMeta.getRun(runId);
      if (!existing) {
        throw new Error(`Cannot resume — local run stub missing for ${runId}`);
      }
      if (client) {
        await client.patchRun(runId, {
          status: 'external',
          errorSummary: null,
          completedAtUtc: null,
          startedAtUtc: new Date().toISOString(),
        });
        console.log(
          `Resume persist mode=${mode} runId=${runId} — reusing GeekAPI run + Crawlee queue`,
        );
      } else {
        console.log(`Resume persist mode=local runId=${runId}`);
      }
    },

    async markRunning() {
      // Ingest create already sets status=external + startedAt on GeekAPI; keep that.
      // Local stub still tracks running for the thin localhost API.
      await localMeta.markRunning(runId);
    },

    async markComplete() {
      const completedAtUtc = new Date().toISOString();
      await flushRejectStatsToLocal();
      if (client) {
        await client.patchRun(runId, {
          status: 'complete',
          completedAtUtc,
          // Array form required by GeekAPI snapshot deserializer; synthetic origin carries rejects.
          hostProgressJson: JSON.stringify([
            rejectStatsHostProgressEntry(rejectCounters, pagesSaved),
          ]),
        });
      }
      await localMeta.markComplete(runId);
    },

    async markFailed(errorSummary: string) {
      const completedAtUtc = new Date().toISOString();
      await flushRejectStatsToLocal();
      if (client) {
        await client.patchRun(runId, {
          status: 'failed',
          errorSummary,
          completedAtUtc,
          hostProgressJson: JSON.stringify([
            rejectStatsHostProgressEntry(rejectCounters, pagesSaved),
          ]),
        });
      }
      await localMeta.markFailed(runId, errorSummary);
    },

    noteReject(reason, url) {
      bumpRejectCounter(rejectCounters, reason);
      const sampled = rejectSamples.note(reason, url);
      if (sampled) {
        log.info(`Reject ${reason}: ${sampled}`);
      }
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
        const n = await client.createLinksBatch(
          runId,
          links.map((l) => ({
            pageId,
            fromUrl: l.fromUrl,
            linkUrl: l.linkUrl,
            isSameOrigin: l.isSameOrigin,
          })),
        );
        linksSaved += n;
      }
      if (mode !== 'api') {
        await localMeta.insertLinks(runId, links);
        linksSaved += links.length;
      }
    },

    async stats() {
      return { pagesSaved, linksSaved, ...rejectCounters };
    },
  };
}

export { isGeekApiConfigured };
