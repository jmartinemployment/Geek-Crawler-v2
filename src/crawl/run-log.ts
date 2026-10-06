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
 * Logging must never end a crawl. A log file that cannot be opened or written
 * is reported once on the terminal and the run carries on without it.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
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
  /** False once the stream failed or was closed. Writes after that are dropped. */
  open: boolean;
};

const current = new AsyncLocalStorage<RunLogSink>();

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
      const sink = current.getStore();
      if (!sink || !sink.open) return;
      const text = stripVTControlCharacters(format(...args));
      // Crawlee's lines already open with their level; adding ours would say it twice.
      const level = CRAWLEE_LEVEL.test(text) ? '' : `${LEVEL[method]} `;
      sink.stream.write(`${new Date().toISOString()} ${level}${text}\n`);
    };
  }
}

export function runLogPath(dataDir: string, runId: string): string {
  return path.join(dataDir, 'logs', `${runId}.log`);
}

/**
 * Run fn with every console line it causes appended to the run's log file, and
 * still printed to the terminal as before. Resolves or rejects exactly as fn
 * does; the log file never changes the outcome.
 */
export async function withRunLog<T>(
  dataDir: string,
  runId: string,
  fn: () => Promise<T>,
): Promise<T> {
  installTee();
  const file = runLogPath(dataDir, runId);

  try {
    mkdirSync(path.dirname(file), { recursive: true });
  } catch (err) {
    original.error(
      `run log unavailable for ${runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return fn();
  }

  const stream = createWriteStream(file, { flags: 'a' });
  const sink: RunLogSink = { runId, stream, open: true };
  stream.on('error', (err) => {
    if (!sink.open) return;
    sink.open = false;
    original.error(`run log stopped for ${runId} (${file}): ${err.message}`);
  });

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
}
