import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readJsonRecord } from './read-record.js';
import { readFailure, listFailures } from './failure-archive.js';
import { createJsonRunStore } from './runs.js';

async function dir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'read-record-'));
}

test('missing, unreadable and ok are three different answers', async () => {
  const d = await dir();
  await writeFile(path.join(d, 'good.json'), '{"a":1}');
  await writeFile(path.join(d, 'empty.json'), '  ');
  await writeFile(path.join(d, 'bad.json'), '{"a":');
  await mkdir(path.join(d, 'adir.json'));

  assert.deepEqual(await readJsonRecord(path.join(d, 'good.json')), { kind: 'ok', value: { a: 1 } });
  assert.deepEqual(await readJsonRecord(path.join(d, 'none.json')), { kind: 'missing' });
  assert.deepEqual(await readJsonRecord(path.join(d, 'empty.json')), {
    kind: 'unreadable',
    reason: 'empty file',
  });
  const bad = await readJsonRecord(path.join(d, 'bad.json'));
  assert.equal(bad.kind, 'unreadable');
  assert.match(bad.kind === 'unreadable' ? bad.reason : '', /^invalid JSON: /);
  const adir = await readJsonRecord(path.join(d, 'adir.json'));
  assert.match(adir.kind === 'unreadable' ? adir.reason : '', /EISDIR/);
});

test('a corrupt run.json is not "run not found"', async () => {
  const d = await dir();
  await mkdir(path.join(d, 'runs', 'r1'), { recursive: true });
  await writeFile(path.join(d, 'runs', 'r1', 'run.json'), '{"runId":');
  const store = createJsonRunStore(d);

  await assert.rejects(store.getRun('r1'), /Run record unreadable: .*run\.json: invalid JSON/);
  assert.equal(await store.getRun('r2'), null, 'a run with no record is still not found');
  assert.deepEqual(await store.listRuns(), [], 'the corrupt record is left out of the listing');
});

test('a runs path that cannot be listed is an error, not an empty list', async () => {
  const d = await dir();
  await writeFile(path.join(d, 'runs'), 'not a directory');
  await assert.rejects(createJsonRunStore(d).listRuns(), /cannot list .*ENOTDIR/);
});

test('a corrupt post-mortem is raised with its cause, not answered as never archived', async () => {
  const d = await dir();
  await mkdir(path.join(d, 'failures'), { recursive: true });
  await writeFile(path.join(d, 'failures', 'r1.json'), 'not json');

  await assert.rejects(readFailure(d, 'r1'), /post-mortem unreadable: .*r1\.json: invalid JSON/);
  assert.equal(await readFailure(d, 'r2'), null);
  assert.deepEqual(await listFailures(d), [], 'left out of the listing, and logged');
});
