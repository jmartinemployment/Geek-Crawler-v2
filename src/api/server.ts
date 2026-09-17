import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareCrawl, startCrawl } from '../crawl/orchestrator.js';
import { CRAWL_TYPE_VALUES } from '../crawl/types.js';
import { createGeekApiClient, requireGeekApiEnv } from '../storage/geek-api-client.js';
import { requestCancel } from '../crawl/cancel-registry.js';
import { createJsonRunStore } from '../storage/runs.js';

type Json = Record<string, unknown>;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(res: ServerResponse, status: number, body: Json | unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function createCrawlApiServer(options?: { dataDir?: string; port?: number }) {
  requireGeekApiEnv();
  const dataDir = path.resolve(options?.dataDir ?? process.env.DATA_DIR ?? './data');
  const port = options?.port ?? Number(process.env.PORT ?? 8787);
  const meta = createJsonRunStore(dataDir);
  const inFlight = new Map<string, Promise<unknown>>();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const { pathname } = url;

      if (req.method === 'GET' && (pathname === '/health' || pathname === '/')) {
        return send(res, 200, {
          ok: true,
          service: 'geek-crawler-v2',
          phase: 4,
          egressMode: process.env.EGRESS_MODE ?? 'off',
          inFlight: inFlight.size,
        });
      }

      if (req.method === 'GET' && pathname === '/crawls') {
        const runs = await meta.listRuns();
        return send(res, 200, { ok: true, runs });
      }

      if (req.method === 'POST' && pathname === '/crawls') {
        const raw = await readBody(req);
        const body = raw ? (JSON.parse(raw) as Json) : {};
        const seeds = Array.isArray(body.seeds)
          ? body.seeds.map(String)
          : body.seed
            ? [String(body.seed)]
            : [];
        if (seeds.length === 0) {
          return send(res, 400, { error: 'seed or seeds[] required' });
        }
        if (seeds.length !== 1) {
          return send(res, 400, {
            error: 'exactly one seed URL per run (1 runId = 1 URL)',
          });
        }
        const crawlType = String(body.crawlType ?? 'partner');
        const maxRaw = body.maxRequestsPerCrawl != null ? Number(body.maxRequestsPerCrawl) : NaN;
        const maxRequestsPerCrawl =
          Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : undefined;
        const maxConcurrency = body.maxConcurrency
          ? Number(body.maxConcurrency)
          : undefined;
        const wait = body.wait === true || body.wait === '1';

        if (wait) {
          const result = await startCrawl({
            seeds,
            crawlType,
            dataDir,
            maxRequestsPerCrawl,
            maxConcurrency,
          });
          return send(res, 200, {
            ok: true,
            runId: result.runId,
            pagesSaved: result.pagesSaved,
            linksSaved: result.linksSaved,
            pagesRejectedLocale: result.pagesRejectedLocale,
            pagesRejectedChallenge: result.pagesRejectedChallenge,
            pagesRejectedExtractEmpty: result.pagesRejectedExtractEmpty,
            dataDir: result.dataDir,
            persistMode: result.persistMode,
          });
        }

        const prepared = await prepareCrawl({
          seeds,
          crawlType,
          dataDir,
          maxRequestsPerCrawl,
          maxConcurrency,
        });

        const work = prepared.run().catch((err) => {
          console.error(`Crawl ${prepared.runId} failed:`, err);
          return err;
        });
        inFlight.set(prepared.runId, work);
        void work.finally(() => inFlight.delete(prepared.runId));

        return send(res, 202, {
          ok: true,
          runId: prepared.runId,
          persistMode: prepared.persistMode,
          dataDir: prepared.dataDir,
          status: 'running',
        });
      }

      const runMatch = pathname.match(/^\/crawls\/([^/]+)$/);
      if (req.method === 'GET' && runMatch) {
        const runId = decodeURIComponent(runMatch[1]!);
        const run = await meta.getRun(runId);
        if (!run) return send(res, 404, { error: 'run not found' });
        return send(res, 200, run as unknown as Json);
      }

      if (
        req.method === 'POST' &&
        (pathname === '/crawls/resume-by-url' ||
          pathname === '/crawls/resume-running' ||
          /^\/crawls\/[^/]+\/resume$/.test(pathname))
      ) {
        return send(res, 409, {
          error:
            'Resume is forbidden under fail-closed policy — start a new crawl run instead',
          code: 'RESUME_FORBIDDEN',
        });
      }

      const cancelMatch = pathname.match(/^\/crawls\/([^/]+)\/cancel$/);
      if (req.method === 'POST' && cancelMatch) {
        const runId = decodeURIComponent(cancelMatch[1]!);
        const live = inFlight.has(runId);

        // A live run stops itself and writes its own terminal status, keeping
        // one writer per run. An orphan has no writer, so the API is it.
        if (live) {
          requestCancel(runId);
          return send(res, 202, { ok: true, runId, cancelling: true, orphan: false });
        }

        const snapshot = await createGeekApiClient().patchRun(runId, {
          status: 'cancelled',
          errorSummary: 'Cancelled by operator (no live crawl process)',
          completedAtUtc: new Date().toISOString(),
          clearMarkdownReadyAt: true,
        });
        return send(res, 200, {
          ok: true,
          runId,
          cancelling: false,
          orphan: true,
          status: snapshot.status,
        });
      }

      const deleteMatch = pathname.match(/^\/crawls\/([^/]+)$/);
      if (req.method === 'DELETE' && deleteMatch) {
        const runId = decodeURIComponent(deleteMatch[1]!);
        if (inFlight.has(runId)) {
          return send(res, 409, {
            error: 'Run is in flight — cancel it before deleting',
            code: 'RUN_IN_FLIGHT',
            runId,
          });
        }
        const result = await createGeekApiClient().deleteRun(runId);
        return send(res, 200, { ok: true, runId, ...result });
      }

      const pagesMatch = pathname.match(/^\/crawls\/([^/]+)\/pages$/);
      if (req.method === 'GET' && pagesMatch) {
        const runId = decodeURIComponent(pagesMatch[1]!);
        const file = path.join(dataDir, 'runs', runId, 'pages.jsonl');
        try {
          const text = await readFile(file, 'utf8');
          const pages = text
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line));
          return send(res, 200, { runId, pages });
        } catch {
          return send(res, 404, { error: 'pages not found' });
        }
      }

      return send(res, 404, { error: 'not found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return send(res, err instanceof SyntaxError ? 400 : 500, { error: message });
    }
  });

  return {
    listen() {
      return new Promise<void>((resolve) => {
        server.listen(port, () => {
          console.log(`geek-crawler-v2 API on http://127.0.0.1:${port}`);
          console.log(`  GET  /health`);
          console.log(`  GET  /crawls`);
          console.log(`  POST /crawls  { seed|seeds[1], crawlType?, maxRequestsPerCrawl?, maxConcurrency? } → 202`
          );
          console.log(
            `        crawlType: ${CRAWL_TYPE_VALUES.join(' | ')}`);
          console.log(`  POST /crawls/resume-*  → 409 RESUME_FORBIDDEN (start a new run)`);
          console.log(`  GET  /crawls/:runId`);
          console.log(`  GET  /crawls/:runId/pages`);
          console.log(`  POST /crawls/:runId/cancel`);
          resolve();
        });
      });
    },
    server,
    dataDir,
    inFlight,
  };
}
