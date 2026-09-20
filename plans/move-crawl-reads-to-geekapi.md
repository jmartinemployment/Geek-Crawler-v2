# Public crawl endpoints belong to GeekAPI; this crawler's API is private

## The rule

**Public** — anything another product or a browser must reach. It lives in GeekAPI. There is no
second address for crawl data.

**Private** — `src/api/server.ts`. Internal process control on the crawl box, bound to loopback,
called by the co-located operator UI and nothing else. It is not a product surface, it is not
documented for consumers, and no other repo may hold its URL.

This is what the repo already requires — `.cursor/rules/no-retries-no-fallbacks.mdc`
(`alwaysApply: true`):

> - GeekAPI only for crawl authority (`GEEK_API_URL`, `GEEK_BACKEND_API_KEY`, `GEEK_USER_ID`).
> - No local mirror / failed stub as authority.

Today the split is wrong in both directions: reads that must be public are private
(`GET :8787/crawls/{id}/pages`, the seed report, the failure archive), and the private API is bound
to every interface with no auth. content-creator-v2 asking GeekAPI for a site's structure is how
this surfaced — the read that answers it properly lives here.

## What exists

Verified 2026-09-20 against each repo's working HEAD.

| Read | Today | Must be | GeekAPI |
|---|---|---|---|
| Run snapshot | `GET :8787/crawls/{id}` — `src/api/server.ts:179` — **and** GeekAPI | public | ✅ `crawls/{runId}` — `GeekCrawlerController.cs:153` |
| Run list | `GET :8787/crawls` — `server.ts:73` | public | ✅ `crawls`, `crawls/latest` — `:197`, `:118` |
| Page list **with `blocks`** | `GET :8787/crawls/{id}/pages` — `server.ts:270`, reads `pages.jsonl` off disk | public | ✅ `crawls/{runId}/pages` — `:226`; DTO carries `ContentHtml` + `Blocks` — `GeekCrawlerDtos.cs:59-60` |
| Page URLs | BFF proxy — `web/src/app/api/crawls/[runId]/urls/route.ts` | public | ✅ `crawls/{runId}/page-urls` — `:246` |
| Links · RAG index status | — | public | ✅ `:268` · `:167` |
| **Site structure (heading tree)** | Does not exist here | public | ⚠️ built from **raw HTML** — see below |
| **Seed / coverage report** | `web/src/services/seed-report.ts` — 405 lines, reads the private API **and** GeekAPI and reconciles them (`:128`, `:162`, `:214`, `:253`) | public | ❌ none |
| **Failure post-mortems** | `GET :8787/failures`, `/failures/{id}` — `server.ts:289`, `:294`, local `DATA_DIR` | public | ❌ none |
| Start · cancel | `POST :8787/crawls`, `/crawls/{id}/cancel` | private executor | ✅ front door exists — `:69`, `:215` |
| Delete · sweep-scratch | `server.ts:227`, `:304` | private executor | ❌ no public equivalent |
| Resume (3 routes) | `server.ts:187` — answer **409 `RESUME_FORBIDDEN`** | neither | ❌ none wanted |

Two apparent gaps are not gaps. The reject counters and per-host rows the seed report reads from the
private API are **already in GeekAPI** — `persist.ts:184` `crawlReport()` and `:205`
`hostProgressJson()` ride the terminal `patchRun` (`:259`, `:276`, `:303`) into
`GeekCrawlerRun.CrawlReportJson` and `HostProgressJson`. The private read is a duplicate source,
which is the thing the rule forbids.

## The structure read, specifically

content-creator-v2 calls `GET api/geek-content-creator-v2/project-site/runs/{runId}/site-hierarchy`
(`content-creator-v2/src/services/gcc-api.ts:846`). It exists —
`GccV2ProjectSiteController.cs:187` — and `GccV2SiteHierarchyFromCrawl.Build` assembles the tree
with `GccV2HeadingTreeBuilder.Build(p.Html!)`.

It re-parses markup because it has nothing else: `GccV2ProjectSiteCrawlPageDto` (`GccV2Dtos.cs:269`)
carries `Html` and no `Blocks`. That is a different, older store from the geek-crawler pages this
crawler ingests.

So heading levels and anchors are derived **twice**, from two representations — once in
`src/crawl/extract-content.ts` into typed `blocks`, once again in C# out of raw HTML. Same drift
class as CLAUDE.md §1a. The crawler already emits `heading`(+`level`), `anchors` and `rel` per
block; GeekAPI should read those, not re-infer them.

## Changes

### 1. GeekAPI — `GET api/geek-crawler/crawls/{runId}/site-structure` *(public, new)*

New action on `GeekCrawlerController`, same guards as its neighbours (`if (!_user.IsAuthenticated)
return Unauthorized(); if (!await OwnsRunAsync(runId, ct)) return NotFound();`).

Assembles the per-page heading tree **from stored `blocks`**:

- Walk a page's blocks in order. A `heading` block opens a node at its `level`, popping the stack
  while the top is at the same level or deeper. `paragraph` / `listItem` / `quote` / `code` / `row`
  attach to the open node; their `anchors` become that node's links (`text`, `href`, `rel`).
- Response matches the models content-creator-v2 already types — `homepageUrl`, `viewport`,
  `builtAtUtc`, `pages[] { pageUrl, roots[] { level, headingText, paragraphs[], links[], children[] } }`
  (`gcc-api.ts:810-834`) — so the consumer changes only which URL it calls.
- Pages carrying no `blocks` are **excluded and counted**, and the count is on the response. A run
  whose pages have `html` and no `blocks` must read as exactly that, never as an empty tree.
- No fallback to parsing `contentHtml` when `blocks` is absent. Missing blocks is terminal for that
  page, per CLAUDE.md §2.

It belongs on the geek-crawler surface, not the ContentCreator one: it is crawl data, and
ContentCreatorV2 is one consumer of it.

### 2. GeekAPI — `site-hierarchy` delegates to it

`GccV2ProjectSiteController`'s `runs/{runId}/site-hierarchy` calls the service behind change 1 and
keeps its own page filter (homepage + tool/use-case hubs + pages with 2+ link groups,
`GccV2SiteHierarchyFromCrawl.MinLinksForSignal`). `GccV2HeadingTreeBuilder`'s HTML path is deleted
once nothing calls it — one derivation of structure, not two.

If the project-site store holds pages the geek-crawler store does not, establish that first; the
check is whether both are populated for the same `runId`.

### 3. GeekAPI — `GET api/geek-crawler/crawls/{runId}/seed-report` *(public, new)*

Port `buildSeedReportForRun` (`web/src/services/seed-report.ts:276`) server-side. Every input is
already in Mongo: `SeedUrlsJson`, `Status`, `CrawlType`, `HostProgressJson`, `CrawlReportJson`,
`ContentReadyAt`, plus a `page-urls` tally by origin for per-seed counts. Keep the semantics of
`statusDescription`, `originKey` and `completedLabel` as they read today.

State the one real gap rather than papering it: `CrawlReportJson` and `HostProgressJson` are written
**only** on the terminal `patchRun`. For a run still in flight the report is built from pages
ingested so far and says so — it does not invent counters that have not arrived.

### 4. Control verbs — one to add, three to delete

GeekAPI fronts start (`:69`) and cancel (`:215`) already. **Delete** has no public equivalent; add
it, dispatching to the private executor the way start does.

**Resume is not a gap.** All three resume routes answer `409 RESUME_FORBIDDEN` (`server.ts:187`)
because `.cursor/rules/no-retries-no-fallbacks.mdc` says *No resume of failed runs; start a new
run.* They must never be published. Delete the routes, their BFF proxies
(`web/src/app/api/crawls/[runId]/resume`, `/resume-by-url`, `/resume-running`) and the two home-page
controls (`resume-by-url-form.tsx`, `resume-all-running-button.tsx`) — a control that can only 409
is surface pretending to be a feature.

**Open, and a GeekBackend question:** whether GeekAPI can reach the crawl box at all. README:178
notes v2 ingest runs use status `external` precisely so GeekAPI's .NET worker does not claim them,
so the dispatch path for a v2 run needs confirming before delete is fronted. If GeekAPI cannot reach
the box, control stays loopback-only and the operator UI stays co-located — consistent with the
rule either way, because control is private.

### 5. GeekAPI — failure post-mortems *(public, new)*

Post-mortems describe runs that were purged and today exist only in `DATA_DIR` on the box. They must
be accessible, so the crawler ingests them at archive time (`src/storage/failure-archive.ts`) and
GeekAPI serves them. `GET :8787/failures` and `/failures/{id}` then go.

### 6. Crawler — make the private API private

- Delete the public reads: `GET /crawls`, `GET /crawls/{id}`, `GET /crawls/{id}/pages`,
  `GET /failures`, `GET /failures/{id}`.
- Keep the executor verbs: `POST /crawls`, `/crawls/{id}/cancel`, `/crawls/{id}/resume`,
  `/crawls/resume-by-url`, `/crawls/resume-running`, `DELETE /crawls/{id}`,
  `POST /maintenance/sweep-scratch`, `GET /health`.
- **Bind loopback.** `server.listen(port, …)` at `:354` binds every interface while `:355` prints
  `http://127.0.0.1:${port}`, and the file has no auth of any kind — unauthenticated `POST /crawls`
  and `DELETE /crawls/{id}` answer anything that can route to that port. Pass `'127.0.0.1'`
  explicitly. README:5 already claims this ("both run on localhost"); a documented safety property
  no code enforces is the §2 failure, and this is one.

### 7. Crawler web — GeekAPI for every read

- `web/src/services/seed-report.ts` — delete `loadLocalRun` (`:125`), `tallyLocalPagesByOrigin`
  (`:247`) and the reconciliation between them and the GeekAPI snapshot.
  `web/src/app/api/crawls/[runId]/report/route.ts` becomes a proxy to change 3.
- Read proxies (`[runId]`, `/urls`, `/indexed-report`) stay — their only job is keeping
  `GEEK_API_URL` and the token out of the browser.
- Control routes keep calling the private API over loopback while the UI is co-located with the
  crawler; they repoint at GeekAPI if and when change 4's dispatch question is answered.
- No file outside `web/src/app/api/**` may hold `crawleeApiUrl()`.

### 8. content-creator-v2 — call the real endpoint

Replace the `TEMPORARY TEST` block in `src/services/gcc-api.ts:797-856` with a permanent client
against change 1, through the `/api/cw` proxy as now. The response models already match, so
`SiteHeadingHierarchy.tsx` and the `ProjectForm.tsx` harness change only by losing their "remove
once the real display lands" comments.

## Sitemap counts are not an endpoint

`web/src/services/sitemap-count.ts` is outbound only: it fetches the **crawled site's** `robots.txt`
and its `Sitemap:` entries (≤40 sitemaps, ≤50k URLs) and counts them. Nothing serves a sitemap, here
or in GeekAPI, and nothing in this plan adds one.

The fetch stays in the crawler, which already egresses to that site; a read on GeekAPI must not
reach out to a customer's domain. The counts (`sitemapUrlCount`, `sitemapPathCount`,
`sitemapSources`) ship once at run start as fields on the run, and GeekAPI serves stored numbers
inside change 3's response — where `expectedPageTotal` (`crawl-limits.ts`, capped 2500) measures
coverage against them.

## Not in this plan

- **No change to ingest.** The crawler keeps writing `contentHtml` + `blocks` through
  `api/geek-crawler/ingest/*`, fail-closed, one attempt.
- **No Markdown, no second block→text projection.** Structure is read from typed `blocks`; joining
  blocks into a string stays `Geek-Crawler-Rag/block_text.py`'s single job.
- **No polling.** Live run status stays on the SignalR hub, per
  `.cursor/rules/description-prohibit-polling.mdc`.
- **No decision on whether `web/` survives.** After changes 6 and 7 it is a GeekAPI client plus
  co-located control buttons. Keeping it or folding it elsewhere changes nothing above.

## Supersedes

`plans/site-structure-view.md` — it builds the structure view in this repo's UI and adds another
`pages` proxy here. Delete it when change 1 lands.

## Verify

1. `GET api/geek-crawler/crawls/{runId}/site-structure` on a completed project-site run: headings
   nest by level, anchor counts are non-zero on pages that link out, and the tree matches what the
   page plainly contains.
2. The same run through content-creator-v2's wizard renders the tree it renders today.
3. A run crawled before typed blocks landed reports every page excluded for missing `blocks` — not
   an empty tree, not a tree rebuilt from HTML.
4. `GET api/geek-crawler/crawls/{runId}/seed-report` matches the current `/runs` report for a
   terminal run; for an in-flight run it reports pages-so-far and no invented counters.
5. From another machine on the LAN, every crawler port request is refused after the loopback bind.
6. `grep -rn "crawleeApiUrl" web/src` returns hits only under `web/src/app/api/`.
7. `npm run typecheck` at this repo's root and in `web/`; `dotnet test` in GeekBackend.
