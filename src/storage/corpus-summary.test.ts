import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Block } from '../crawl/extract-content.js';
import { createExtractCache } from './extract-cache.js';
import {
  THIN_PROSE_CHARS,
  formatCorpusSummary,
  summarizeCachedRun,
} from './corpus-summary.js';

const RUN_ID = '11111111-2222-4333-8444-555555555555';

/** A paragraph block of a chosen prose length. */
function para(chars: number): Block {
  const text = 'x'.repeat(chars);
  return { kind: 'paragraph', text, html: `<p>${text}</p>`, anchors: [] };
}

async function seed(
  pages: Array<{ url: string; chars: number }>,
): Promise<string> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'crawler-corpus-summary-'));
  const cache = createExtractCache(dataDir);
  for (const p of pages) {
    await cache.put(RUN_ID, p.url, '<p>x</p>', [para(p.chars)]);
  }
  return dataDir;
}

test('summarises pages, prose and thin pages per section', async () => {
  const dataDir = await seed([
    { url: 'https://site.test/hub/a', chars: 6000 },
    { url: 'https://site.test/hub/b', chars: 8000 },
    { url: 'https://site.test/hub/c', chars: 7000 },
    { url: 'https://site.test/glossary/x', chars: 200 },
    { url: 'https://site.test/glossary/y', chars: 300 },
    { url: 'https://site.test/pricing', chars: 5000 },
  ]);

  const summary = await summarizeCachedRun(dataDir, RUN_ID);
  assert.ok(summary);
  assert.equal(summary.host, 'site.test');
  assert.equal(summary.pages, 6);
  assert.equal(summary.thinPages, 2, 'both glossary pages are under the floor');

  // Descending by page count: the budget question is what took the most.
  assert.deepEqual(
    summary.sections.map((s) => s.section),
    ['hub', 'glossary', 'pricing'],
  );

  const hub = summary.sections[0]!;
  assert.equal(hub.pages, 3);
  assert.equal(hub.medianProse, 7000);
  assert.equal(hub.thinPages, 0);
  assert.ok(Math.abs(hub.shareOfRun - 0.5) < 1e-9, 'three of six pages');

  const glossary = summary.sections[1]!;
  assert.equal(glossary.thinPages, 2);
  assert.ok(glossary.medianProse < THIN_PROSE_CHARS);
});

test('the bare path is its own section', async () => {
  const dataDir = await seed([{ url: 'https://site.test/', chars: 9000 }]);
  const summary = await summarizeCachedRun(dataDir, RUN_ID);
  assert.ok(summary);
  assert.deepEqual(
    summary.sections.map((s) => s.section),
    ['(root)'],
  );
});

test('a leak is visible as share of budget, which is the point', async () => {
  // The freshbooks shape: a locale section quietly taking a fifth of the run.
  const pages = [
    ...Array.from({ length: 8 }, (_, i) => ({ url: `https://site.test/hub/${i}`, chars: 7000 })),
    ...Array.from({ length: 2 }, (_, i) => ({ url: `https://site.test/en-gb/${i}`, chars: 6000 })),
  ];
  const dataDir = await seed(pages);

  const summary = await summarizeCachedRun(dataDir, RUN_ID);
  assert.ok(summary);
  const enGb = summary.sections.find((s) => s.section === 'en-gb');
  assert.ok(enGb);
  assert.equal(enGb.pages, 2);
  assert.ok(Math.abs(enGb.shareOfRun - 0.2) < 1e-9, 'reported as 20% of the run');
  // And it is not thin — which is exactly why nothing else flagged it.
  assert.equal(enGb.thinPages, 0);
});

test('a run with no cached pages summarises to null, not an empty shell', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'crawler-corpus-summary-'));
  assert.equal(await summarizeCachedRun(dataDir, RUN_ID), null);
  assert.equal(await summarizeCachedRun(dataDir, 'no-such-run'), null);
});

test('formatCorpusSummary renders a table and tolerates null', async () => {
  assert.equal(formatCorpusSummary(null), '');

  const dataDir = await seed([
    { url: 'https://site.test/hub/a', chars: 6000 },
    { url: 'https://site.test/glossary/x', chars: 200 },
  ]);
  const text = formatCorpusSummary(await summarizeCachedRun(dataDir, RUN_ID));
  assert.match(text, /site\.test — 2 pages/);
  assert.match(text, /hub/);
  assert.match(text, /glossary/);
  assert.match(text, /50\.0%/, 'share is rendered as a percentage');
});
