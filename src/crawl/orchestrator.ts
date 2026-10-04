import path from 'node:path';
import { prepareCheerioCrawl, runCheerioCrawl } from './cheerio-runner.js';
import { parseCrawlType, type CrawlType } from './types.js';
import { requireGeekApiEnv } from '../storage/geek-api-client.js';

export type StartCrawlOptions = {
  seeds: string[];
  crawlType?: string;
  dataDir?: string;
  maxRequestsPerCrawl?: number;
  maxConcurrency?: number;
};

export async function startCrawl(options: StartCrawlOptions) {
  requireGeekApiEnv();
  const crawlType: CrawlType = parseCrawlType(options.crawlType);
  const dataDir = path.resolve(options.dataDir ?? process.env.DATA_DIR ?? './data');

  return runCheerioCrawl({
    crawlType,
    seeds: options.seeds,
    dataDir,
    maxRequestsPerCrawl: options.maxRequestsPerCrawl,
    maxConcurrency: options.maxConcurrency,
  });
}

/** Begin persist (GeekAPI run id) then return; caller schedules `run()`. */
export async function prepareCrawl(options: StartCrawlOptions) {
  requireGeekApiEnv();
  const crawlType: CrawlType = parseCrawlType(options.crawlType);
  const dataDir = path.resolve(options.dataDir ?? process.env.DATA_DIR ?? './data');

  return prepareCheerioCrawl({
    crawlType,
    seeds: options.seeds,
    dataDir,
    maxRequestsPerCrawl: options.maxRequestsPerCrawl,
    maxConcurrency: options.maxConcurrency,
  });
}
