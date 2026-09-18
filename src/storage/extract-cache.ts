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
import { mkdir, writeFile } from 'node:fs/promises';
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
