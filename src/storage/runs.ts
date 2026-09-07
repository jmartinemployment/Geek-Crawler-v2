import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type CrawlRunMeta = {
  runId: string;
  crawlType: string;
  seeds: string[];
  status: string;
  createdAtUtc: string;
  startedAtUtc?: string;
  completedAtUtc?: string;
  errorSummary?: string;
  pagesSaved?: number;
  linksSaved?: number;
};

export type CrawlPageMeta = {
  url: string;
  finalUrl?: string;
  statusCode?: number;
  bodyKey: string;
  /** Relative key for clean markdown body when local|both. */
  markdownBodyKey?: string;
  title?: string;
  /** cheerio = primary HTTP; playwright = backup for non-viable shells */
  fetchMode: 'cheerio' | 'playwright';
  robotsAllowed: boolean;
  crawledAtUtc: string;
  failureReason?: string;
};

export type JsonRunStore = {
  dataDir: string;
  listRuns(): Promise<CrawlRunMeta[]>;
  getRun(runId: string): Promise<CrawlRunMeta | null>;
  upsertRun(run: CrawlRunMeta): Promise<void>;
  insertPage(runId: string, page: CrawlPageMeta): Promise<void>;
};

async function ensureDir(dir: string) {
  await mkdir(dir, { recursive: true });
}

export function createJsonRunStore(dataDir: string): JsonRunStore {
  const root = path.resolve(dataDir);
  const runsDir = path.join(root, 'runs');

  async function runPath(runId: string) {
    return path.join(runsDir, runId, 'run.json');
  }

  async function pagesPath(runId: string) {
    return path.join(runsDir, runId, 'pages.jsonl');
  }

  return {
    dataDir: root,
    async listRuns() {
      try {
        await ensureDir(runsDir);
        const names = await readdir(runsDir);
        const out: CrawlRunMeta[] = [];
        for (const name of names) {
          try {
            const raw = await readFile(path.join(runsDir, name, 'run.json'), 'utf8');
            out.push(JSON.parse(raw) as CrawlRunMeta);
          } catch {
            // skip incomplete dirs
          }
        }
        return out;
      } catch {
        return [];
      }
    },
    async getRun(runId) {
      try {
        const raw = await readFile(await runPath(runId), 'utf8');
        return JSON.parse(raw) as CrawlRunMeta;
      } catch {
        return null;
      }
    },
    async upsertRun(run) {
      const dir = path.join(runsDir, run.runId);
      await ensureDir(dir);
      await writeFile(await runPath(run.runId), JSON.stringify(run, null, 2), 'utf8');
    },
    async insertPage(runId, page) {
      const dir = path.join(runsDir, runId);
      await ensureDir(dir);
      const file = await pagesPath(runId);
      await writeFile(file, `${JSON.stringify(page)}\n`, { flag: 'a' });
    },
  };
}
