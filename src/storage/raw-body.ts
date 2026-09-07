import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type RawBodyStore = {
  put(runId: string, url: string, rawHtml: string): Promise<string>;
  /** Optional markdown sibling under bodies/ (same url hash, .md). */
  putMarkdown(runId: string, url: string, markdown: string): Promise<string>;
  rootDir: string;
};

function urlKey(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 24);
}

/** Persist exact wire HTML string; returns relative bodyKey. Never Cheerio-round-trip. */
export function createFilesystemRawBodyStore(dataDir: string): RawBodyStore {
  const rootDir = path.resolve(dataDir);

  return {
    rootDir,
    async put(runId, url, rawHtml) {
      const dir = path.join(rootDir, 'runs', runId, 'bodies');
      await mkdir(dir, { recursive: true });
      const key = `${urlKey(url)}.html`;
      const abs = path.join(dir, key);
      await writeFile(abs, rawHtml, 'utf8');
      return path.posix.join('runs', runId, 'bodies', key);
    },
    async putMarkdown(runId, url, markdown) {
      const dir = path.join(rootDir, 'runs', runId, 'bodies');
      await mkdir(dir, { recursive: true });
      const key = `${urlKey(url)}.md`;
      const abs = path.join(dir, key);
      await writeFile(abs, markdown, 'utf8');
      return path.posix.join('runs', runId, 'bodies', key);
    },
  };
}
