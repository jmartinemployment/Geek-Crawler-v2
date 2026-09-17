"use client";

import { useState } from "react";

type Props = { runId: string };

/**
 * Cancel and Delete for one run.
 *
 * Both are destructive and neither can be undone. Cancel stops the crawl and
 * then discards it — pages, links, vectors and local scratch — keeping only the
 * post-mortem, which appears in the Purged Runs report. Delete does the same to
 * a run that has already finished.
 */
export function RunActions({ runId }: Props) {
  const [pending, setPending] = useState<null | "cancel" | "delete">(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function post(action: "cancel" | "delete") {
    setPending(action);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch(`/api/crawls/${encodeURIComponent(runId)}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      const body = await res.json();
      if (!res.ok) {
        setError(`${res.status}: ${body.error ?? body.message ?? JSON.stringify(body)}`);
        return;
      }
      if (action === "cancel") {
        setMessage(
          body.orphan
            ? "No crawl process owned this run — marked cancelled."
            : "Cancelling — the crawl stops after its current page, then the run is discarded. Its report stays in Purged Runs.",
        );
      } else {
        // localFailed only appears when scratch survived the purge. The rows are gone either
        // way, so this is a leftover-directory notice, not a failed delete.
        const leftover = Array.isArray(body.localFailed) ? body.localFailed.length : 0;
        setMessage(
          leftover > 0
            ? `Deleted. Pages, links, and vectors removed; ${leftover} local ${
                leftover === 1 ? "directory" : "directories"
              } could not be cleared.`
            : "Deleted. Pages, links, vectors, and all local traces removed.",
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
      setConfirming(false);
    }
  }

  return (
    <div className="stack">
      <div className="row">
        <button type="button" onClick={() => post("cancel")} disabled={pending !== null}>
          {pending === "cancel" ? "Cancelling…" : "Cancel crawl"}
        </button>

        {confirming ? (
          <>
            <button type="button" onClick={() => post("delete")} disabled={pending !== null}>
              {pending === "delete" ? "Deleting…" : "Yes, delete permanently"}
            </button>
            <button type="button" onClick={() => setConfirming(false)} disabled={pending !== null}>
              Keep it
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setConfirming(true)} disabled={pending !== null}>
            Delete run
          </button>
        )}
      </div>

      {confirming ? (
        <p className="muted">
          This removes every page, link, vector, and local trace of this run. Only its
          report survives, in Purged Runs. It cannot be undone.
        </p>
      ) : null}
      {message ? <p className="muted">{message}</p> : null}
      {error ? <pre className="result">{error}</pre> : null}
    </div>
  );
}
