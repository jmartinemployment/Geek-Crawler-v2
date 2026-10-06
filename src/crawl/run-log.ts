/**
 * Each run's own log lines, on disk, so they outlive the terminal.
 *
 * Until 2026-10-06 a run's log existed only in the terminal that ran serve. The
 * thirty runs that failed on 2026-10-05 left a one-line errorSummary and nothing
 * else: what each run was doing when it failed had scrolled away or died with
 * the window.
 *
 * One serve process crawls several runs at once, and every line goes through
 * the same console, so a process-wide capture cannot say which run a line
 * belongs to. The run is carried in AsyncLocalStorage instead: everything the
 * run starts, including the crawler's request handlers and its own internal
 * log lines, inherits the context and lands in that run's file. Crawlee's
 * logger prints through console too, so one tee on console covers both.
 *
 * The file is DATA_DIR/logs/<runId>.log, outside runs/ and .crawlee/, so the
 * purge that deletes a failed run leaves its log behind. That is the point:
 * the log is most needed for exactly the runs that get deleted.
 *
 * A run does not go on without its log. Until 2026-10-06 a log that could not be
 * opened or written was reported on the terminal and the run carried on without
 * it, which is the gap this file exists to close. Now a log that cannot be
 * opened fails the run before it crawls, and one that stops accepting writes is
 * reported through runLogFailure, which the runner checks and aborts on.
 *
 * Every line written outside a run goes to DATA_DIR/logs/process.log: the
 * startup passes and the runs they delete, robots refusals before a run exists,
 * unreadable-record reports from the API and the CLI, sweep errors, and the
 * server's own lines. A late line from a run that has already finished goes
 * there too, tagged with its run id. Until 2026-10-06 all of these reached only
 * the terminal. The process log is opened before a command does anything, and a
 * command does not run without it; one that stops accepting writes is reported
 * through processLogFailure.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createWriteStream, mkdirSync, openSync, type WriteStream } from 'node:fs';
import path from 'node:path';
import { format, stripVTControlCharacters } from 'node:util';

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug';
const METHODS: ConsoleMethod[] = ['log', 'info', 'warn', 'error', 'debug'];
const LEVEL: Record<ConsoleMethod, string> = {
  log: 'INFO',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
  debug: 'DEBUG',
};

/** The level word Crawlee's text logger opens each line with. */
const CRAWLEE_LEVEL = /^(DEBUG|INFO|WARN|ERROR|SOFT_FAIL|PERF)\b/;

type RunLogSink = {
  runId: string;
  stream: WriteStream;
  /** False once the stream failed or was closed. */
  open: boolean;
  /** Null until a write fails, then the error. The runner aborts the run on it. */
  failure: string | null;
};

const current = new AsyncLocalStorage<RunLogSink>();

type ProcessLogSink = {
  file: string;
  stream: WriteStream;
  open: boolean;
  /** Null until a write fails, then the error. */
  failure: string | null;
};

let processSink: ProcessLogSink | null = null;

/** The console as it was before the tee, so the tee's own reports cannot loop. */
const original: Record<ConsoleMethod, (...args: unknown[]) => void> = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

let installed = false;

function installTee(): void {
  if (installed) return;
  installed = true;
  for (const method of METHODS) {
    console[method] = (...args: unknown[]) => {
      original[method](...args);
      const text = stripVTControlCharacters(format(...args));
      // Crawlee's lines already open with their level; adding ours would say it twice.
      const level = CRAWLEE_LEVEL.test(text) ? '' : `${LEVEL[method]} `;
      const stamp = new Date().toISOString();
      const sink = current.getStore();
      if (sink?.open) {
        sink.stream.write(`${stamp} ${level}${text}\n`);
        return;
      }
      if (!processSink?.open) return;
      // Outside any run, or a late line from a run whose log is already closed.
      const tag = sink ? `[run ${sink.runId}] ` : '';
      processSink.stream.write(`${stamp} ${level}${tag}${text}\n`);
    };
  }
}

export function runLogPath(dataDir: string, runId: string): string {
  return path.join(dataDir, 'logs', `${runId}.log`);
}

export type RunLog = {
  file: string;
  /**
   * Run fn with every console line it causes appended to this log, and still
   * printed to the terminal. Resolves or rejects exactly as fn does.
   */
  run<T>(fn: () => Promise<T>): Promise<T>;
};

/**
 * Open the run's log file for appending. A failure is returned with its cause,
 * so the caller can fail the run on it rather than crawl without a log.
 */
export function openRunLog(
  dataDir: string,
  runId: string,
): { ok: true; log: RunLog } | { ok: false; reason: string } {
  installTee();
  const file = runLogPath(dataDir, runId);

  let fd: number;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    fd = openSync(file, 'a');
  } catch (err) {
    return { ok: false, reason: `${file}: ${err instanceof Error ? err.message : String(err)}` };
  }

  const stream = createWriteStream(file, { fd, flags: 'a' });
  const sink: RunLogSink = { runId, stream, open: true, failure: null };
  stream.on('error', (err) => {
    if (sink.failure) return;
    sink.failure = `${file}: ${err.message}`;
    sink.open = false;
    original.error(`run log stopped for ${runId}: ${sink.failure}`);
  });

  return {
    ok: true,
    log: {
      file,
      async run<T>(fn: () => Promise<T>): Promise<T> {
        original.log(`run log: ${file}`);
        try {
          return await current.run(sink, fn);
        } finally {
          // Anything the run left behind (a timer, a late callback) still carries
          // this context; closing the sink stops it writing to a finished stream.
          const wasOpen = sink.open;
          sink.open = false;
          if (wasOpen) {
            await new Promise<void>((resolve) => {
              stream.end(() => resolve());
            });
          }
        }
      },
    },
  };
}

/** The write failure of the run log in the current context, or null. */
export function runLogFailure(): string | null {
  return current.getStore()?.failure ?? null;
}

export function processLogPath(dataDir: string): string {
  return path.join(dataDir, 'logs', 'process.log');
}

/**
 * Open the process log for appending, before a command does anything else. A
 * failure is returned with its cause, so the command can refuse to run rather
 * than run with its lines going only to the terminal. Opening it again for the
 * same file is a no-op; for another file, the old one is closed first.
 */
export function openProcessLog(dataDir: string): { ok: true; file: string } | { ok: false; reason: string } {
  installTee();
  const file = processLogPath(dataDir);
  if (processSink?.open && processSink.file === file) return { ok: true, file };

  let fd: number;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    fd = openSync(file, 'a');
  } catch (err) {
    return { ok: false, reason: `${file}: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (processSink?.open) {
    processSink.open = false;
    processSink.stream.end();
  }
  const stream = createWriteStream(file, { fd, flags: 'a' });
  const sink: ProcessLogSink = { file, stream, open: true, failure: null };
  stream.on('error', (err) => {
    if (sink.failure) return;
    sink.failure = `${file}: ${err.message}`;
    sink.open = false;
    original.error(`process log stopped: ${sink.failure}`);
  });
  processSink = sink;
  original.log(`process log: ${file}`);
  return { ok: true, file };
}

/** Null while the process log is open and writing; otherwise why it is not. */
export function processLogFailure(): string | null {
  if (!processSink) return 'process log was never opened';
  return processSink.failure;
}
