# Run cancel and delete

**Status: BUTTONS SHIP on the run detail page. The list has none, and delete leaves local traces.**

## Current state — verified 2026-09-17

Cancel and Delete both exist and work end to end.

| Piece | Where | State |
|-------|-------|-------|
| Buttons | `web/src/components/run-actions.tsx` | Built: Cancel, Delete behind a two-click confirm, pending/error text |
| Mounted | `web/src/app/runs/[runId]/page.tsx:16` | Run **detail** page only |
| Web proxies | `web/src/app/api/crawls/[runId]/cancel/route.ts`, `.../delete/route.ts` | Thin, pass status through |
| Crawler API | `src/api/server.ts:143` (cancel), `:171` (delete) | Live cancel → `requestCancel`; orphan → one `patchRun`; delete gated 409 on in-flight |
| GeekAPI client | `src/storage/geek-api-client.ts` | `deleteRun` returns `{vectorsPurged, crawlDataDeleted}` |

Verified against the live API today: `DELETE /crawls/{runId}` → `{"ok":true,"vectorsPurged":true,"crawlDataDeleted":true}`.

The previous version of this document said "Delete does not exist" and "no `DELETE` verb anywhere". Both were true when written and are false now. The GeekAPI endpoint that blocked it exists.

## What is actually missing

### 1. The list has no buttons, and does not list the runs you would want to kill

`/runs` renders `IndexedRunsReport` (`web/src/components/indexed-runs-report.tsx`), which shows **successfully indexed runs only** and offers no actions. Killing a run today means knowing its runId by heart and typing `/runs/<uuid>` into the address bar.

Worse, the runs most in need of cancelling never appear there at all. Nine runs on this machine are stuck in `running` with dead processes:

| Created | Pages | Links | Seed |
|---------|------:|------:|------|
| 2026-09-12 | 12,326 | 1,432,349 | clickup.com |
| 2026-09-10 | 307 | 36,158 | klaviyo.com |
| 2026-09-06 → 09-08 (×7) | 0 | 0 | speakai, leadsquared, botpenguin, zoho, clickup, chaserhq, publer |

`GET /crawls` (`src/api/server.ts:48`) already returns every run from local meta. Nothing renders it.

### 2. Delete leaves local traces, so a deleted run still shows up

`DELETE /crawls/{runId}` (`src/api/server.ts:171`) calls `deleteRun` and returns. It never touches:

- `DATA_DIR/runs/<runId>/` — `run.json`, `dedup.jsonl`, `dedup-skips.jsonl`
- `DATA_DIR/.crawlee/<runId>/` — request queue, key-value store

And `GET /crawls/{runId}` (`:125`) reads **local meta**, not GeekAPI. So immediately after a successful delete the run still renders with its old page count. Reproduced today on run `821bc3fc`: GeekAPI returned `crawlDataDeleted: true`, and the detail page kept reporting 80 pages until the two directories were removed by hand.

The UI says "Deleted. Pages, links, and vectors removed." while the run sits there unchanged. That reads as a broken delete.

### 3. Cancel is now destructive

**Changed 2026-09-17.** A cancelled run no longer keeps its pages. `cheerio-runner.ts` calls
`persist.archiveAndPurge('cancelled', …)` after `markCancelled`, which writes the post-mortem to
`DATA_DIR/failures/<runId>.json` and then destroys the run's pages, links, vectors, and local
scratch. The same happens on failure.

This reverses "Pages already committed stay committed. No rollback." from the fail-closed plan:
cancelling 400 pages into a 2500-page crawl now discards those 400. What survives is the report —
reject counters, sample URLs per reason, `errorSummary` — rendered at `/runs` by
`FailedRunsReport`. The Cancel button's wording should be updated to say so.

### 4. Buttons ignore status

`RunActions` renders both buttons unconditionally. Cancel shows on a `complete` run; Delete shows on a `running` one (the server correctly 409s, but it should not have been offered).

### 5. Confirmation is weaker than this plan specified

The prior plan required typing the runId to delete. Shipped code is a two-click confirm. For a 12,326-page corpus, two clicks is thin — but typing a UUID is friction on the 0-page orphans that make up most deletes. Resolve deliberately rather than by drift; see decision 1.

## Selected implementation

### A. A real runs list with actions

New `web/src/components/runs-table.tsx`, mounted on `/runs` above the indexed report. One `GET /api/crawls` fetch, one row per run, newest first: status, seed, crawl type, pages, links, created, and a `RunActions` cell.

`RunActions` already takes only `runId` and owns its own pending/error state, so it drops into a table cell unchanged apart from the status gating in C. Keep it the single implementation — no second inline copy of the buttons.

Rows carry `status`, so orphans are visible and reapable without leaving the page.

### B. Delete removes local traces too — one operation, one result

Extend the delete handler at `src/api/server.ts:171`:

1. `deleteRun(runId)` — GeekAPI first. It is the authority; if it fails, stop and return the failure. Nothing local is touched.
2. On success, remove `DATA_DIR/runs/<runId>/` and `DATA_DIR/.crawlee/<runId>/`.
3. Return `{ok, runId, vectorsPurged, crawlDataDeleted, localRemoved}`.

Ordering matters and is not arbitrary: authority first means a failed GeekAPI delete never leaves the local record orphaned from live server rows. A local removal that fails after a successful purge is reported in `localRemoved: false` — the run is gone from the authority either way, and the stale directory is inert scratch, not a second source of truth.

No fallback path, no partial-success wording, per the fail-closed law.

### C. Status-aware buttons

Pass the run's `status` into `RunActions`:

- Cancel renders only for non-terminal status (`pending`, `running`, `external`)
- Delete renders only for terminal status (`complete`, `failed`, `cancelled`)
- A terminal run shows Delete alone; an in-flight run shows Cancel alone

This makes the 409 guard unreachable from the UI while leaving it in place for direct API callers.

## Files to change

- `web/src/components/runs-table.tsx` — **new**, the list with an actions column
- `web/src/app/runs/page.tsx` — mount `RunsTable` above `IndexedRunsReport`
- `web/src/components/run-actions.tsx` — accept `status`, gate each button
- `src/api/server.ts` — delete handler also clears the two local directories and reports `localRemoved`
- `README.md` — delete removes local scratch as well as GeekAPI rows

## Verification

1. **Unit — gating.** Terminal status renders Delete and not Cancel; non-terminal renders Cancel and not Delete.
2. **Unit — delete order.** A failing `deleteRun` leaves both local directories in place and returns the failure; nothing local is removed.
3. **Integration — traces.** Delete a run created against a local fixture; assert GeekAPI purge, both directories gone, and `GET /crawls/{runId}` → 404.
4. **Integration — orphan reap from the list.** A run in `running` with no live process renders in the table, cancels to `cancelled` with `completedAtUtc` set, then deletes.
5. **Regression.** `npm test`, `npm run test:integration`, `npm run check:fail-closed` green.

## Out of scope

- Per-page or per-section deletion
- Resume after cancel — forbidden by policy
- Bulk select / delete-many across rows
- Soft discard (the reversible flag from the prior draft); hard delete now exists and works, so discard is a separate question, not a blocker

## Open decisions

1. **Delete confirmation strength.** Options: keep the two-click confirm everywhere; require typing the runId only above a page threshold (say 1,000); or require it always. Recommendation: threshold — it matches the risk, and most deletes are 0-page orphans.
2. **Does the runs table replace `IndexedRunsReport` or sit above it?** Recommendation: sit above. They answer different questions — "what is in my corpus" vs "what runs exist and what state are they in".
3. **The nine existing orphans.** Two hold real corpus (clickup 12,326 pages, klaviyo 307); seven hold nothing. Cancel all nine to make status honest, delete the seven empties, keep the two with data pending your call.
