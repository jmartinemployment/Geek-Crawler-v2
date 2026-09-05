import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareCrawl, startCrawl } from '../crawl/orchestrator.js';
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

const cancellations = new Set<string>();

export function isCancelRequested(runId: string): boolean {
  return cancellations.has(runId);
}

export function createCrawlApiServer(options?: { dataDir?: string; port?: number }) {
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
          return send(res, 400, { error: 'seeds[] or seed required' });
        }
        const crawlType = String(body.crawlType ?? 'partner');
        const maxRequestsPerCrawl = body.maxRequestsPerCrawl
          ? Number(body.maxRequestsPerCrawl)
          : 50;
        const wait = body.wait === true || body.wait === '1';

        if (wait) {
          const result = await startCrawl({
            seeds,
            crawlType,
            dataDir,
            maxRequestsPerCrawl,
          });
          return send(res, 200, {
            ok: true,
            runId: result.runId,
            pagesSaved: result.pagesSaved,
            linksSaved: result.linksSaved,
            dataDir: result.dataDir,
            persistMode: result.persistMode,
          });
        }

        const prepared = await prepareCrawl({
          seeds,
          crawlType,
          dataDir,
          maxRequestsPerCrawl,
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

      const cancelMatch = pathname.match(/^\/crawls\/([^/]+)\/cancel$/);
      if (req.method === 'POST' && cancelMatch) {
        const runId = decodeURIComponent(cancelMatch[1]!);
        cancellations.add(runId);
        return send(res, 200, {
          ok: true,
          runId,
          note: 'Cancel flag set; in-flight Crawlee stop hooks arrive in a later polish.',
        });
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
      return send(res, 500, { error: message });
    }
  });

  return {
    listen() {
      return new Promise<void>((resolve) => {
        server.listen(port, () => {
          console.log(`geek-crawler-v2 API on http://127.0.0.1:${port}`);
          console.log(`  GET  /health`);
          console.log(`  GET  /crawls`);
          console.log(`  POST /crawls  { seeds[], crawlType?, maxRequestsPerCrawl? } → 202 + runId`);
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
