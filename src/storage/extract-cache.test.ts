import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Block } from '../crawl/extract-content.js';
import {
  createExtractCache,
  extractCacheDir,
  listCachedPages,
  listCachedRuns,
  readCachedPage,
  readCachedPages,
} from './extract-cache.js';

const RUN_ID = '11111111-2222-4333-8444-555555555555';

const blocks: Block[] = [
  { kind: 'heading', level: 1, text: 'Invoicing', html: '<h1>Invoicing</h1>', anchors: [] },
  {
    kind: 'paragraph',
    text: 'Send an invoice in seconds.',
    html: '<p>Send an <a href="https://freshbooks.com/invoice">invoice</a> in seconds.</p>',
    anchors: [{ label: 'invoice', href: 'https://freshbooks.com/invoice' }],
  },
];

/** A fresh DATA_DIR per test, with EXTRACT_CACHE forced to a known value. */
async function withDataDir(
  cacheEnv: string | undefined,
  body: (dataDir: string) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'crawler-extract-cache-'));
  const old = process.env.EXTRACT_CACHE;
  if (cacheEnv === undefined) delete process.env.EXTRACT_CACHE;
  else process.env.EXTRACT_CACHE = cacheEnv;
  try {
    await body(dataDir);
  } finally {
    if (old === undefined) delete process.env.EXTRACT_CACHE;
    else process.env.EXTRACT_CACHE = old;
  }
}

/** Missing path → null, so a caller can assert absence without catching. */
async function statOrNull(target: string): Promise<{ isDirectory(): boolean } | null> {
  return stat(target).then(
    (s) => s,
    () => null,
  );
}

test('writes fragment, blocks and meta, and returns the run-scoped key', async () => {
  await withDataDir(undefined, async (dataDir) => {
    const cache = createExtractCache(dataDir);
    const key = await cache.put(RUN_ID, 'https://freshbooks.com/', '<h1>Invoicing</h1>', blocks);

    assert.ok(key, 'a written page returns a key');
    assert.equal(path.posix.dirname(key), path.posix.join('extract-cache', RUN_ID));

    const runDir = path.join(cache.rootDir, RUN_ID);
    const written = (await readdir(runDir)).sort();
    const stem = path.posix.basename(key);
    assert.deepEqual(written, [`${stem}.blocks.json`, `${stem}.content.html`, `${stem}.meta.json`]);

    assert.equal(await readFile(path.join(runDir, `${stem}.content.html`), 'utf8'), '<h1>Invoicing</h1>');
  });
});

test('blocks round-trip exactly, anchors included', async () => {
  await withDataDir(undefined, async (dataDir) => {
    const cache = createExtractCache(dataDir);
    const key = await cache.put(RUN_ID, 'https://freshbooks.com/', '<h1>Invoicing</h1>', blocks);
    assert.ok(key);

    const stem = path.posix.basename(key);
    const raw = await readFile(path.join(cache.rootDir, RUN_ID, `${stem}.blocks.json`), 'utf8');
    // The whole point of the cache: what a chunker replays offline is what the
    // extractor produced, anchors and all.
    assert.deepEqual(JSON.parse(raw), blocks);
  });
});

test('meta records the URL, because a sha256 prefix is not a page', async () => {
  await withDataDir(undefined, async (dataDir) => {
    const cache = createExtractCache(dataDir);
    const key = await cache.put(RUN_ID, 'https://taxjar.com/', '<p>Sales tax</p>', blocks);
    assert.ok(key);

    const stem = path.posix.basename(key);
    const meta = JSON.parse(
      await readFile(path.join(cache.rootDir, RUN_ID, `${stem}.meta.json`), 'utf8'),
    );
    assert.equal(meta.url, 'https://taxjar.com/');
    assert.equal(meta.runId, RUN_ID);
    assert.equal(meta.blocks, blocks.length);
    assert.ok(Number.isFinite(Date.parse(meta.at)), 'at is an ISO timestamp');
  });
});

test('a null fragment still caches blocks, and writes no html file', async () => {
  await withDataDir(undefined, async (dataDir) => {
    const cache = createExtractCache(dataDir);
    const key = await cache.put(RUN_ID, 'https://n8n.io/', null, blocks);
    assert.ok(key);

    const stem = path.posix.basename(key);
    const runDir = path.join(cache.rootDir, RUN_ID);
    assert.deepEqual((await readdir(runDir)).sort(), [`${stem}.blocks.json`, `${stem}.meta.json`]);
  });
});

test('nothing to cache returns null and leaves no directory', async () => {
  await withDataDir(undefined, async (dataDir) => {
    const cache = createExtractCache(dataDir);
    assert.equal(await cache.put(RUN_ID, 'https://empty.test/', null, []), null);
    assert.equal(await statOrNull(cache.rootDir), null, 'no root dir for a page with no content');
  });
});

test('EXTRACT_CACHE=0 disables every write', async () => {
  await withDataDir('0', async (dataDir) => {
    const cache = createExtractCache(dataDir);
    assert.equal(cache.enabled, false);
    assert.equal(await cache.put(RUN_ID, 'https://freshbooks.com/', '<h1>Hi</h1>', blocks), null);
    assert.equal(await statOrNull(cache.rootDir), null, 'disabled means no disk at all');
  });
});

test('the cache lives under DATA_DIR, never the working directory', async () => {
  await withDataDir(undefined, async (dataDir) => {
    const cache = createExtractCache(dataDir);
    assert.equal(cache.rootDir, path.join(path.resolve(dataDir), 'extract-cache'));
    assert.ok(
      !cache.rootDir.startsWith(path.join(process.cwd(), 'extract-cache')),
      'the repo root is not a cache',
    );
  });
});

test('the same URL in two runs does not collide', async () => {
  await withDataDir(undefined, async (dataDir) => {
    const cache = createExtractCache(dataDir);
    const other = '99999999-8888-4777-8666-555555555555';
    const first = await cache.put(RUN_ID, 'https://dext.com/us', '<p>one</p>', blocks);
    const second = await cache.put(other, 'https://dext.com/us', '<p>two</p>', blocks);
    assert.ok(first && second);

    assert.equal(path.posix.basename(first), path.posix.basename(second), 'same URL, same key');
    assert.notEqual(first, second, 'different runs, different paths');
    assert.equal(
      await readFile(path.join(cache.rootDir, RUN_ID, `${path.posix.basename(first)}.content.html`), 'utf8'),
      '<p>one</p>',
      'the earlier run survives the later one',
    );
  });
});

test('distinct URLs get distinct keys within a run', async () => {
  await withDataDir(undefined, async (dataDir) => {
    const cache = createExtractCache(dataDir);
    const a = await cache.put(RUN_ID, 'https://freshbooks.com/', '<p>a</p>', blocks);
    const b = await cache.put(RUN_ID, 'https://freshbooks.com/pricing', '<p>b</p>', blocks);
    assert.ok(a && b);
    assert.notEqual(a, b);
    assert.equal((await readdir(path.join(cache.rootDir, RUN_ID))).length, 6, 'three files per page');
  });
});

test('listCachedRuns finds every run, and nothing when the cache is absent', async () => {
  await withDataDir(undefined, async (dataDir) => {
    assert.deepEqual(await listCachedRuns(dataDir), [], 'no cache dir yields no runs');

    const cache = createExtractCache(dataDir);
    const other = '99999999-8888-4777-8666-555555555555';
    await cache.put(RUN_ID, 'https://freshbooks.com/', '<p>a</p>', blocks);
    await cache.put(other, 'https://dext.com/us', '<p>b</p>', blocks);

    assert.deepEqual(await listCachedRuns(dataDir), [RUN_ID, other].sort());
  });
});

test('listCachedPages returns the meta the writer recorded', async () => {
  await withDataDir(undefined, async (dataDir) => {
    const cache = createExtractCache(dataDir);
    await cache.put(RUN_ID, 'https://freshbooks.com/', '<p>a</p>', blocks);
    await cache.put(RUN_ID, 'https://freshbooks.com/pricing', null, blocks);

    const pages = await listCachedPages(dataDir, RUN_ID);
    assert.equal(pages.length, 2);
    assert.deepEqual(
      pages.map((p) => p.url).sort(),
      ['https://freshbooks.com/', 'https://freshbooks.com/pricing'],
    );
    for (const p of pages) {
      assert.equal(p.runId, RUN_ID);
      assert.equal(p.blocks, blocks.length);
      assert.ok(Number.isFinite(Date.parse(p.at)));
    }
  });
});

test('readCachedPage round-trips a page the writer stored', async () => {
  await withDataDir(undefined, async (dataDir) => {
    const cache = createExtractCache(dataDir);
    const key = await cache.put(RUN_ID, 'https://freshbooks.com/', '<h1>Invoicing</h1>', blocks);
    assert.ok(key);

    const page = await readCachedPage(dataDir, RUN_ID, path.posix.basename(key));
    assert.ok(page);
    assert.equal(page.url, 'https://freshbooks.com/');
    assert.equal(page.contentHtml, '<h1>Invoicing</h1>');
    // What a chunker replays offline must equal what the extractor produced.
    assert.deepEqual(page.blocks, blocks);
  });
});

test('a page cached without a fragment reads back with contentHtml null', async () => {
  await withDataDir(undefined, async (dataDir) => {
    const cache = createExtractCache(dataDir);
    const key = await cache.put(RUN_ID, 'https://n8n.io/', null, blocks);
    assert.ok(key);

    const page = await readCachedPage(dataDir, RUN_ID, path.posix.basename(key));
    assert.ok(page);
    assert.equal(page.contentHtml, null, 'absent fragment is not an error');
    assert.deepEqual(page.blocks, blocks);
  });
});

test('reads fail silently rather than throwing', async () => {
  await withDataDir(undefined, async (dataDir) => {
    assert.deepEqual(await listCachedPages(dataDir, 'no-such-run'), []);
    assert.equal(await readCachedPage(dataDir, 'no-such-run', 'nokey'), null);

    const cache = createExtractCache(dataDir);
    const key = await cache.put(RUN_ID, 'https://freshbooks.com/', '<p>a</p>', blocks);
    assert.ok(key);
    const stem = path.posix.basename(key);

    // Truncated JSON is indistinguishable from absent, and must not throw.
    await writeFile(
      path.join(extractCacheDir(dataDir), RUN_ID, `${stem}.blocks.json`),
      '[{"kind":"para',
      'utf8',
    );
    assert.equal(await readCachedPage(dataDir, RUN_ID, stem), null);
    assert.equal((await listCachedPages(dataDir, RUN_ID)).length, 1, 'meta still lists it');
  });
});

test('readCachedPages streams every page of a run', async () => {
  await withDataDir(undefined, async (dataDir) => {
    const cache = createExtractCache(dataDir);
    const urls = ['https://a.test/', 'https://b.test/', 'https://c.test/'];
    for (const u of urls) await cache.put(RUN_ID, u, '<p>x</p>', blocks);

    const seen: string[] = [];
    for await (const page of readCachedPages(dataDir, RUN_ID)) {
      seen.push(page.url);
      assert.deepEqual(page.blocks, blocks);
    }
    assert.deepEqual(seen.sort(), urls);
  });
});

test('the reader ignores EXTRACT_CACHE=0 — an existing corpus stays readable', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'crawler-extract-cache-'));
  const old = process.env.EXTRACT_CACHE;
  try {
    delete process.env.EXTRACT_CACHE;
    const key = await createExtractCache(dataDir).put(
      RUN_ID,
      'https://freshbooks.com/',
      '<p>a</p>',
      blocks,
    );
    assert.ok(key);

    // Writing is now off, but the corpus already on disk must still be readable:
    // deciding not to cache the next crawl is not a decision to go blind.
    process.env.EXTRACT_CACHE = '0';
    assert.equal(createExtractCache(dataDir).enabled, false);
    assert.deepEqual(await listCachedRuns(dataDir), [RUN_ID]);
    const page = await readCachedPage(dataDir, RUN_ID, path.posix.basename(key));
    assert.ok(page, 'the reader is not gated by the writer switch');
    assert.deepEqual(page.blocks, blocks);
  } finally {
    if (old === undefined) delete process.env.EXTRACT_CACHE;
    else process.env.EXTRACT_CACHE = old;
  }
});

test('streaming omits the fragment by default and reads it on request', async () => {
  await withDataDir(undefined, async (dataDir) => {
    const cache = createExtractCache(dataDir);
    await cache.put(RUN_ID, 'https://freshbooks.com/', '<h1>Invoicing</h1>', blocks);

    const lean = [];
    for await (const p of readCachedPages(dataDir, RUN_ID)) lean.push(p);
    assert.equal(lean.length, 1);
    assert.equal(lean[0]!.contentHtml, null, 'bulk path skips the largest file');
    assert.deepEqual(lean[0]!.blocks, blocks, 'blocks are always read');

    const full = [];
    for await (const p of readCachedPages(dataDir, RUN_ID, { fragment: true })) full.push(p);
    assert.equal(full[0]!.contentHtml, '<h1>Invoicing</h1>');
  });
});
