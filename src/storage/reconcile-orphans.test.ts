import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_ORPHAN_STALE_MS,
  describeReconcileResult,
  reconcileOrphanedRuns,
  reconcileSupersededRuns,
} from './reconcile-orphans.js';
import type { RunPresence } from './geek-api-client.js';
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
  options?: { failWriteFor?: string; presenceFor?: Record<string, RunPresence> },
): {
  store: RunStore;
  purged: Set<string>;
  purge: (runId: string) => Promise<void>;
  presence: (runId: string) => Promise<RunPresence>;
} {
  const purged = new Set<string>();
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
  } as unknown as RunStore;
  // Stands in for the GeekAPI-then-local deletion the server performs.
  const purge = async (runId: string): Promise<void> => {
    if (options?.failWriteFor === runId) throw new Error('GeekAPI unreachable');
    purged.add(runId);
  };
  // Stands in for GeekAPI. A run it was not told about is still running there,
  // which is what an interrupted crawl looks like from GeekAPI's side.
  const presence = async (runId: string): Promise<RunPresence> =>
    options?.presenceFor?.[runId] ?? { kind: 'present', status: 'running' };
  return { store, purged, purge, presence };
}

const noneLive = () => false;

test('a stale running run is deleted and says why', async () => {
  const { store, purged, purge, presence } = fakeStore([
    { runId: 'stale-1', status: 'running', writtenMinutesAgo: 176 },
  ]);

  const result = await reconcileOrphanedRuns({ meta: store, purge, presence, isLive: noneLive, now: NOW });

  assert.equal(result.reconciled.length, 1);
  assert.equal(result.reconciled[0]!.runId, 'stale-1');
  assert.equal(result.reconciled[0]!.previousStatus, 'running');
  assert.ok(purged.has('stale-1'), 'purge was called');
  const summary = result.reconciled[0]!.summary;
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
  const { store, purged, purge, presence } = fakeStore([
    { runId: 'fresh', status: 'running', writtenMinutesAgo: 0 },
    { runId: 'just-inside', status: 'running', writtenMinutesAgo: 14 },
  ]);

  const result = await reconcileOrphanedRuns({ meta: store, purge, presence, isLive: noneLive, now: NOW });

  assert.deepEqual(result.reconciled, []);
  assert.deepEqual(result.skippedRecent.sort(), ['fresh', 'just-inside']);
  assert.equal(purged.size, 0);
});

test('a run this process is crawling is never touched, however stale the file', async () => {
  const { store, purged, purge, presence } = fakeStore([
    { runId: 'mine', status: 'running', writtenMinutesAgo: 9999 },
  ]);

  const result = await reconcileOrphanedRuns({
    meta: store,
    purge,
    presence,
    isLive: (runId) => runId === 'mine',
    now: NOW,
  });

  assert.deepEqual(result.reconciled, []);
  assert.deepEqual(result.skippedLive, ['mine']);
  assert.equal(purged.size, 0);
});

test('terminal statuses are not rewritten', async () => {
  const { store, purged, purge, presence } = fakeStore([
    { runId: 'done', status: 'complete', writtenMinutesAgo: 9999 },
    { runId: 'dead', status: 'failed', writtenMinutesAgo: 9999 },
    { runId: 'stopped', status: 'cancelled', writtenMinutesAgo: 9999 },
  ]);

  const result = await reconcileOrphanedRuns({ meta: store, purge, presence, isLive: noneLive, now: NOW });

  assert.deepEqual(result.reconciled, []);
  assert.equal(purged.size, 0);
});

test('pending counts as abandoned too', async () => {
  // A process that died between createRun and markRunning leaves pending set
  // forever, and nothing else ever clears it.
  const { store, purged, purge, presence } = fakeStore([
    { runId: 'never-started', status: 'pending', writtenMinutesAgo: 6295 },
  ]);

  const result = await reconcileOrphanedRuns({ meta: store, purge, presence, isLive: noneLive, now: NOW });

  assert.equal(result.reconciled.length, 1);
  assert.equal(result.reconciled[0]!.previousStatus, 'pending');
  assert.ok(purged.has('never-started'));
  assert.match(result.reconciled[0]!.summary, /status pending/);
});

test('an unreadable record is reported, not assumed dead', async () => {
  const { store, purged, purge, presence } = fakeStore([
    { runId: 'no-stamp', status: 'running', writtenMinutesAgo: null },
  ]);

  const result = await reconcileOrphanedRuns({ meta: store, purge, presence, isLive: noneLive, now: NOW });

  assert.deepEqual(result.reconciled, []);
  assert.equal(purged.size, 0);
  assert.deepEqual(result.problems, [
    { runId: 'no-stamp', reason: 'no run.json timestamp' },
  ]);
});

test('one run that cannot be deleted does not stop the others', async () => {
  const { store, purged, purge, presence } = fakeStore(
    [
      { runId: 'a', status: 'running', writtenMinutesAgo: 200 },
      { runId: 'b', status: 'running', writtenMinutesAgo: 200 },
      { runId: 'c', status: 'running', writtenMinutesAgo: 200 },
    ],
    { failWriteFor: 'b' },
  );

  const result = await reconcileOrphanedRuns({ meta: store, purge, presence, isLive: noneLive, now: NOW });

  assert.deepEqual(
    result.reconciled.map((r) => r.runId),
    ['a', 'c'],
  );
  assert.deepEqual(result.problems, [{ runId: 'b', reason: 'GeekAPI unreachable' }]);
  assert.deepEqual([...purged], ['a', 'c']);
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
  const { store, purged, purge, presence } = fakeStore(runs);

  const result = await reconcileOrphanedRuns({
    meta: store,
    purge,
    presence,
    isLive: (runId) => live.has(runId),
    now: NOW,
  });

  assert.equal(result.reconciled.length, 21);
  assert.equal(result.skippedLive.length, 7);
  assert.deepEqual(result.problems, []);
  for (const runId of live) assert.equal(purged.has(runId), false);
});

test('the default window sits between a live write cadence and a dead run', async () => {
  assert.equal(DEFAULT_ORPHAN_STALE_MS, 15 * 60 * 1000);
  // Bounds taken from measurement: live runs wrote continuously, the nearest
  // orphan had been silent for 176 minutes.
  assert.ok(DEFAULT_ORPHAN_STALE_MS > 5 * MINUTE);
  assert.ok(DEFAULT_ORPHAN_STALE_MS < 176 * MINUTE);
});

test('the summary lines name each corrected run', async () => {
  const { store, purge, presence } = fakeStore([
    { runId: 'stale-1', status: 'running', writtenMinutesAgo: 200 },
    { runId: 'no-stamp', status: 'running', writtenMinutesAgo: null },
    { runId: 'fresh', status: 'running', writtenMinutesAgo: 1 },
  ]);

  const lines = describeReconcileResult(
    await reconcileOrphanedRuns({ meta: store, purge, presence, isLive: noneLive, now: NOW }),
  );

  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /orphan deleted: stale-1 was running, unwritten 200 min/);
  assert.match(lines[1]!, /orphan check problem: no-stamp - no run.json timestamp/);
  assert.match(lines[2]!, /left alone, written recently: 1 run\(s\)/);
});

test('the 2026-10-06 shape: a run GeekAPI shows complete survives a stale running record', async () => {
  // ramp.com 4563f7ec was completed by hand: GeekAPI holds it complete while
  // run.json still says running. Thirty runs from 2026-10-05 GeekAPI holds as
  // external, never finished, and those are what the pass exists to remove.
  const runs: FakeRun[] = [{ runId: 'ramp', status: 'running', writtenMinutesAgo: 900 }];
  const presenceFor: Record<string, RunPresence> = {
    ramp: { kind: 'present', status: 'complete' },
  };
  for (let i = 0; i < 30; i += 1) {
    runs.push({ runId: `external-${i}`, status: 'running', writtenMinutesAgo: 1500 });
    presenceFor[`external-${i}`] = { kind: 'present', status: 'external' };
  }
  const { store, purged, purge, presence } = fakeStore(runs, { presenceFor });

  const result = await reconcileOrphanedRuns({ meta: store, purge, presence, isLive: noneLive, now: NOW });

  assert.equal(purged.has('ramp'), false, 'a complete run on GeekAPI is never purged');
  assert.deepEqual(result.skippedComplete, ['ramp']);
  assert.equal(result.reconciled.length, 30);
  assert.equal(purged.size, 30);
});

test('no usable answer from GeekAPI deletes nothing', async () => {
  const { store, purged, purge, presence } = fakeStore(
    [
      { runId: 'unreachable', status: 'running', writtenMinutesAgo: 200 },
      { runId: 'no-status', status: 'running', writtenMinutesAgo: 200 },
    ],
    {
      presenceFor: {
        unreachable: { kind: 'unknown', reason: 'transport: fetch failed' },
        'no-status': { kind: 'present', status: null },
      },
    },
  );

  const result = await reconcileOrphanedRuns({ meta: store, purge, presence, isLive: noneLive, now: NOW });

  assert.equal(purged.size, 0);
  assert.deepEqual(result.reconciled, []);
  assert.deepEqual(result.unknown, [
    { runId: 'unreachable', reason: 'transport: fetch failed' },
    { runId: 'no-status', reason: 'GeekAPI answered without a run status' },
  ]);
});

test('a lookup that throws is a problem, not a deletion', async () => {
  const { store, purged, purge } = fakeStore([
    { runId: 'throws', status: 'running', writtenMinutesAgo: 200 },
  ]);

  const result = await reconcileOrphanedRuns({
    meta: store,
    purge,
    presence: async () => {
      throw new Error('lookup exploded');
    },
    isLive: noneLive,
    now: NOW,
  });

  assert.equal(purged.size, 0);
  assert.deepEqual(result.problems, [{ runId: 'throws', reason: 'lookup exploded' }]);
});

test('GeekAPI is not asked about a run written recently', async () => {
  const asked: string[] = [];
  const { store, purge } = fakeStore([{ runId: 'fresh', status: 'running', writtenMinutesAgo: 1 }]);

  await reconcileOrphanedRuns({
    meta: store,
    purge,
    presence: async (runId) => {
      asked.push(runId);
      return { kind: 'present', status: 'running' };
    },
    isLive: noneLive,
    now: NOW,
  });

  assert.deepEqual(asked, []);
});

test('the summary names a run left alone because GeekAPI shows it complete', async () => {
  const { store, purge, presence } = fakeStore(
    [{ runId: 'ramp', status: 'running', writtenMinutesAgo: 900 }],
    { presenceFor: { ramp: { kind: 'present', status: 'complete' } } },
  );

  const lines = describeReconcileResult(
    await reconcileOrphanedRuns({ meta: store, purge, presence, isLive: noneLive, now: NOW }),
  );

  assert.deepEqual(lines, ['  left alone, complete on GeekAPI: ramp (local record says running)']);
});

// --- superseded runs: completed locally, gone from GeekAPI ---

type PresenceMap = Record<string, RunPresence>;

function supersededStore(runs: Array<{ runId: string; status: CrawlRunMeta['status']; seed: string }>) {
  const removed: string[] = [];
  const store = {
    async listRuns(): Promise<CrawlRunMeta[]> {
      return runs.map((r) => ({
        runId: r.runId,
        crawlType: 'partner',
        status: r.status,
        seeds: [r.seed],
        createdAtUtc: '2026-09-29T10:00:00.000Z',
        pagesSaved: 10,
        linksSaved: 10,
      })) as CrawlRunMeta[];
    },
  } as unknown as RunStore;
  return { store, removed };
}

test('a completed run GeekAPI no longer holds is removed', async () => {
  const { store, removed } = supersededStore([
    { runId: 'gone', status: 'complete', seed: 'https://lightyear.cloud' },
  ]);

  const result = await reconcileSupersededRuns({
    meta: store,
    isLive: () => false,
    presence: async () => ({ kind: 'absent' }),
    remove: async (runId) => {
      removed.push(runId);
    },
  });

  assert.deepEqual(removed, ['gone']);
  assert.equal(result.removed.length, 1);
  assert.deepEqual(result.removed[0]!.seeds, ['https://lightyear.cloud']);
});

test('an unreachable GeekAPI removes nothing', async () => {
  // The property that matters most: deletion requires an answer. If every
  // lookup fails, every record survives.
  const { store, removed } = supersededStore([
    { runId: 'a', status: 'complete', seed: 'https://a.example' },
    { runId: 'b', status: 'complete', seed: 'https://b.example' },
  ]);

  const result = await reconcileSupersededRuns({
    meta: store,
    isLive: () => false,
    presence: async () => ({ kind: 'unknown', reason: 'transport: ECONNREFUSED' }),
    remove: async (runId) => {
      removed.push(runId);
    },
  });

  assert.deepEqual(removed, []);
  assert.deepEqual(result.removed, []);
  assert.equal(result.unknown.length, 2);
});

test('a 5xx is not absence', async () => {
  const { store, removed } = supersededStore([
    { runId: 'x', status: 'complete', seed: 'https://x.example' },
  ]);

  await reconcileSupersededRuns({
    meta: store,
    isLive: () => false,
    presence: async () => ({ kind: 'unknown', reason: 'HTTP 503' }),
    remove: async (runId) => {
      removed.push(runId);
    },
  });

  assert.deepEqual(removed, [], 'a 503 must never delete local data');
});

test('runs GeekAPI still holds are kept', async () => {
  const { store, removed } = supersededStore([
    { runId: 'live', status: 'complete', seed: 'https://live.example' },
  ]);

  const result = await reconcileSupersededRuns({
    meta: store,
    isLive: () => false,
    presence: async () => ({ kind: 'present', status: 'complete' }),
    remove: async (runId) => {
      removed.push(runId);
    },
  });

  assert.deepEqual(removed, []);
  assert.deepEqual(result.kept, ['live']);
});

test('only completed runs are considered; a failed record is its post-mortem', async () => {
  const { store, removed } = supersededStore([
    { runId: 'failed', status: 'failed', seed: 'https://failed.example' },
    { runId: 'running', status: 'running', seed: 'https://running.example' },
    { runId: 'pending', status: 'pending', seed: 'https://pending.example' },
  ]);

  await reconcileSupersededRuns({
    meta: store,
    isLive: () => false,
    presence: async () => ({ kind: 'absent' }),
    remove: async (runId) => {
      removed.push(runId);
    },
  });

  assert.deepEqual(removed, [], 'non-complete records are not this pass to remove');
});

test('a run this process is crawling is never removed', async () => {
  const { store, removed } = supersededStore([
    { runId: 'mine', status: 'complete', seed: 'https://mine.example' },
  ]);

  await reconcileSupersededRuns({
    meta: store,
    isLive: (runId) => runId === 'mine',
    presence: async () => ({ kind: 'absent' }),
    remove: async (runId) => {
      removed.push(runId);
    },
  });

  assert.deepEqual(removed, []);
});

test('the 2026-09-29 shape: 42 superseded, 12 held', async () => {
  const runs: Array<{ runId: string; status: CrawlRunMeta['status']; seed: string }> = [];
  for (let i = 0; i < 42; i += 1) {
    runs.push({ runId: `old-${i}`, status: 'complete', seed: `https://site-${i % 10}.example` });
  }
  for (let i = 0; i < 12; i += 1) {
    runs.push({ runId: `held-${i}`, status: 'complete', seed: `https://held-${i}.example` });
  }
  const presence: PresenceMap = {};
  for (const r of runs) presence[r.runId] = r.runId.startsWith('old-')
    ? { kind: 'absent' }
    : { kind: 'present', status: 'complete' };

  const { store, removed } = supersededStore(runs);
  const result = await reconcileSupersededRuns({
    meta: store,
    isLive: () => false,
    presence: async (runId) => presence[runId]!,
    remove: async (runId) => {
      removed.push(runId);
    },
  });

  assert.equal(result.removed.length, 42);
  assert.equal(result.kept.length, 12);
  assert.deepEqual(result.unknown, []);
  assert.deepEqual(result.problems, []);
});
