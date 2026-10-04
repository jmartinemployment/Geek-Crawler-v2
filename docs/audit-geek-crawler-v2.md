# Audit — Geek-Crawler-v2

**Role:** crawls seeds, extracts typed `blocks` + `contentHtml`, posts corpus to GeekAPI.
**Audited:** 2026-09-28 at `449b8ca`..`0789d4d`, working tree. Builds and tests pass
(160 unit, 4 integration, `check-fail-closed ok`).

## Status, 2026-10-04

Checked against the code at `f1356d9`. The findings below are kept as written on 2026-09-28.

- **F1, resolved.** Decided 2026-09-30: partner, competitors and local share one profile (2,500
  pages, `maxDepth: null`, quotas on), and composition is controlled by `EDITORIAL_SHARE` rather than
  by smaller budgets. Since `195e2df` (2026-10-04) the budget is the profile's alone, never sized
  from the sitemap. Plan items 5 and 6 are closed by that: no budget depends on the sitemap any more.
- **F2, resolved.** Startup reconciliation of runs left `running` with no writer landed in
  `5ab89dc`, and run records are touched on every write (`runs.ts` `touch`). Item 3 is moot: the
  Resume all running control was deleted in `1f8d4be`, and every resume route answers 409.
- **F3, open.** Pages are still sent one per `createPagesBatch` call (`persist.ts:650`), and the
  comment on `MAX_PAGES_PER_BATCH` does not say so.
- **F4, resolved** in `1970b9b`: the local page store that nothing wrote was removed.
- **F5, resolved.** `contentReadyAt` is kept on the local run record (`runs.ts` `markComplete`),
  and the report says which of absent, unreachable or error GeekAPI answered (`0007cb4`).

Also changed on 2026-10-04, outside these findings: the sitemap no longer limits which links are
followed, link-trap rules replace it, a discovery report counts every discovered URL, and the
classifier and quotas read one section vocabulary. See the README section Crawl scope.

---

## F1 — Two of three crawl-profile levers are inert on any site with a sitemap — **high**

**Evidence** — `src/crawl/crawl-profile.ts` defines per-type scope:

| type | `defaultMaxPages` | `maxDepth` | `useSectionQuotas` |
|---|---|---|---|
| partner | 2500 | null | true |
| competitors | **150** | **2** | true |
| local | **100** | **2** | true |
| project-site | 2500 | null | **false** |

Budget resolution, `src/crawl/cheerio-runner.ts:141-152`:

```
if      (caller passed maxRequestsPerCrawl) -> use it
else if (siteMap.hasMap)                    -> use sitemap URL count
else                                        -> use profile.defaultMaxPages
```

`defaultMaxPages` is the **`else`**. Any site with a sitemap never reaches it.

Depth, `cheerio-runner.ts:189`, applies to `childDepth` — links discovered on a fetched page. But
`src/crawl/sitemap.ts` `initialCrawlUrls` puts every sitemap URL into the **start** list, handed to
`crawler.run()` at `:464` with no depth recorded; `:243` reads it back as `depth ?? 0`. Every
sitemap URL is depth 0, so a cap of 2 can never exclude one.

**Observed consequence.** medius.com, crawled as `competitors` three times, returned **803, 896 and
897 pages** — never anything near 150. The profile's stated intent, *"a thin slice… you want their
services / about / pricing, not their blog archive"*, does not happen. On a site with a sitemap,
`competitors` and `partner` behave identically, because the only lever that fires
(`useSectionQuotas`) is `true` for both.

This is a documented property nothing enforces — the exact class named in the index.

**Fix** — decide first, then implement; do not change the numbers without deciding.

- **If the thin slice is the real intent:** `defaultMaxPages` must become a ceiling rather than a
  default, applied after sitemap sizing: `min(sitemapCount, profile.maxPages)`. Rename it
  `maxPages` so the name stops promising "default". Depth needs the same treatment or explicit
  removal — a cap that cannot fire is worse than none.
- **If sitemap-sized budgets are the real intent:** delete `defaultMaxPages` and `maxDepth` from
  `competitors` and `local`, and rewrite the profile doc to say scope is the sitemap minus quotas.
- **Either way:** a test per type asserting the effective budget on a site *with* a sitemap. The
  current tests never exercise the branch that runs in production.

**Do not act on this until Content Creator v2's consumption is confirmed** (index C1/C3). Changing
what is crawled before knowing what is read is how the previous round of breakage happened.

---

## F2 — Orphaned run stubs are never reconciled — **high**

**Evidence** — 21 local runs marked `"status": "running"` with no writer, observed 2026-09-28:

- 10 stopped writing at 13:33 within the same second — one serve process died and took them with it
- 11 dated 2026-09-24, from the Qdrant purge halt

`src/storage/runs.ts:208` sets `status = 'running'`; `:225` has `markFailed`. Nothing runs at
startup to reconcile a run marked `running` that has no in-flight worker. `src/api/server.ts:205`
knows the concept — *"one writer per run. An orphan has no writer, so the API is it"* — but that
path is reached only by an explicit cancel request.

**Consequences observed:**

- `GET /crawls` and the UI list dead runs as live
- "Resume all running" would re-attach 21 stubs, some superseded server-side
- A stale stub reads as live progress. During this session a netsuite run frozen at 13:33 was
  reported as "currently running, 490 pages" on the strength of its `run.json` — it had been dead
  for 2h40m.

**Fix**

1. On serve startup, load every local run with `status = 'running'`, and for each one not in
   `inFlight`, mark it `failed` with an explicit summary (`orphaned: no writer at startup`).
   Do not silently delete — the post-mortem is the value.
2. Record `lastWriteAtUtc` on the run record so staleness is visible without `stat`.
3. Make "Resume all running" skip any run whose GeekAPI snapshot 404s, and say how many it skipped.

---

## F3 — `MAX_PAGES_PER_BATCH = 100` is unreachable — **low**

`src/storage/ingest-limits.ts:37` caps pages per batch at 100. The only caller,
`src/storage/persist.ts:524`, passes a **single-element array literal**. The guard at
`geek-api-client.ts:236` can therefore never fire.

This is not harmless: the number is half of a cross-repo mirror (index C4), so it is maintained,
documented and asserted while describing a batching strategy that does not exist. It also made the
links bug look like an asymmetry — pages "stayed under their cap" only because pages are sent one
at a time.

**Fix** — either batch pages for real, or state in the constant's comment that pages are submitted
singly and the cap is a boundary guard rather than a batching target. The mirror with GeekAPI must
hold regardless.

---

## F4 — `pages.jsonl` and `links.jsonl` are created and left empty — **low**

`src/storage/runs.ts:148-149` compute paths for both; every run directory inspected contains them
at **0 bytes**, including completed runs. `src/api/server.ts:273` reads `pages.jsonl`.

An empty file that an endpoint reads is indistinguishable from a run that produced no pages.
During this audit these files were the obvious place to measure links-per-page and could not be
used.

**Fix** — populate them, or stop creating them and have the reader say "not available in api
mode". A zero-byte file that a route reads is a silent empty answer.

---

## F5 — `contentReadyAt` is sent but never stored locally — **low**

`src/storage/persist.ts:262-263` sends `contentReadyAt` / `clearContentReadyAt` to GeekAPI.
**No local run record carries the field** — 0 of 79 run files have the key.

`contentReadyAt` is the readiness signal the RAG Library filters on
(`mongo.find_smallest_content_ready_run`). Locally there is no way to tell whether a completed run
is eligible for indexing; the report endpoint falls back to the local stub and reports
`"GeekAPI unreachable — local stub only"` even when GeekAPI is healthy and simply does not hold
that run.

**Fix**

1. Persist `contentReadyAt` on the local run record when the PATCH succeeds.
2. Fix the misleading `failureReason`: distinguish *"GeekAPI unreachable"* from *"GeekAPI does not
   have this run"*. They mean opposite things, and the current wording sent this audit down a wrong
   path for several minutes.

---

## Plan

| # | action | effort | depends on |
|---|---|---|---|
| 1 | Startup reconciliation for orphaned `running` runs | small | — |
| 2 | Record `lastWriteAtUtc`; make staleness visible | small | — |
| 3 | Split "unreachable" from "not found" in the report | small | — |
| 4 | Persist `contentReadyAt` locally | small | — |
| 5 | Decide profile intent, then make levers match | medium | **index C1/C3 first** |
| 6 | Effective-budget test per crawl type, with a sitemap | small | 5 |
| 7 | Resolve `MAX_PAGES_PER_BATCH`: batch, or document | small | — |
| 8 | Populate or remove the empty `.jsonl` files | small | — |

1-4 are independent and safe to do now. 5-6 are blocked on knowing what consumes the corpus.

## Not findings

- Corpus format is clean: typed `blocks` at `extract-content.ts:183-190`, dispatched `:418-425`,
  no Markdown converter in `package.json` or transitively in the lockfile, no `#{1,6}` or
  `[text](href)` regex anywhere in `src`.
- Silent-failure architecture holds: the persist coordinator (`persist.ts:97-131`) serializes
  writes and latches the first failure, and the integration suite demonstrates a failed run
  purging itself with `linksSaved: 0`.
