#!/usr/bin/env node
import { config as loadEnv } from 'dotenv';
loadEnv();
loadEnv({ path: '.env.local', override: true });
import { createCrawlApiServer } from './api/server.js';
import {
  backfillMarkdownForRuns,
  createBackfillClientExplicit,
  createBackfillClientFromEnv,
  resolveBackfillRunIds,
} from './crawl/backfill-markdown.js';
import { startCrawl } from './crawl/orchestrator.js';
import type { GeekApiClient } from './storage/geek-api-client.js';

function usage(): never {
  console.log(`Geek-Crawler v2 (standalone — does not use Geek-Crawler v1)

Usage:
  npm run crawl -- --seed <url> [--seed <url>...] [--type partner|competitors|local] [--max 50]
  npm run serve
  npm run backfill-markdown -- --run-id <guid> [--dry-run] [--max-pages N]
  npm run backfill-markdown -- --all-runs [--dry-run] [--max-pages N]

Env: see .env.example (GEEK_API_URL, EGRESS_MODE, PROXY_URL, DATA_DIR)
`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const seeds: string[] = [];
  let crawlType = 'partner';
  let maxRequestsPerCrawl = 50;
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
      maxRequestsPerCrawl = Number(argv[++i] ?? 50);
    } else if (a === '--data-dir') {
      dataDir = argv[++i];
    } else if (a === '--help' || a === '-h') {
      usage();
    }
  }

  return { seeds, crawlType, maxRequestsPerCrawl, dataDir };
}

function parseBackfillArgs(argv: string[]) {
  let runId: string | undefined;
  let allRuns = false;
  let dryRun = false;
  let maxPages = 0;
  let baseUrl: string | undefined;
  let apiKey: string | undefined;
  let userId: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run-id') runId = argv[++i];
    else if (a === '--all-runs') allRuns = true;
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--max-pages') maxPages = Number(argv[++i] ?? 0);
    else if (a === '--base-url') baseUrl = argv[++i];
    else if (a === '--api-key') apiKey = argv[++i];
    else if (a === '--user-id') userId = argv[++i];
    else if (a === '--help' || a === '-h') usage();
  }

  return { runId, allRuns, dryRun, maxPages, baseUrl, apiKey, userId };
}

async function cmdCrawl(argv: string[]) {
  const { seeds, crawlType, maxRequestsPerCrawl, dataDir } = parseArgs(argv);
  if (seeds.length === 0) {
    console.error('At least one --seed is required');
    usage();
  }

  console.log(`Starting crawl type=${crawlType} seeds=${seeds.join(', ')} max=${maxRequestsPerCrawl}`);
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

async function cmdBackfillMarkdown(argv: string[]) {
  const args = parseBackfillArgs(argv);
  let client: GeekApiClient;
  if (args.baseUrl && args.apiKey && args.userId) {
    client = createBackfillClientExplicit({
      baseUrl: args.baseUrl,
      apiKey: args.apiKey,
      userId: args.userId,
    });
  } else {
    client = createBackfillClientFromEnv();
  }

  const runIds = await resolveBackfillRunIds({
    client,
    runId: args.runId,
    allRuns: args.allRuns,
  });

  console.log(
    `backfill-markdown runs=${runIds.length} dryRun=${args.dryRun} maxPages=${args.maxPages || 'unlimited'}`,
  );

  const totals = await backfillMarkdownForRuns({
    client,
    runIds,
    dryRun: args.dryRun,
    maxPages: args.maxPages,
    onSample: (s) => {
      console.log(
        JSON.stringify({
          sample: true,
          runId: s.runId,
          pageId: s.pageId,
          url: s.url,
          title: s.title,
          markdownPreview: s.markdownPreview,
        }),
      );
    },
  });

  console.log(JSON.stringify({ ok: true, dryRun: args.dryRun, totals }, null, 2));
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'crawl') return cmdCrawl(rest);
  if (cmd === 'serve') return cmdServe();
  if (cmd === 'backfill-markdown') return cmdBackfillMarkdown(rest);
  usage();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
