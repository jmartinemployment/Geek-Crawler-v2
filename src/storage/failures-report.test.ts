/**
 * The failure report's grouping. Every fixture message below is a real errorSummary copied from
 * /Volumes/Seagate/geek-crawler-data/failures on 2026-09-30.
 * Run: npx tsx --test src/storage/failures-report.test.ts
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { archiveRun, type FailureRecord } from './failure-archive.js';
import { causeOf, renderFailures, summarizeFailures } from './failures-report.js';

function record(over: Partial<FailureRecord>): FailureRecord {
  return {
    runId: over.runId ?? '11111111-2222-4333-8444-555555555555',
    seed: 'https://example.com',
    crawlType: 'partner',
    status: 'failed',
    errorSummary: null,
    createdAtUtc: '2026-09-30T00:00:00.000Z',
    purgedAtUtc: '2026-09-30T00:00:00.000Z',
    pagesSaved: 0,
    linksSaved: 0,
    report: {
      linksStored: 0,
      excludedByPolicy: { robotsDisallowed: 0, localeExcluded: 0, requiresJavascript: 0 },
      failed: { requestFailed: 0, challengePage: 0, extractEmpty: 0 },
      samples: [],
    },
    rejectSamples: {},
    dedup: {},
    purge: { vectorsPurged: true, crawlDataDeleted: true, localRemoved: [] },
    ...over,
  };
}

const RUN = 'bf8c38fc-4bc7-4280-aa3f-fa8431fc5839';

describe('causeOf', () => {
  it('names pages/batch, not runs, for an ingest URL that contains both', () => {
    // Every ingest URL has `/runs/<id>/` in it, so a leftmost match called these "on runs" and
    // merged the pages/batch 500s with unrelated run-level failures.
    const cause = causeOf(
      record({
        errorSummary: `POST /api/geek-crawler/ingest/runs/${RUN}/pages/batch → 500: {"error":"boom"}`,
      }),
    );
    assert.equal(cause, 'HTTP 500 on pages/batch');
  });

  it('groups a transport failure rather than dropping it into raw text', () => {
    // ramp 1,426 pages and zoneandco 341 were purged on exactly this message. It carries no status,
    // so it fell through to a truncated copy of itself and grouped with nothing.
    const cause = causeOf(
      record({ errorSummary: `POST /api/geek-crawler/ingest/runs/${RUN}/pages/batch → transport: fetch failed` }),
    );
    assert.equal(cause, 'transport failure (no response) on pages/batch');
  });

  it('separates the platform proxy 404 from a status code', () => {
    const cause = causeOf(
      record({
        errorSummary:
          `POST /api/geek-crawler/ingest/runs/${RUN}/pages/batch → 404: {"status":"error",` +
          `"code":404,"message":"Application not found","request_id":"qSKfdisKRiiSktaLU79b0g"}`,
      }),
    );
    assert.equal(cause, 'platform proxy 404 (service not running) on pages/batch');
  });

  it('reads no status out of the digits in a run id', () => {
    // 4280 and 8431 are inside the run id. A bare three-digit pattern reported "HTTP 428".
    const cause = causeOf(
      record({ errorSummary: `PATCH /api/geek-crawler/ingest/runs/${RUN} → transport: fetch failed` }),
    );
    assert.equal(cause, 'transport failure (no response) on runs');
  });

  it('names GeekAPI verdicts as verdicts', () => {
    assert.equal(
      causeOf(record({ errorSummary: 'Crawl reported complete with no usable pages' })),
      'GeekAPI: crawl complete with no usable pages',
    );
    assert.equal(
      causeOf(record({ errorSummary: 'pages carry no extracted content (contentHtml + blocks required)' })),
      'GeekAPI: pages carry no extracted content',
    );
  });

  it('says so rather than inventing a cause when nothing was recorded', () => {
    assert.equal(causeOf(record({ errorSummary: null })), 'no reason recorded');
  });
});

describe('summarizeFailures', () => {
  it('separates pages that are gone from pages still on disk', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'failures-report-'));
    try {
      await archiveRun(
        dataDir,
        record({
          runId: '11111111-1111-4111-8111-111111111111',
          createdAtUtc: '2026-09-30T01:00:00.000Z',
          pagesSaved: 342,
          errorSummary: 'POST /pages/batch → 500: {"error":"boom"}',
        }),
      );
      // A record from 2026-09-30 to 2026-10-05: archived without a purge, both fields null.
      await archiveRun(
        dataDir,
        record({
          runId: '22222222-2222-4222-8222-222222222222',
          createdAtUtc: '2026-09-30T02:00:00.000Z',
          pagesSaved: 180,
          purgedAtUtc: null,
          purge: null,
          errorSummary: 'POST /pages/batch → transport: fetch failed',
        }),
      );

      const summary = await summarizeFailures(dataDir);
      assert.equal(summary.total, 2);
      assert.equal(summary.purged, 1);
      assert.equal(summary.pagesLost, 342, 'only the purged run lost its pages');

      // Newest first, and it must sort on createdAtUtc: the unpurged record has no purge time.
      assert.equal(summary.records[0]?.runId, '22222222-2222-4222-8222-222222222222');

      const text = renderFailures(summary, dataDir);
      assert.match(text, /1 purged \(342 page\(s\) gone\), 1 not purged/);
      assert.match(text, /not purged\s+180 page\(s\)  22222222-2222-4222-8222-222222222222/);
      assert.doesNotMatch(text, /KEPT|re-post/);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('reports an empty archive as empty', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'failures-report-empty-'));
    try {
      const summary = await summarizeFailures(dataDir);
      assert.equal(summary.total, 0);
      assert.match(renderFailures(summary, dataDir), /No failure post-mortems/);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
