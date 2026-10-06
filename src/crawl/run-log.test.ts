import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { log } from 'crawlee';
import {
  openProcessLog,
  openRunLog,
  processLogFailure,
  processLogPath,
  runLogFailure,
  runLogPath,
} from './run-log.js';

async function withRunLog<T>(dataDir: string, runId: string, fn: () => Promise<T>): Promise<T> {
  const opened = openRunLog(dataDir, runId);
  assert(opened.ok, opened.ok ? '' : opened.reason);
  return opened.log.run(fn);
}

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

test('a log directory that cannot be made is a failure with its cause, not a run without a log', async () => {
  const dir = await dataDir();
  // A file where the logs directory should be, so mkdir fails for any user.
  await writeFile(path.join(dir, 'logs'), 'not a directory');

  const opened = openRunLog(dir, 'run-h');

  assert.equal(opened.ok, false);
  assert.match(opened.ok ? '' : opened.reason, /logs[\\/]run-h\.log: /);
});

test('a log file that cannot be opened is a failure with its cause', async () => {
  const dir = await dataDir();
  // A directory where the log file should be, so opening it for append fails.
  await mkdir(runLogPath(dir, 'run-i'), { recursive: true });

  const opened = openRunLog(dir, 'run-i');

  assert.equal(opened.ok, false);
  assert.match(opened.ok ? '' : opened.reason, /EISDIR/);
});

test('a run whose log is writing reports no log failure', async () => {
  const dir = await dataDir();
  const seen = await withRunLog(dir, 'run-j', async () => {
    console.log('writing');
    return runLogFailure();
  });
  assert.equal(seen, null);
});

// Lines written outside a run reached only the terminal until 2026-10-06: the startup passes and
// the runs they delete, robots refusals, unreadable-record reports, sweep errors.
test('a line outside any run goes to the process log, and a run line does not', async () => {
  const dir = await dataDir();
  const opened = openProcessLog(dir);
  assert(opened.ok);
  assert.equal(processLogFailure(), null);

  console.error('startup: orphan deleted: run-x');
  await withRunLog(dir, 'run-k', async () => {
    console.log('inside run-k');
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  const text = await readFile(processLogPath(dir), 'utf8');
  assert.match(text, /^\d{4}-\d\d-\d\dT[\d:.]+Z ERROR startup: orphan deleted: run-x$/m);
  assert.doesNotMatch(text, /inside run-k/);
  assert.match(await readFile(runLogPath(dir, 'run-k'), 'utf8'), /inside run-k/);
});

test('a late line from a finished run goes to the process log, tagged with its run', async () => {
  const dir = await dataDir();
  assert(openProcessLog(dir).ok);
  await withRunLog(dir, 'run-l', async () => {
    // A timer the run leaves behind fires after the run's log has closed, still in its context.
    setTimeout(() => console.warn('late callback'), 20);
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 60));

  assert.match(await readFile(processLogPath(dir), 'utf8'), /WARN \[run run-l\] late callback/);
  assert.doesNotMatch(await readFile(runLogPath(dir, 'run-l'), 'utf8'), /late callback/);
});

test('a process log that cannot be opened is a failure with its cause', async () => {
  const dir = await dataDir();
  await mkdir(processLogPath(dir), { recursive: true });
  const opened = openProcessLog(dir);
  assert.equal(opened.ok, false);
  assert.match(opened.ok ? '' : opened.reason, /process\.log: .*EISDIR/);
});
