import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { log } from 'crawlee';
import { runLogPath, withRunLog } from './run-log.js';

async function dataDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'run-log-'));
}

test('two runs at once each keep only their own lines', async () => {
  const dir = await dataDir();
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

  await Promise.all([
    withRunLog(dir, 'run-a', async () => {
      for (let i = 0; i < 3; i += 1) {
        console.log(`a line ${i}`);
        await tick();
      }
    }),
    withRunLog(dir, 'run-b', async () => {
      for (let i = 0; i < 3; i += 1) {
        console.error(`b line ${i}`);
        await tick();
      }
    }),
  ]);

  const a = await readFile(runLogPath(dir, 'run-a'), 'utf8');
  const b = await readFile(runLogPath(dir, 'run-b'), 'utf8');
  assert.equal(a.trim().split('\n').length, 3);
  assert.equal(b.trim().split('\n').length, 3);
  assert.doesNotMatch(a, /b line/);
  assert.doesNotMatch(b, /a line/);
  assert.match(a, /^\d{4}-\d\d-\d\dT[\d:.]+Z INFO a line 0$/m);
  assert.match(b, /^\d{4}-\d\d-\d\dT[\d:.]+Z ERROR b line 0$/m);
});

test("crawlee's own log lines land in the run's file, without colour codes", async () => {
  const dir = await dataDir();

  await withRunLog(dir, 'run-c', async () => {
    log.warning('Request failed https://example.com/x: fetch failed');
  });

  const text = await readFile(runLogPath(dir, 'run-c'), 'utf8');
  assert.match(text, /WARN .*Request failed https:\/\/example\.com\/x: fetch failed/);
  assert.doesNotMatch(text, /\u001b\[/);
});

test('a line outside any run goes to no file', async () => {
  const dir = await dataDir();
  await withRunLog(dir, 'run-d', async () => {
    console.log('inside');
  });
  console.log('outside, after the run');

  const text = await readFile(runLogPath(dir, 'run-d'), 'utf8');
  assert.match(text, /inside/);
  assert.doesNotMatch(text, /outside/);
});

test('the run log appends, so a second write to one run keeps the first', async () => {
  const dir = await dataDir();
  await withRunLog(dir, 'run-e', async () => console.log('first'));
  await withRunLog(dir, 'run-e', async () => console.log('second'));

  const text = await readFile(runLogPath(dir, 'run-e'), 'utf8');
  assert.match(text, /first[\s\S]*second/);
});

test('the run outcome is unchanged: a value comes back, a rejection still rejects', async () => {
  const dir = await dataDir();
  assert.equal(await withRunLog(dir, 'run-f', async () => 42), 42);
  await assert.rejects(
    withRunLog(dir, 'run-g', async () => {
      throw new Error('crawl failed');
    }),
    /crawl failed/,
  );
});

test('a log directory that cannot be made does not stop the run', async () => {
  const dir = await dataDir();
  // A file where the logs directory should be, so mkdir fails for any user.
  await writeFile(path.join(dir, 'logs'), 'not a directory');

  const result = await withRunLog(dir, 'run-h', async () => {
    console.log('still crawling');
    return 'done';
  });

  assert.equal(result, 'done');
});
