#!/usr/bin/env node
import { config as loadEnv } from 'dotenv';
loadEnv();
loadEnv({ path: '.env.local', override: true });
import path from 'node:path';
import { createCrawlApiServer } from './api/server.js';
import { isPrepareFailure, startCrawl } from './crawl/orchestrator.js';
import { openProcessLog } from './crawl/run-log.js';
import { renderFailures, summarizeFailures } from './storage/failures-report.js';

function usage(): never {
  console.log(`Geek-Crawler v2 (standalone — does not use Geek-Crawler v1)

Usage:
  npm run crawl -- --seed <url> [--seed <url>...] [--type partner|competitors|local|project-site] [--max N]
  npm run serve
  npm run failures [-- --data-dir <dir>]   what failed, and why

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
  if (!requireProcessLog(dataDir)) return;
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
  if (isPrepareFailure(result)) {
    console.error(JSON.stringify({ ok: false, runId: result.runId, error: result.failure }, null, 2));
    process.exitCode = 1;
    return;
  }
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

/**
 * The archive had 15 post-mortems and nothing read it, so ~4,000 discarded pages went unnoticed
 * until someone happened to look. This is the thing that looks.
 */
async function cmdFailures(argv: string[]) {
  const { dataDir } = parseArgs(argv);
  if (!requireProcessLog(dataDir)) return;
  const resolved = path.resolve(dataDir ?? process.env.DATA_DIR ?? './data');
  const summary = await summarizeFailures(resolved);
  if (summary === null) {
    console.error(`cannot list ${resolved}/failures; RECORD_UNREADABLE above names the cause`);
    process.exitCode = 1;
    return;
  }
  console.log(renderFailures(summary, resolved));
}

async function cmdServe() {
  const api = createCrawlApiServer();
  const started = await api.listen();
  if (!started.ok) {
    console.error(started.reason);
    process.exitCode = 1;
  }
}

/** Every command opens the process log before it does anything, and does not run without it. */
function requireProcessLog(dataDir: string | undefined): boolean {
  const opened = openProcessLog(path.resolve(dataDir ?? process.env.DATA_DIR ?? './data'));
  if (opened.ok) return true;
  console.error(`process log could not be opened: ${opened.reason}`);
  process.exitCode = 1;
  return false;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'crawl') return cmdCrawl(rest);
  if (cmd === 'serve') return cmdServe();
  if (cmd === 'failures') return cmdFailures(rest);
  usage();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
