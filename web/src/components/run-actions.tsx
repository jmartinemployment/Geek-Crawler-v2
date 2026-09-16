"use client";

import { useState } from "react";

type Props = { runId: string };

/**
 * Cancel and Delete for one run.
 *
 * Cancel is terminal: the crawl stops, keeps the pages it already saved, and
 * lands in `cancelled`. Delete removes the run's pages, links, and vectors and
 * cannot be undone, so it asks first.
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
            : "Cancelling — the crawl stops after its current page.",
        );
      } else {
        setMessage("Deleted. Pages, links, and vectors removed.");
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
          This removes every page, link, and vector for this run. It cannot be undone.
        </p>
      ) : null}
      {message ? <p className="muted">{message}</p> : null}
      {error ? <pre className="result">{error}</pre> : null}
    </div>
  );
}
