import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCrawlPersist } from './persist.js';
import { listFailures, readFailure } from './failure-archive.js';

const RUN_ID = '33333333-4444-4555-8666-777777777777';

/**
 * GeekAPI stub. `deleteOk: false` makes the purge fail so the ordering rule can be asserted:
 * the post-mortem is written either way, the corpus is not destroyed on a failed purge.
 */
async function withStubbedGeekApi(
  opts: { deleteOk: boolean },
  body: (dataDir: string, deleteCalls: () => number) => Promise<void>,
): Promise<void> {
  let deleteCalls = 0;
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url?.endsWith('/ingest/runs')) {
      return res.end(
        JSON.stringify({
          run: { runId: RUN_ID, status: 'external', crawlType: 'partner' },
          seedsAccepted: 1,
          rejected: [],
        }),
      );
    }
    if (req.method === 'DELETE') {
      deleteCalls += 1;
      if (!opts.deleteOk) {
        res.statusCode = 500;
        return res.end(JSON.stringify({ error: 'purge refused' }));
      }
      return res.end(JSON.stringify({ vectorsPurged: true, crawlDataDeleted: true }));
    }
    if (req.method === 'PATCH') {
      return res.end(JSON.stringify({ runId: RUN_ID, status: 'failed', crawlType: 'partner' }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');

  const dataDir = await mkdtemp(path.join(tmpdir(), 'crawler-archive-'));
  const oldEnv = {
    url: process.env.GEEK_API_URL,
    key: process.env.GEEK_BACKEND_API_KEY,
    user: process.env.GEEK_USER_ID,
  };
  process.env.GEEK_API_URL = `http://127.0.0.1:${address.port}`;
  process.env.GEEK_BACKEND_API_KEY = 'test-key';
  process.env.GEEK_USER_ID = 'test-user';

  try {
    await body(dataDir, () => deleteCalls);
  } finally {
    if (oldEnv.url === undefined) delete process.env.GEEK_API_URL;
    else process.env.GEEK_API_URL = oldEnv.url;
    if (oldEnv.key === undefined) delete process.env.GEEK_BACKEND_API_KEY;
    else process.env.GEEK_BACKEND_API_KEY = oldEnv.key;
    if (oldEnv.user === undefined) delete process.env.GEEK_USER_ID;
    else process.env.GEEK_USER_ID = oldEnv.user;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

test('post-mortem survives the purge that destroys the run', async () => {
  await withStubbedGeekApi({ deleteOk: true }, async (dataDir) => {
    const persist = createCrawlPersist({
      crawlType: 'partner',
      seeds: ['https://example.com'],
      dataDir,
    });
    await persist.begin();
    persist.noteReject('robots_disallowed', 'https://example.com/private', 'robots.txt');
    persist.noteReject('extract_empty', 'https://example.com/shell', 'empty_or_spa_shell');

    // Scratch the purge is expected to remove.
    await mkdir(path.join(dataDir, '.crawlee', persist.runId), { recursive: true });
    await writeFile(path.join(dataDir, '.crawlee', persist.runId, 'queue.json'), '{}', 'utf8');

    await persist.markFailed('links/batch rejected the batch');
    await persist.archiveAndPurge('failed', 'links/batch rejected the batch');

    const record = await readFailure(dataDir, persist.runId);
    assert(record, 'a post-mortem must exist after the purge');
    assert.equal(record.status, 'failed');
    assert.equal(record.seed, 'https://example.com');
    assert.equal(record.errorSummary, 'links/batch rejected the batch');
    assert.equal(record.report.excludedByPolicy.robotsDisallowed, 1);
    assert.equal(record.report.failed.extractEmpty, 1);
    assert.equal(record.purge.vectorsPurged, true);
    assert.equal(record.purge.crawlDataDeleted, true);

    // The sample URLs are the point of keeping the record at all.
    const robots = record.rejectSamples.robots_disallowed ?? [];
    assert.equal(robots[0]?.url, 'https://example.com/private');

    assert.equal(
      await exists(path.join(dataDir, 'runs', persist.runId)),
      false,
      'local run directory must be gone',
    );
    assert.equal(
      await exists(path.join(dataDir, '.crawlee', persist.runId)),
      false,
      'request queue must be gone',
    );

    const all = await listFailures(dataDir);
    assert.equal(all.length, 1);
  });
});

test('a failed purge is recorded, and leaves local scratch in place', async () => {
  await withStubbedGeekApi({ deleteOk: false }, async (dataDir, deleteCalls) => {
    const persist = createCrawlPersist({
      crawlType: 'partner',
      seeds: ['https://example.com'],
      dataDir,
    });
    await persist.begin();
    await persist.archiveAndPurge('cancelled', 'Cancelled by operator');

    assert.equal(deleteCalls(), 1, 'exactly one purge attempt, no retry');

    const record = await readFailure(dataDir, persist.runId);
    assert(record);
    assert.equal(record.status, 'cancelled');
    assert.equal(record.purge.crawlDataDeleted, false);
    assert.equal(record.purge.vectorsPurged, false);
    assert(record.purge.errors?.some((e) => e.includes('deleteRun')));
    assert.deepEqual(record.purge.localRemoved, [], 'nothing local may go while rows survive');
    assert.equal(
      await exists(path.join(dataDir, 'runs', persist.runId)),
      true,
      'the local record must outlive a failed purge so the run stays accounted for',
    );
  });
});

test('an unwritable archive aborts before the purge', async () => {
  await withStubbedGeekApi({ deleteOk: true }, async (dataDir, deleteCalls) => {
    const persist = createCrawlPersist({
      crawlType: 'partner',
      seeds: ['https://example.com'],
      dataDir,
    });
    await persist.begin();

    // Block the archive write. Losing the corpus and its explanation together is the one
    // outcome the ordering exists to prevent.
    await mkdir(path.join(dataDir, 'failures'), { recursive: true });
    await chmod(path.join(dataDir, 'failures'), 0o500);

    await assert.rejects(() => persist.archiveAndPurge('failed', 'disk is read-only'));
    assert.equal(deleteCalls(), 0, 'nothing may be destroyed without a post-mortem');

    await chmod(path.join(dataDir, 'failures'), 0o700);
  });
});
