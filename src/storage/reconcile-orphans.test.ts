import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_ORPHAN_STALE_MS,
  describeReconcileResult,
  reconcileOrphanedRuns,
} from './reconcile-orphans.js';
import type { CrawlRunMeta, RunStore } from './runs.js';

const NOW = Date.parse('2026-09-28T20:00:00.000Z');
const MINUTE = 60_000;

type FakeRun = {
  runId: string;
  status: CrawlRunMeta['status'];
  /** Minutes before NOW that run.json was last written. Null means no record. */
  writtenMinutesAgo: number | null;
};

function fakeStore(
  runs: FakeRun[],
  options?: { failWriteFor?: string },
): { store: RunStore; failed: Map<string, string> } {
  const failed = new Map<string, string>();
  const store = {
    async listRuns(): Promise<CrawlRunMeta[]> {
      return runs.map((r) => ({
        runId: r.runId,
        crawlType: 'partner',
        status: r.status,
        seeds: [`https://example.com/${r.runId}`],
        createdAtUtc: '2026-09-28T10:00:00.000Z',
        pagesSaved: 1,
        linksSaved: 1,
      })) as CrawlRunMeta[];
    },
    async lastWriteAt(runId: string): Promise<Date | null> {
      const run = runs.find((r) => r.runId === runId);
      if (!run || run.writtenMinutesAgo === null) return null;
      return new Date(NOW - run.writtenMinutesAgo * MINUTE);
    },
    async markFailed(runId: string, errorSummary: string): Promise<void> {
      if (options?.failWriteFor === runId) throw new Error('disk full');
      failed.set(runId, errorSummary);
    },
  } as unknown as RunStore;
  return { store, failed };
}

const noneLive = () => false;

test('a stale running run is marked failed and says why', async () => {
  const { store, failed } = fakeStore([
    { runId: 'stale-1', status: 'running', writtenMinutesAgo: 176 },
  ]);

  const result = await reconcileOrphanedRuns({ meta: store, isLive: noneLive, now: NOW });

  assert.equal(result.reconciled.length, 1);
  assert.equal(result.reconciled[0]!.runId, 'stale-1');
  assert.equal(result.reconciled[0]!.previousStatus, 'running');
  const summary = failed.get('stale-1');
  assert.ok(summary, 'markFailed was called');
  assert.match(summary, /orphaned/);
  assert.match(summary, /no writer at API startup/);
  // The timestamp is in the summary so the post-mortem says when it stopped,
  // not merely that it did.
  assert.match(summary, /176 min earlier/);
  assert.match(summary, /2026-09-28T17:04:00.000Z/);
});

test('a recently written run is left alone', async () => {
  // A live crawl rewrites its record constantly. Zero minutes stale is the
  // shape every genuinely running crawl had when this was measured.
  const { store, failed } = fakeStore([
    { runId: 'fresh', status: 'running', writtenMinutesAgo: 0 },
    { runId: 'just-inside', status: 'running', writtenMinutesAgo: 14 },
  ]);

  const result = await reconcileOrphanedRuns({ meta: store, isLive: noneLive, now: NOW });

  assert.deepEqual(result.reconciled, []);
  assert.deepEqual(result.skippedRecent.sort(), ['fresh', 'just-inside']);
  assert.equal(failed.size, 0);
});

test('a run this process is crawling is never touched, however stale the file', async () => {
  const { store, failed } = fakeStore([
    { runId: 'mine', status: 'running', writtenMinutesAgo: 9999 },
  ]);

  const result = await reconcileOrphanedRuns({
    meta: store,
    isLive: (runId) => runId === 'mine',
    now: NOW,
  });

  assert.deepEqual(result.reconciled, []);
  assert.deepEqual(result.skippedLive, ['mine']);
  assert.equal(failed.size, 0);
});

test('terminal statuses are not rewritten', async () => {
  const { store, failed } = fakeStore([
    { runId: 'done', status: 'complete', writtenMinutesAgo: 9999 },
    { runId: 'dead', status: 'failed', writtenMinutesAgo: 9999 },
    { runId: 'stopped', status: 'cancelled', writtenMinutesAgo: 9999 },
  ]);

  const result = await reconcileOrphanedRuns({ meta: store, isLive: noneLive, now: NOW });

  assert.deepEqual(result.reconciled, []);
  assert.equal(failed.size, 0);
});

test('pending counts as abandoned too', async () => {
  // A process that died between createRun and markRunning leaves pending set
  // forever, and nothing else ever clears it.
  const { store, failed } = fakeStore([
    { runId: 'never-started', status: 'pending', writtenMinutesAgo: 6295 },
  ]);

  const result = await reconcileOrphanedRuns({ meta: store, isLive: noneLive, now: NOW });

  assert.equal(result.reconciled.length, 1);
  assert.equal(result.reconciled[0]!.previousStatus, 'pending');
  assert.match(failed.get('never-started')!, /status pending/);
});

test('an unreadable record is reported, not assumed dead', async () => {
  const { store, failed } = fakeStore([
    { runId: 'no-stamp', status: 'running', writtenMinutesAgo: null },
  ]);

  const result = await reconcileOrphanedRuns({ meta: store, isLive: noneLive, now: NOW });

  assert.deepEqual(result.reconciled, []);
  assert.equal(failed.size, 0);
  assert.deepEqual(result.problems, [
    { runId: 'no-stamp', reason: 'no run.json timestamp' },
  ]);
});

test('one unwritable record does not stop the others being corrected', async () => {
  const { store, failed } = fakeStore(
    [
      { runId: 'a', status: 'running', writtenMinutesAgo: 200 },
      { runId: 'b', status: 'running', writtenMinutesAgo: 200 },
      { runId: 'c', status: 'running', writtenMinutesAgo: 200 },
    ],
    { failWriteFor: 'b' },
  );

  const result = await reconcileOrphanedRuns({ meta: store, isLive: noneLive, now: NOW });

  assert.deepEqual(
    result.reconciled.map((r) => r.runId),
    ['a', 'c'],
  );
  assert.deepEqual(result.problems, [{ runId: 'b', reason: 'disk full' }]);
  assert.deepEqual([...failed.keys()], ['a', 'c']);
});

test('the 2026-09-28 shape: two dead waves, live runs untouched', async () => {
  // Ten records stopped within the same second when a serve process died, and
  // eleven more dated from the Qdrant halt four days earlier. Seven crawls were
  // genuinely in flight at the time and had to survive.
  const runs: FakeRun[] = [];
  for (let i = 0; i < 7; i += 1) {
    runs.push({ runId: `live-${i}`, status: 'running', writtenMinutesAgo: 0 });
  }
  for (let i = 0; i < 10; i += 1) {
    runs.push({ runId: `serve-death-${i}`, status: 'running', writtenMinutesAgo: 176 });
  }
  for (let i = 0; i < 11; i += 1) {
    runs.push({ runId: `qdrant-halt-${i}`, status: 'running', writtenMinutesAgo: 6295 });
  }

  const live = new Set(runs.filter((r) => r.writtenMinutesAgo === 0).map((r) => r.runId));
  const { store, failed } = fakeStore(runs);

  const result = await reconcileOrphanedRuns({
    meta: store,
    isLive: (runId) => live.has(runId),
    now: NOW,
  });

  assert.equal(result.reconciled.length, 21);
  assert.equal(result.skippedLive.length, 7);
  assert.deepEqual(result.problems, []);
  for (const runId of live) assert.equal(failed.has(runId), false);
});

test('the default window sits between a live write cadence and a dead run', async () => {
  assert.equal(DEFAULT_ORPHAN_STALE_MS, 15 * 60 * 1000);
  // Bounds taken from measurement: live runs wrote continuously, the nearest
  // orphan had been silent for 176 minutes.
  assert.ok(DEFAULT_ORPHAN_STALE_MS > 5 * MINUTE);
  assert.ok(DEFAULT_ORPHAN_STALE_MS < 176 * MINUTE);
});

test('the summary lines name each corrected run', async () => {
  const { store } = fakeStore([
    { runId: 'stale-1', status: 'running', writtenMinutesAgo: 200 },
    { runId: 'no-stamp', status: 'running', writtenMinutesAgo: null },
    { runId: 'fresh', status: 'running', writtenMinutesAgo: 1 },
  ]);

  const lines = describeReconcileResult(
    await reconcileOrphanedRuns({ meta: store, isLive: noneLive, now: NOW }),
  );

  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /orphan reconciled: stale-1 was running, unwritten 200 min/);
  assert.match(lines[1]!, /orphan check problem: no-stamp - no run.json timestamp/);
  assert.match(lines[2]!, /left alone, written recently: 1 run\(s\)/);
});
