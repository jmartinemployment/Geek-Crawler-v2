import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CrawlType } from '../crawl/types.js';

export type CrawlRunMeta = {
  runId: string;
  crawlType: CrawlType;
  status: 'pending' | 'running' | 'complete' | 'failed' | 'cancelled';
  seeds: string[];
  createdAtUtc: string;
  startedAtUtc?: string;
  completedAtUtc?: string;
  errorSummary?: string;
  pagesSaved: number;
  linksSaved: number;
  pagesRejectedLocale?: number;
  pagesRejectedChallenge?: number;
  pagesRejectedExtractEmpty?: number;
  rejectSamples?: {
    locale_excluded?: string[];
    challenge_page?: string[];
    extract_empty?: string[];
  };
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

export type CrawlLinkMeta = {
  fromUrl: string;
  linkUrl: string;
  isSameOrigin: boolean;
};

export type RunStore = {
  createRun(input: {
    runId: string;
    crawlType: CrawlType;
    seeds: string[];
  }): Promise<CrawlRunMeta>;
  markRunning(runId: string): Promise<void>;
  markComplete(runId: string): Promise<void>;
  markFailed(runId: string, errorSummary: string): Promise<void>;
  /** Merge reject counters + samples into run.json (no page body). */
  recordRejectStats(
    runId: string,
    stats: {
      pagesRejectedLocale: number;
      pagesRejectedChallenge: number;
      pagesRejectedExtractEmpty: number;
      rejectSamples?: CrawlRunMeta['rejectSamples'];
    },
  ): Promise<void>;
  insertPage(runId: string, page: CrawlPageMeta): Promise<void>;
  insertLinks(runId: string, links: CrawlLinkMeta[]): Promise<void>;
  getRun(runId: string): Promise<CrawlRunMeta | null>;
  listRuns(): Promise<CrawlRunMeta[]>;
};

async function readJson<T>(file: string): Promise<T | null> {
  try {
    const raw = await readFile(file, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Atomic replace so concurrent readers never see a truncated run.json. */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await rename(tmp, file);
}

export function createJsonRunStore(dataDir: string): RunStore {
  const root = path.resolve(dataDir);
  const memory = new Map<string, CrawlRunMeta>();
  const locks = new Map<string, Promise<void>>();

  const runPath = (runId: string) => path.join(root, 'runs', runId, 'run.json');
  const pagesPath = (runId: string) => path.join(root, 'runs', runId, 'pages.jsonl');
  const linksPath = (runId: string) => path.join(root, 'runs', runId, 'links.jsonl');

  async function withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(runId) ?? Promise.resolve();
    let result!: T;
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        result = await fn();
      });
    locks.set(
      runId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    await next;
    return result;
  }

  async function loadRun(runId: string): Promise<CrawlRunMeta> {
    const cached = memory.get(runId);
    if (cached) return cached;
    const run = await readJson<CrawlRunMeta>(runPath(runId));
    if (!run) throw new Error(`Run not found: ${runId}`);
    memory.set(runId, run);
    return run;
  }

  async function saveRun(run: CrawlRunMeta): Promise<void> {
    memory.set(run.runId, run);
    await writeJsonAtomic(runPath(run.runId), run);
  }

  return {
    async createRun({ runId, crawlType, seeds }) {
      return withRunLock(runId, async () => {
        const run: CrawlRunMeta = {
          runId,
          crawlType,
          status: 'pending',
          seeds,
          createdAtUtc: new Date().toISOString(),
          pagesSaved: 0,
          linksSaved: 0,
        };
        await saveRun(run);
        await writeFile(pagesPath(runId), '', 'utf8');
        await writeFile(linksPath(runId), '', 'utf8');
        return run;
      });
    },

    async markRunning(runId) {
      await withRunLock(runId, async () => {
        const run = await loadRun(runId);
        run.status = 'running';
        run.startedAtUtc = run.startedAtUtc ?? new Date().toISOString();
        delete run.completedAtUtc;
        delete run.errorSummary;
        await saveRun(run);
      });
    },

    async markComplete(runId) {
      await withRunLock(runId, async () => {
        const run = await loadRun(runId);
        run.status = 'complete';
        run.completedAtUtc = new Date().toISOString();
        await saveRun(run);
      });
    },

    async markFailed(runId, errorSummary) {
      await withRunLock(runId, async () => {
        const run = await loadRun(runId);
        run.status = 'failed';
        run.errorSummary = errorSummary;
        run.completedAtUtc = new Date().toISOString();
        await saveRun(run);
      });
    },

    async recordRejectStats(runId, stats) {
      await withRunLock(runId, async () => {
        const run = await loadRun(runId);
        run.pagesRejectedLocale = stats.pagesRejectedLocale;
        run.pagesRejectedChallenge = stats.pagesRejectedChallenge;
        run.pagesRejectedExtractEmpty = stats.pagesRejectedExtractEmpty;
        if (stats.rejectSamples) run.rejectSamples = stats.rejectSamples;
        await saveRun(run);
      });
    },

    async insertPage(runId, page) {
      await withRunLock(runId, async () => {
        const run = await loadRun(runId);
        await mkdir(path.dirname(pagesPath(runId)), { recursive: true });
        await writeFile(pagesPath(runId), `${JSON.stringify(page)}\n`, { flag: 'a' });
        run.pagesSaved += 1;
        await saveRun(run);
      });
    },

    async insertLinks(runId, links) {
      if (links.length === 0) return;
      await withRunLock(runId, async () => {
        const run = await loadRun(runId);
        const lines = links.map((l) => JSON.stringify(l)).join('\n') + '\n';
        await writeFile(linksPath(runId), lines, { flag: 'a' });
        run.linksSaved += links.length;
        await saveRun(run);
      });
    },

    async getRun(runId) {
      const cached = memory.get(runId);
      if (cached) return { ...cached };
      return readJson<CrawlRunMeta>(runPath(runId));
    },

    async listRuns() {
      const runsDir = path.join(root, 'runs');
      let dirs: string[] = [];
      try {
        dirs = await readdir(runsDir);
      } catch {
        return [];
      }
      const out: CrawlRunMeta[] = [];
      for (const id of dirs) {
        const run = await readJson<CrawlRunMeta>(runPath(id));
        if (run) {
          memory.set(run.runId, run);
          out.push({ ...run });
        }
      }
      out.sort((a, b) => (b.createdAtUtc || '').localeCompare(a.createdAtUtc || ''));
      return out;
    },
  };
}
