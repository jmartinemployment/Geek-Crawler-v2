/**
 * Local extract cache: the clean fragment and the typed blocks, on disk.
 *
 * Diagnostics, never authority. Nothing reads this to decide what to crawl,
 * resume or dedup, and nothing ingests from it. It exists so a chunker can be
 * tuned offline: re-run the chunking a thousand times against a saved corpus
 * instead of re-fetching freshbooks.com a thousand times.
 *
 * Deliberately outside `runs/`, which a failed or cancelled run purges. Every
 * run fails while GeekAPI still rejects `contentHtml`, so a run-scoped cache
 * would be destroyed on exactly the crawls worth inspecting. This sits beside
 * `failures/` instead, which survives a purge for the same reason.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Block } from '../crawl/extract-content.js';

export type ExtractCache = {
  /** Write both files for one page. Returns the relative key, or null when off. */
  put(runId: string, url: string, contentHtml: string | null, blocks: Block[]): Promise<string | null>;
  enabled: boolean;
  rootDir: string;
};

function urlKey(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 24);
}

/** Off with EXTRACT_CACHE=0. On otherwise — a crawl is expensive, disk is not. */
function cacheEnabled(): boolean {
  return (process.env.EXTRACT_CACHE ?? '1').trim() !== '0';
}

export function createExtractCache(dataDir: string): ExtractCache {
  const rootDir = path.join(path.resolve(dataDir), 'extract-cache');
  const enabled = cacheEnabled();

  return {
    enabled,
    rootDir,
    async put(runId, url, contentHtml, blocks) {
      if (!enabled) return null;
      if (!contentHtml && blocks.length === 0) return null;

      const dir = path.join(rootDir, runId);
      await mkdir(dir, { recursive: true });
      const key = urlKey(url);

      // The URL is written alongside, because a sha256 prefix is not a page.
      const manifest = { url, runId, blocks: blocks.length, at: new Date().toISOString() };
      await Promise.all([
        contentHtml
          ? writeFile(path.join(dir, `${key}.content.html`), contentHtml, 'utf8')
          : Promise.resolve(),
        writeFile(path.join(dir, `${key}.blocks.json`), JSON.stringify(blocks), 'utf8'),
        writeFile(path.join(dir, `${key}.meta.json`), JSON.stringify(manifest), 'utf8'),
      ]);

      return path.posix.join('extract-cache', runId, key);
    },
  };
}

/**
 * Reading the corpus back.
 *
 * Deliberately plain functions rather than methods on ExtractCache: the writer
 * is gated by EXTRACT_CACHE, and a reader must not be. Turning caching off for
 * the next crawl is no reason to be unable to read the corpus already on disk —
 * analysing what is there and deciding what to write next are separate acts.
 *
 * Every read fails silently. A missing directory, an unreadable file or a
 * truncated JSON document yields an empty result or a skipped page, never a
 * throw: a diagnostics cache that can crash a chunker is worse than no cache.
 */

/** Root of the cache under a DATA_DIR. The one place the layout is spelled. */
export function extractCacheDir(dataDir: string): string {
  return path.join(path.resolve(dataDir), 'extract-cache');
}

export type CachedPageMeta = {
  /** Filename stem — the id `readCachedPage` takes. */
  key: string;
  url: string;
  runId: string;
  /** Block count recorded at write time. */
  blocks: number;
  /** ISO timestamp of the write. */
  at: string;
};

export type CachedPage = {
  key: string;
  url: string;
  /** Null when the extract produced blocks but no fragment. */
  contentHtml: string | null;
  blocks: Block[];
};

/** Runs holding a cached corpus, newest-unknown order. Empty when none. */
export async function listCachedRuns(dataDir: string): Promise<string[]> {
  const root = extractCacheDir(dataDir);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => null);
  if (!entries) return [];
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

/** Read one JSON file, or null. Corrupt is indistinguishable from absent here. */
async function readJson<T>(file: string): Promise<T | null> {
  const raw = await readFile(file, 'utf8').catch(() => null);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Every page cached for a run. Pages whose meta is unreadable are skipped. */
export async function listCachedPages(
  dataDir: string,
  runId: string,
): Promise<CachedPageMeta[]> {
  const dir = path.join(extractCacheDir(dataDir), runId);
  const names = await readdir(dir).catch(() => null);
  if (!names) return [];

  const out: CachedPageMeta[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.meta.json')) continue;
    const key = name.slice(0, -'.meta.json'.length);
    const meta = await readJson<{
      url?: unknown;
      runId?: unknown;
      blocks?: unknown;
      at?: unknown;
    }>(path.join(dir, name));
    if (!meta || typeof meta.url !== 'string') continue;
    out.push({
      key,
      url: meta.url,
      runId: typeof meta.runId === 'string' ? meta.runId : runId,
      blocks: typeof meta.blocks === 'number' ? meta.blocks : 0,
      at: typeof meta.at === 'string' ? meta.at : '',
    });
  }
  return out;
}

/** One cached page, or null when it is absent or unreadable. */
export async function readCachedPage(
  dataDir: string,
  runId: string,
  key: string,
): Promise<CachedPage | null> {
  const dir = path.join(extractCacheDir(dataDir), runId);
  const meta = await readJson<{ url?: unknown }>(path.join(dir, `${key}.meta.json`));
  if (!meta || typeof meta.url !== 'string') return null;

  const blocks = await readJson<Block[]>(path.join(dir, `${key}.blocks.json`));
  if (!Array.isArray(blocks)) return null;

  // Absent is legitimate: put() writes no fragment when contentHtml was null.
  const contentHtml = await readFile(path.join(dir, `${key}.content.html`), 'utf8').catch(
    () => null,
  );

  return { key, url: meta.url, contentHtml, blocks };
}

export type ReadCachedPagesOpts = {
  /**
   * Read `.content.html` too. Off by default because a chunker works from
   * blocks, not markup — but the honest measurement is that this is a small
   * saving: on a 147-page run the fragment cost 0.9ms of 16.1ms per page.
   * Leave it off when you don't need markup; don't expect it to be the
   * difference between a fast pass and a slow one.
   */
  fragment?: boolean;
};

/**
 * Stream a run's corpus, one page at a time.
 *
 * The reason to prefer this over mapping listCachedPages: a 2,500-page run is
 * hundreds of megabytes of blocks, and holding it all to chunk it would put a
 * 2-core box into swap. A chunker wants one page at a time anyway.
 *
 * The meta is already in hand from the listing, so this reads the blocks (and
 * optionally the fragment) and nothing else. Routing each page back through
 * readCachedPage re-read the meta that the listing had just returned, and on a
 * real corpus that redundant read was the dominant cost: 55.4ms per page became
 * 15.2ms without it, a 3.6x pass over the same 147 pages.
 */
export async function* readCachedPages(
  dataDir: string,
  runId: string,
  opts?: ReadCachedPagesOpts,
): AsyncGenerator<CachedPage> {
  const dir = path.join(extractCacheDir(dataDir), runId);
  for (const meta of await listCachedPages(dataDir, runId)) {
    const blocks = await readJson<Block[]>(path.join(dir, `${meta.key}.blocks.json`));
    if (!Array.isArray(blocks)) continue;

    const contentHtml = opts?.fragment
      ? await readFile(path.join(dir, `${meta.key}.content.html`), 'utf8').catch(() => null)
      : null;

    yield { key: meta.key, url: meta.url, contentHtml, blocks };
  }
}
