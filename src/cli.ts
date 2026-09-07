#!/usr/bin/env node
import { config as loadEnv } from 'dotenv';
loadEnv();
loadEnv({ path: '.env.local', override: true });
import { createCrawlApiServer } from './api/server.js';
import { startCrawl } from './crawl/orchestrator.js';

function usage(): never {
  console.log(`Geek-Crawler v2 (standalone — does not use Geek-Crawler v1)

Usage:
  npm run crawl -- --seed <url> [--seed <url>...] [--type partner|competitors|local] [--max N]
  npm run serve

Env: see .env.example (GEEK_API_URL, EGRESS_MODE, PROXY_URL, DATA_DIR)
`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const seeds: string[] = [];
  let crawlType = 'partner';
  let maxRequestsPerCrawl: number | undefined;
  let dataDir: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seed' || a === '-s') {
      const v = argv[++i];
      if (!v) usage();
      seeds.push(v);
    } else if (a === '--type' || a === '-t') {
      crawlType = argv[++i] ?? crawlType;
    } else if (a === '--max') {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) maxRequestsPerCrawl = n;
    } else if (a === '--data-dir') {
      dataDir = argv[++i];
    } else if (a === '--help' || a === '-h') {
      usage();
    }
  }

  return { seeds, crawlType, maxRequestsPerCrawl, dataDir };
}

async function cmdCrawl(argv: string[]) {
  const { seeds, crawlType, maxRequestsPerCrawl, dataDir } = parseArgs(argv);
  if (seeds.length === 0) {
    console.error('At least one --seed is required');
    usage();
  }

  console.log(
    `Starting crawl type=${crawlType} seeds=${seeds.join(', ')} max=${maxRequestsPerCrawl ?? 'auto(sitemap)'}`,
  );
  console.log(`EGRESS_MODE=${process.env.EGRESS_MODE ?? 'off'}`);
  const result = await startCrawl({
    seeds,
    crawlType,
    maxRequestsPerCrawl,
    dataDir,
  });
  console.log(
    JSON.stringify(
      {
        ok: true,
        runId: result.runId,
        pagesSaved: result.pagesSaved,
        linksSaved: result.linksSaved,
        pagesRejectedLocale: result.pagesRejectedLocale,
        pagesRejectedChallenge: result.pagesRejectedChallenge,
        pagesRejectedExtractEmpty: result.pagesRejectedExtractEmpty,
        dataDir: result.dataDir,
        persistMode: result.persistMode,
      },
      null,
      2,
    ),
  );
}

async function cmdServe() {
  const api = createCrawlApiServer();
  await api.listen();
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'crawl') return cmdCrawl(rest);
  if (cmd === 'serve') return cmdServe();
  usage();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
