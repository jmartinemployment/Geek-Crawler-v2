import path from 'node:path';
import { prepareCheerioCrawl, runCheerioCrawl } from './cheerio-runner.js';
import { parseCrawlType, type CrawlType } from './types.js';

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
