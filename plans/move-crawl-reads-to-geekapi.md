# The crawler service belongs on GeekAPI; this repo is egress, and exposes nothing

## The rule

**Public** — anything another product or a browser must reach. It lives in GeekAPI. There is no
second address for crawl data.

**The crawler service is GeekAPI's**, as it is for every other app on the platform. GeekAPI already
owns a crawler this way: `GccV2ProjectSiteCrawlService` holds the run lifecycle and crawls in
process — `GccV2ProjectSiteBfsCrawler`, `GeekCrawlerSitemapSeeder`, `GccV2ProjectSiteCrawlWake`,
`GccV2ProjectSiteCrawlRunCoordinator`, `GccV2ProjectSiteCrawlProgressNotifier` — with no external
crawler to call. Start is "create the run record, wake the crawler." That is the shape this crawler
was meant to have.

**Nothing callable here.** This repo is the egress half only: it fetches from the operator's own
network (README:5 — cloud IPs get flagged), extracts, and ingests. It exposes no HTTP surface at
all. `src/api/server.ts` and `cli.ts serve` are deleted — a port that accepts commands is a surface
whether or not it is documented, and `deploy/Dockerfile` (`ENTRYPOINT` → `serve`, `EXPOSE 8787`) is
one `railway up` from publishing it.

This is what the repo already requires — `.cursor/rules/no-retries-no-fallbacks.mdc`
(`alwaysApply: true`):

> - GeekAPI only for crawl authority (`GEEK_API_URL`, `GEEK_BACKEND_API_KEY`, `GEEK_USER_ID`).
> - No local mirror / failed stub as authority.

Today this repo does both jobs wrongly. Reads that must be public answer only here
(`GET :8787/crawls/{id}/pages`, the seed report, the failure archive), and the API serving them
binds every interface with no authentication of any kind (`server.ts:354` listens on `0.0.0.0`
while `:355` logs `127.0.0.1`). content-creator-v2 asking GeekAPI for a site's structure is how this
surfaced — the read that answers it properly lives here, behind a door that should not exist.

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
| Start · cancel | `POST :8787/crawls`, `/crawls/{id}/cancel` | GeekAPI + worker | ✅ front door exists — `:69`, `:215` |
| Delete · sweep-scratch | `server.ts:227`, `:304` | GeekAPI + worker | ❌ no public equivalent |
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

### 4. Control moves to GeekAPI; the crawler stops listening

GeekAPI fronts start (`:69`) and cancel (`:215`) already. **Delete** has no public equivalent; add
it there. That is the whole public control surface.

**Resume is not a gap.** All three resume routes answer `409 RESUME_FORBIDDEN` (`server.ts:187`)
because `.cursor/rules/no-retries-no-fallbacks.mdc` says *No resume of failed runs; start a new
run.* They must never be published. Delete the routes, their BFF proxies
(`web/src/app/api/crawls/[runId]/resume`, `/resume-by-url`, `/resume-running`) and the two home-page
controls (`resume-by-url-form.tsx`, `resume-all-running-button.tsx`) — a control that can only 409
is surface pretending to be a feature.

**How work reaches the crawler, with nothing listening — decide before scheduling this.**

| Option | Shape | Cost |
|---|---|---|
| **A. Wake over the hub** *(recommended)* | GeekAPI gains a `GeekCrawlerV2` service mirroring `GccV2ProjectSiteCrawlService` — run record, coordinator, progress notifier, `Wake`. Where the project-site service wakes an in-process crawler, this one raises a hub event; this repo joins `/hubs/geek-crawler-realtime` as a client and executes. Event-driven, so `.cursor/rules/description-prohibit-polling.mdc` holds; no inbound port; GeekAPI is the only front door | A hub client in `src/`; a `Wake` event GeekAPI-side |
| **B. Crawl in GeekAPI, like project-site** | Delete the egress split: GeekAPI crawls in process, the way `GccV2ProjectSiteBfsCrawler` does, and this repo retires | Crawl egress moves to the VPS — the thing README:5 exists to avoid |
| **C. CLI only** | `npm run crawl -- --seed … --type …` on the box. Already exists (`src/cli.ts`) | No remote start; the operator UI loses its start button |

Option A is the one that keeps both properties the platform already relies on: the service on
GeekAPI like every other app, and crawl egress on the operator's network.

**Not an option: the crawler polling GeekAPI for queued runs.** That is the prohibited pattern, and
this repo's `external` run status (README:178) exists precisely so GeekAPI's own worker does not
claim v2 runs — it is not a claim loop for this crawler to imitate.

### 5. GeekAPI — failure post-mortems *(public, new)*

Post-mortems describe runs that were purged and today exist only in `DATA_DIR` on the box. They must
be accessible, so the crawler ingests them at archive time (`src/storage/failure-archive.ts`) and
GeekAPI serves them. `GET :8787/failures` and `/failures/{id}` then go.

### 6. Crawler — delete the HTTP surface

`src/api/server.ts` goes, in full: the reads (`GET /crawls`, `/crawls/{runId}`,
`/crawls/{runId}/pages`, `/failures`, `/failures/{runId}`), the control verbs (`POST /crawls`,
`cancel`, `resume` ×3, `DELETE /crawls/{runId}`, `maintenance/sweep-scratch`) and `/health`. With it
go `cli.ts serve`, the `serve` npm script, `CRAWLEE_API_URL` everywhere it appears, and the
`EXPOSE 8787` / `ENTRYPOINT serve` in `deploy/Dockerfile` — a container whose entrypoint is a
listener is the same exposure by another route. `deploy/railway.toml`'s `/health` healthcheck goes
with it.

Until this lands the port is live on every interface with no auth, so if change 4's start path is
not ready, the interim is one line — `server.listen(port, '127.0.0.1', …)` — and not a substitute
for deleting it.

### 7. Crawler web — GeekAPI only, or not at all

With nothing listening on the crawl box, the operator UI has exactly one upstream: GeekAPI.

- `web/src/services/seed-report.ts` — delete `loadLocalRun` (`:125`), `tallyLocalPagesByOrigin`
  (`:247`) and the reconciliation between them and the GeekAPI snapshot.
  `web/src/app/api/crawls/[runId]/report/route.ts` becomes a proxy to change 3.
- Read proxies (`[runId]`, `/urls`, `/indexed-report`) stay — their only job is keeping
  `GEEK_API_URL` and the access token out of the browser.
- Control routes (`POST /crawls`, `cancel`, `delete`, `failures`, `resume-*`) repoint at GeekAPI or
  are deleted with the resume controls. `crawleeApiUrl()` and `CRAWLEE_API_URL` disappear from the
  repo, including `web/.env.example` and README.
- Under option B the UI keeps only reads, and starting a crawl is a terminal command.

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
5. `npm run serve` no longer exists, and `lsof -tiTCP:8787 -sTCP:LISTEN` is empty while a crawl runs.
6. `grep -rn "crawleeApiUrl\|CRAWLEE_API_URL\|8787" . --exclude-dir=node_modules` returns nothing.
7. `npm run typecheck` at this repo's root and in `web/`; `dotnet test` in GeekBackend.
