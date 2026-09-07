/**
 * Backfill Title/Markdown/Excerpt on existing GeekAPI pages (HTML → Readability → Turndown).
 * Requires GeekBackend markdown-backfill endpoint (see plans/backend-markdown-backfill/).
 */

import {
  createGeekApiClient,
  tryCreateGeekApiClientFromEnv,
  type GeekApiClient,
  type GeekApiPage,
} from '../storage/geek-api-client.js';
import { extractCleanContent } from './extract-content.js';
import { shouldExcludeLocalePath } from './locale-path.js';

export type BackfillTotals = {
  scanned: number;
  updated: number;
  skipped_no_html: number;
  skipped_has_markdown: number;
  skipped_locale: number;
  skipped_robots: number;
  extract_failed: number;
  errors: number;
};

export type BackfillOptions = {
  client: GeekApiClient;
  runIds: string[];
  dryRun: boolean;
  pageLimit?: number;
  /** Max pages to process across all runs (0 = unlimited). */
  maxPages?: number;
  sampleLimit?: number;
  onSample?: (sample: {
    runId: string;
    pageId: string;
    url: string;
    title: string | null;
    markdownPreview: string;
  }) => void;
};

const DEFAULT_PAGE_LIMIT = 50;

function pageIdOf(p: GeekApiPage): string {
  return String((p as { id?: string; Id?: string }).id ?? (p as { Id?: string }).Id ?? '');
}

function markdownOf(p: GeekApiPage): string | null | undefined {
  const m =
    p.markdown ??
    (p as { Markdown?: string | null }).Markdown;
  return m;
}

function htmlOf(p: GeekApiPage): string | null | undefined {
  return p.html ?? (p as { Html?: string | null }).Html;
}

function robotsOf(p: GeekApiPage): boolean {
  if (typeof p.robotsAllowed === 'boolean') return p.robotsAllowed;
  const v = (p as { RobotsAllowed?: boolean }).RobotsAllowed;
  return v !== false;
}

function urlOf(p: GeekApiPage): string {
  return (
    p.finalUrl ||
    (p as { FinalUrl?: string }).FinalUrl ||
    p.url ||
    (p as { Url?: string }).Url ||
    ''
  );
}

export async function backfillMarkdownForRuns(
  options: BackfillOptions,
): Promise<BackfillTotals> {
  const totals: BackfillTotals = {
    scanned: 0,
    updated: 0,
    skipped_no_html: 0,
    skipped_has_markdown: 0,
    skipped_locale: 0,
    skipped_robots: 0,
    extract_failed: 0,
    errors: 0,
  };

  const pageLimit = options.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const maxPages = options.maxPages ?? 0;
  const sampleLimit = options.sampleLimit ?? 10;
  let samples = 0;
  let processed = 0;

  for (const runId of options.runIds) {
    let offset = 0;
    for (;;) {
      if (maxPages > 0 && processed >= maxPages) return totals;

      let pages: GeekApiPage[];
      try {
        pages = await options.client.listPages(runId, pageLimit, offset);
      } catch (err) {
        totals.errors += 1;
        console.error(`listPages failed run=${runId} offset=${offset}:`, err);
        break;
      }

      if (!pages.length) break;

      const batch: Array<{
        pageId: string;
        title?: string | null;
        markdown?: string | null;
        excerpt?: string | null;
      }> = [];

      for (const page of pages) {
        if (maxPages > 0 && processed >= maxPages) break;
        totals.scanned += 1;
        processed += 1;

        const pageId = pageIdOf(page);
        const url = urlOf(page);
        const html = htmlOf(page);
        const existingMd = markdownOf(page);

        if (!robotsOf(page)) {
          totals.skipped_robots += 1;
          continue;
        }
        if (!html || html.length < 40) {
          totals.skipped_no_html += 1;
          continue;
        }
        if (existingMd && existingMd.trim().length > 0) {
          totals.skipped_has_markdown += 1;
          continue;
        }
        if (url && shouldExcludeLocalePath(url)) {
          totals.skipped_locale += 1;
          continue;
        }

        const clean = extractCleanContent(html, url || 'https://example.com/');
        if (!clean.markdown) {
          totals.extract_failed += 1;
          continue;
        }

        if (samples < sampleLimit && options.onSample) {
          options.onSample({
            runId,
            pageId,
            url,
            title: clean.title,
            markdownPreview: clean.markdown.slice(0, 240),
          });
          samples += 1;
        }

        batch.push({
          pageId,
          title: clean.title,
          markdown: clean.markdown,
          excerpt: clean.excerpt,
        });
      }

      if (batch.length > 0) {
        if (options.dryRun) {
          totals.updated += batch.length;
        } else {
          try {
            const result = await options.client.markdownBackfill(runId, batch);
            totals.updated += result.count;
          } catch (err) {
            totals.errors += 1;
            console.error(`markdownBackfill failed run=${runId}:`, err);
          }
        }
      }

      offset += pages.length;
      if (pages.length < pageLimit) break;
    }
  }

  return totals;
}

export async function resolveBackfillRunIds(options: {
  client: GeekApiClient;
  runId?: string;
  allRuns?: boolean;
  limit?: number;
}): Promise<string[]> {
  if (options.runId) return [options.runId];
  if (!options.allRuns) {
    throw new Error('Pass --run-id <guid> or --all-runs');
  }
  const runs = await options.client.listRuns(options.limit ?? 50);
  return runs
    .map((r) => String((r as { id?: string }).id ?? (r as { Id?: string }).Id ?? ''))
    .filter(Boolean);
}

export function createBackfillClientFromEnv(): GeekApiClient {
  const client = tryCreateGeekApiClientFromEnv();
  if (!client) {
    throw new Error(
      'Set GEEK_API_URL, GEEK_BACKEND_API_KEY, and GEEK_USER_ID (or pass --base-url/--api-key/--user-id)',
    );
  }
  return client;
}

export function createBackfillClientExplicit(input: {
  baseUrl: string;
  apiKey: string;
  userId: string;
}): GeekApiClient {
  return createGeekApiClient(input);
}
