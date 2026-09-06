import path from 'node:path';
import {
  prepareCheerioCrawl,
  prepareResumeCheerioCrawl,
  runCheerioCrawl,
} from './cheerio-runner.js';
import { parseCrawlType, type CrawlType } from './types.js';
import { createJsonRunStore, type CrawlRunMeta } from '../storage/runs.js';
import { seedHostKey } from '../storage/seed-key.js';

export type StartCrawlOptions = {
  seeds: string[];
  crawlType?: string;
  dataDir?: string;
  maxRequestsPerCrawl?: number;
  runId?: string;
};

export async function startCrawl(options: StartCrawlOptions) {
  const crawlType: CrawlType = parseCrawlType(options.crawlType);
  const dataDir = path.resolve(options.dataDir ?? process.env.DATA_DIR ?? './data');

  return runCheerioCrawl({
    runId: options.runId,
    crawlType,
    seeds: options.seeds,
    dataDir,
    maxRequestsPerCrawl: options.maxRequestsPerCrawl,
  });
}

/** Begin persist (GeekAPI run id) then return; caller schedules `run()`. */
export async function prepareCrawl(options: StartCrawlOptions) {
  const crawlType: CrawlType = parseCrawlType(options.crawlType);
  const dataDir = path.resolve(options.dataDir ?? process.env.DATA_DIR ?? './data');

  return prepareCheerioCrawl({
    runId: options.runId,
    crawlType,
    seeds: options.seeds,
    dataDir,
    maxRequestsPerCrawl: options.maxRequestsPerCrawl,
  });
}

/** Resume existing runId using persisted `.crawlee/<runId>` queue. */
export async function prepareResumeCrawl(options: {
  runId: string;
  dataDir?: string;
  maxRequestsPerCrawl?: number;
}) {
  const dataDir = path.resolve(options.dataDir ?? process.env.DATA_DIR ?? './data');
  return prepareResumeCheerioCrawl({
    runId: options.runId,
    dataDir,
    maxRequestsPerCrawl: options.maxRequestsPerCrawl,
  });
}

/**
 * Find a local run whose seeds include this URL (1 run ↔ 1 seed going forward).
 * Prefers incomplete runs, then newest.
 */
export async function findRunIdBySeedUrl(options: {
  url: string;
  dataDir?: string;
}): Promise<{ run: CrawlRunMeta; multiSeed: boolean } | null> {
  const dataDir = path.resolve(options.dataDir ?? process.env.DATA_DIR ?? './data');
  const key = seedHostKey(options.url);
  if (!key) return null;

  const meta = createJsonRunStore(dataDir);
  const runs = await meta.listRuns();
  const matches = runs.filter((r) =>
    (r.seeds ?? []).some((s) => seedHostKey(s) === key),
  );
  if (matches.length === 0) return null;

  const rank = (status: string) => {
    switch (status) {
      case 'running':
        return 0;
      case 'pending':
        return 1;
      case 'failed':
        return 2;
      case 'cancelled':
        return 3;
      case 'complete':
        return 4;
      default:
        return 5;
    }
  };

  matches.sort((a, b) => {
    const rs = rank(a.status) - rank(b.status);
    if (rs !== 0) return rs;
    return (b.createdAtUtc || '').localeCompare(a.createdAtUtc || '');
  });

  const run = matches[0]!;
  return { run, multiSeed: (run.seeds?.length ?? 0) > 1 };
}
