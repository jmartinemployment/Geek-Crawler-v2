/**
 * Cancellation requests for in-process crawls.
 *
 * Cancel is terminal, never a pause: a cancelled run stops fetching, keeps the
 * pages it already committed, and lands in `cancelled` status. Runs owned by a
 * different process are not reachable here — the API cancels those by patching
 * the run status directly.
 */

const requested = new Set<string>();

export function requestCancel(runId: string): void {
  requested.add(runId);
}

export function isCancelRequested(runId: string): boolean {
  return requested.has(runId);
}

export function clearCancel(runId: string): void {
  requested.delete(runId);
}
