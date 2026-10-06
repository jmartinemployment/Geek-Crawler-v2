# Known E2E gaps

Crawl cancellation, the last end-to-end gap recorded here, is covered by
"cancelling a live crawl stops fetching and lands it in cancelled, never complete" in
tests/integration/api.integration.test.ts (2026-10-04).

## Counters that nothing increments (found 2026-10-06, deferred)

The fix-geek-crawler-v2 plan's Verification asks for "no counter in the report that nothing
increments". A code read on 2026-10-06 found three. Fixing them is not one of the plan's stages,
so by Jeff's decision they are recorded here and raised again once the plan is fully implemented
and tested. Until then that Verification line is not met.

| Counter | Where it is reported | Why it never moves |
|---|---|---|
| `enqueueSuppressedQueue` | `run.json`; the dedup counters in `hostProgressJson` sent to GeekAPI | Declared and set to 0 in `src/storage/page-dedup.ts`; nothing in `src` increments it |
| `browserRenders` | Same | Same. No page is rendered in a browser; link discovery's one browser load is not counted here |
| `pagesWithoutContent` in `run.json` | `run.json` | `src/storage/persist.ts` calls `recordAcceptedPage(runId, true)` with a literal `true`. The real count is kept in memory in the same file and decides content readiness, so `run.json` reads 0 even when pages without content were saved |

Every other counter was checked and has a code path that increments it: the remaining twelve
dedup counters, all seven reject reasons, the crawl report's `linksStored`, `excludedByPolicy`
and `failed`, and the discovery ledger's refusal rules, the four trap rules, the four enqueue
sources, and its scalar fields.

Proposed when raised: delete `enqueueSuppressedQueue` and `browserRenders`; pass the real value
to `recordAcceptedPage`. None of the three is read by the web UI.
