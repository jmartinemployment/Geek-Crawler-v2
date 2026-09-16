# Run cancel and delete

**Status: PLAN — not implemented.**

## Current state

**Cancel is a stub that does nothing.** `POST /crawls/{runId}/cancel`
(`src/api/server.ts:151`) adds the id to an in-process `Set` and returns
`ok: true` with the note "in-flight Crawlee stop hooks arrive in a later polish."
`isCancelRequested` (line 25) is **never called** — not in the request handler,
not in the autoscaled pool, nowhere. The only `crawler.stop()` calls
(`cheerio-runner.ts:206,365`) fire on persistence failure. The flag is also
process memory, so it cannot reach a crawl started by another process.

**Delete does not exist.** No `DELETE` verb anywhere in `src/` or `web/src/`; the
GeekAPI client (`src/storage/geek-api-client.ts`) implements only run create,
run patch, `pages/batch`, and `links/batch`.

**The gap is live.** Run `3427752f` (clickup.com) has sat in status `external`
since 2026-09-12 with `completedAtUtc: null` and 12,327 stored pages. Its process
is gone. There is no way to stop it, mark it terminal, or remove its pages.

## Capabilities

| Capability | Meaning | Terminal state |
|-----------|---------|----------------|
| **Cancel** | Stop a run that is (or may be) in flight; stop fetching, stop persisting | `status = cancelled`, `completedAtUtc` set, `markdownReadyAt` stays null |
| **Reap** | Mark an orphaned run terminal when no process owns it | Same as cancel; distinguished only by `errorSummary` |
| **Delete** | Remove a run and its pages and links | Row gone |

Cancel is a **terminal result**, not a pause. There is no resume — the existing
`RESUME_FORBIDDEN` response (`server.ts:146`) already states this policy, and a
cancelled run keeps whatever pages it saved. Those pages are never
markdown-ready, so they do not reach RAG.

## Cancel — selected implementation

| Concern | One implementation |
|---------|-------------------|
| Authority | **GeekAPI run status**, not process memory. A cancel is a `patchRun` to `cancelled`. |
| In-process `Set` | **Removed.** It is a second source of truth (fail-closed law). |
| Detection | The crawl polls its own run status on a fixed interval (default 10s) via one GET; `cancelled` → `crawler.stop()` |
| Poll failure | Treated as unknown, not as cancel. Two consecutive failures fail the run — an uncancellable crawl is worse than a stopped one. |
| After stop | One `patchRun` recording final counters, then exit nonzero |
| In-flight pages | Pages already committed stay committed. No rollback. |
| Orphan reap | Cancel on a run no process owns is the same single `patchRun`; it needs no live worker |
| Surface | `POST /crawls/{runId}/cancel` (crawler, replaces the stub) and a web route + button on the run detail page |

The 10s poll is one extra GET per interval per run. That is the price of a cancel
that works across processes and machines; an in-memory flag cannot do it.

## Delete — selected implementation

**Blocked on GeekAPI.** Deletion is a GeekAPI/Mongo operation
(`ContentCreatorV2/*`); this repo can only call it. Required server-side, and not
buildable here:

```
DELETE /api/geek-crawler/ingest/runs/{runId}
  → cascades pages + links for that run
  → 404 when unknown, 409 when the run is still running
  → returns { runId, pagesDeleted, linksDeleted }
```

Repo-side once that exists:

| Concern | One implementation |
|---------|-------------------|
| Client | `deleteRun(runId)` in `geek-api-client.ts`, one attempt, no retry |
| Guard | Refuse while `status` is `running`/`external` — cancel first, then delete |
| Confirmation | Web UI requires typing the runId; the CLI/API requires an explicit flag. No one-click delete of a 12,327-page corpus. |
| Scope | Whole run only. No per-page or per-section delete in this plan. |
| Audit | Log runId, seed, page count, and timestamp before the call |

### Soft delete first

Hard delete is irreversible and a wrong one costs a full re-crawl. A **discard**
flag on the run — excluded from reports, from RAG eligibility, and from the
indexed view, while the rows survive — covers most of what "delete" is wanted
for and is reversible. Recommended default, with hard delete reserved for
genuinely unwanted corpora. See decision 1.

## Files to change

- **`src/api/server.ts`** — replace the `cancellations` `Set` (lines 23-31) and
  the stub handler (line 151) with a `patchRun` to `cancelled`; return the
  patched snapshot. Add `DELETE /crawls/{runId}` gated on terminal status.
- **`src/storage/geek-api-client.ts`** — `getRun(runId)` for the poll,
  `deleteRun(runId)`; both single-attempt.
- **`src/crawl/cheerio-runner.ts`** — start the status poll in
  `prepareCheerioCrawl`; on `cancelled`, `crawler.stop()` and mark the run
  cancelled through the existing persist path; clear the timer in the `finally`.
- **`src/storage/persist.ts`** — `markCancelled(reason)` beside `markFailed`.
- **`src/storage/runs.ts`** — ensure `cancelled` is settable through the stats
  patch path.
- **`web/src/app/api/crawls/[runId]/cancel/route.ts`** (new) and
  **`.../delete/route.ts`** (new) — thin proxies.
- **Run detail page** — Cancel button for non-terminal runs; Delete behind typed
  confirmation for terminal ones.
- **`README.md`** — document both, and that cancel is terminal, not pause.

## Verification

1. **Unit — cancel patch.** Cancel issues exactly one `patchRun` with
   `cancelled`; a second cancel on an already-terminal run is a no-op 200, not a
   second write.
2. **Unit — poll.** `cancelled` triggers `crawler.stop()`; two consecutive poll
   failures fail the run; a single failure does not.
3. **Unit — delete guard.** Delete against a `running`/`external` run returns 409
   and issues no HTTP call.
4. **Integration — orphan reap.** Cancel run `3427752f` (no live process) and
   assert it lands `cancelled` with `completedAtUtc` set.
5. **Integration — live cancel.** Start a crawl against a local fixture, cancel
   mid-run, assert fetching stops, the run is `cancelled`, and pages already
   saved remain.
6. **Regression.** `npm test`, `npm run test:integration`,
   `npm run check:fail-closed` green.

## Out of scope

- Per-page or per-section deletion.
- Resume after cancel — forbidden by policy.
- Deleting pages from a run that stays alive.
- Building the GeekAPI endpoint itself (different repo).

## Open decisions

1. **Soft discard, hard delete, or both?** Recommendation: build discard first
   (reversible, no GeekAPI dependency beyond a flag), add hard delete when the
   endpoint exists.
2. **Who builds the GeekAPI `DELETE` endpoint?** Nothing in this repo can proceed
   on hard delete until it exists.
3. **Poll interval.** 10s proposed; shorter costs requests, longer leaves a crawl
   running after a cancel click.
4. **Does cancel imply discard?** A cancelled run's partial corpus is never
   markdown-ready, so it is already inert for RAG. Proposal: keep them separate.
