/**
 * Read one JSON record from disk, and say which of three things happened.
 *
 * Until 2026-10-06 each reader here returned null for any problem: a missing
 * file, an I/O error, an empty file and invalid JSON all read as "no record".
 * A corrupt run.json made its run "not found", and a corrupt post-mortem was
 * left out of the report with nothing to say it existed.
 *
 * missing     the file does not exist (ENOENT). A fact, not logged.
 * unreadable  it exists and could not be read or parsed. Logged with its path
 *             and reason as RECORD_UNREADABLE, so the caller never has to.
 */

import { readFile } from 'node:fs/promises';

export type RecordRead<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'missing' }
  | { kind: 'unreadable'; reason: string };

export function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

export function logUnreadable(file: string, reason: string): void {
  console.error(JSON.stringify({ code: 'RECORD_UNREADABLE', file, reason: reason.slice(0, 500) }));
}

export async function readJsonRecord<T>(file: string): Promise<RecordRead<T>> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (isMissing(err)) return { kind: 'missing' };
    const reason = err instanceof Error ? err.message : String(err);
    logUnreadable(file, reason);
    return { kind: 'unreadable', reason };
  }
  if (!raw.trim()) {
    logUnreadable(file, 'empty file');
    return { kind: 'unreadable', reason: 'empty file' };
  }
  try {
    return { kind: 'ok', value: JSON.parse(raw) as T };
  } catch (err) {
    const reason = `invalid JSON: ${err instanceof Error ? err.message : String(err)}`;
    logUnreadable(file, reason);
    return { kind: 'unreadable', reason };
  }
}
