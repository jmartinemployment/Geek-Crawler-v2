import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, after } from 'node:test';
import { createPageDedupTracker } from '../storage/page-dedup.js';
import { contentHash, htmlHash } from '../crawl/dedup.js';

describe('PageDedupTracker reservations', () => {
  let tmp = '';
  after(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it('owner commits → waiter skips; owner releases → waiter proceeds', async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'page-dedup-'));
    const runId = 'run-a';
    await mkdir(path.join(tmp, 'runs', runId), { recursive: true });
    const t = createPageDedupTracker({ dataDir: tmp, runId });
    const ownedA = new Set<string>();
    const ownedB = new Set<string>();
    const key = 'https://n8n.io/x';

    const r1 = await t.reserve({ urlKey: key }, ownedA);
    assert.equal(r1.state, 'reserved');

    const r2 = await t.reserve({ urlKey: key }, ownedB);
    assert.equal(r2.state, 'in_flight');

    const waiter = t.awaitInFlight(r2, 5_000);
    await t.commitAccepted({
      v: 1,
      pageId: 'p1',
      at: new Date().toISOString(),
      requestedUrlKey: key,
      finalUrlKey: key,
      htmlHash: htmlHash('<html/>'),
      contentHash: contentHash('body text here'),
    });
    const w = await waiter;
    assert.equal(w.skip, true);
    if (w.skip) assert.equal(w.cause, 'in_flight');

    // Fresh tracker: release path
    const t2 = createPageDedupTracker({ dataDir: tmp, runId: 'run-b' });
    await mkdir(path.join(tmp, 'runs', 'run-b'), { recursive: true });
    const o1 = new Set<string>();
    const o2 = new Set<string>();
    await t2.reserve({ urlKey: key }, o1);
    const pending = t2.reserve({ urlKey: key }, o2).then((r) => t2.awaitInFlight(r, 5_000));
    t2.release({ urlKey: key });
    const afterRelease = await pending;
    assert.equal(afterRelease.skip, false);
  });

  it('wait timeout lets waiter proceed (duplicate ok)', async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'page-dedup-'));
    const runId = 'run-c';
    await mkdir(path.join(tmp, 'runs', runId), { recursive: true });
    const t = createPageDedupTracker({ dataDir: tmp, runId });
    const o1 = new Set<string>();
    const o2 = new Set<string>();
    const key = 'https://n8n.io/timeout';
    await t.reserve({ urlKey: key }, o1);
    const r2 = await t.reserve({ urlKey: key }, o2);
    const w = await t.awaitInFlight(r2, 20);
    assert.equal(w.skip, false);
  });

  it('rehydrate tolerates truncated final JSONL line', async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'page-dedup-'));
    const runId = 'run-d';
    const dir = path.join(tmp, 'runs', runId);
    await mkdir(dir, { recursive: true });
    const good = {
      v: 1,
      pageId: 'p',
      at: new Date().toISOString(),
      requestedUrlKey: 'https://n8n.io/a',
      finalUrlKey: 'https://n8n.io/a',
      contentHash: contentHash('hello world article text'),
    };
    await writeFile(
      path.join(dir, 'dedup.jsonl'),
      `${JSON.stringify(good)}\n{"v":1,"pageId":"trunc`,
      'utf8',
    );
    const t = createPageDedupTracker({ dataDir: tmp, runId });
    await t.rehydrate();
    const owned = new Set<string>();
    const r = await t.reserve({ urlKey: 'https://n8n.io/a' }, owned);
    assert.equal(r.state, 'accepted');
  });

  it('missing ledger warns and sets dedupLedgerBackfilled false', async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'page-dedup-'));
    const runId = 'run-e';
    await mkdir(path.join(tmp, 'runs', runId), { recursive: true });
    const t = createPageDedupTracker({ dataDir: tmp, runId });
    await t.rehydrate();
    assert.equal(t.dedupLedgerBackfilled, false);
  });

  it('canonical group skips variants but not the canonical URL itself', async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'page-dedup-'));
    const runId = 'run-f';
    await mkdir(path.join(tmp, 'runs', runId), { recursive: true });
    const t = createPageDedupTracker({ dataDir: tmp, runId });
    const canon = 'https://n8n.io/real';
    t.registerCanonicalGroup(canon, 'p1', 'https://n8n.io/variant');
    assert.equal(t.checkCanonicalAlias('https://n8n.io/variant2', canon), 'canonical_alias');
    assert.equal(t.checkCanonicalAlias(canon, canon), null);
  });

  it('contentHash duplicate skips; case differs', async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'page-dedup-'));
    const runId = 'run-g';
    await mkdir(path.join(tmp, 'runs', runId), { recursive: true });
    const t = createPageDedupTracker({ dataDir: tmp, runId });
    const md = 'Hello World Content '.repeat(40);
    t.noteContentAccepted({
      simhash: '0'.repeat(16),
      contentHash: contentHash(md),
      pageId: 'p1',
      url: 'https://n8n.io/a',
      markdownLength: md.length,
      excerpt: md.slice(0, 40),
    });
    const dup = await t.checkContentAndNear({
      markdown: md,
      url: 'https://n8n.io/b',
    });
    assert.equal(dup.skip, true);
    if (dup.skip) assert.equal(dup.reason, 'duplicate_content');

    const cased = await t.checkContentAndNear({
      markdown: md.toLowerCase(),
      url: 'https://n8n.io/c',
    });
    // May be near-dup or accept depending on simhash; must not be exact content hash match
    if (cased.skip) {
      assert.notEqual(cased.reason, 'duplicate_content');
    }
  });
});
