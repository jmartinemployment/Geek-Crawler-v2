# Show a run's site structure in the crawler's own UI

> **Superseded 2026-09-20 by [`move-crawl-reads-to-geekapi.md`](./move-crawl-reads-to-geekapi.md).**
> Site structure is a public read, so it belongs in GeekAPI built from typed `blocks` — not in this
> repo's UI behind another local proxy. Kept only for the block→tree walk and the three empty
> states, which that plan reuses.

## Why here

The crawler produces the structure and owns it. `extract-content.ts` emits typed `blocks` —
`heading`(+`level`), `paragraph`, `listItem`, `quote`, `code`, `row`, `term`, `definition`, each
carrying `text`, `html`, `anchors` — and nothing downstream can recover heading levels or anchors
once they are flattened. The place to see what a crawl actually captured is the crawl's own run page.

`/runs/[runId]` already shows the seed report and the URL table. It shows *which* URLs were fetched
and says nothing about what came back. This adds that.

## What exists

| Piece | State |
|---|---|
| `web/src/app/runs/[runId]/page.tsx` | Renders `RunActions` + `RunLiveView` |
| `web/src/components/run-live-view.tsx` | Calls `/api/crawls/{runId}`, `/report`, `/urls` |
| `web/src/app/api/crawls/[runId]/urls/route.ts` | Proxy → `{GeekAPI}/api/geek-crawler/crawls/{runId}/page-urls` |
| `web/src/services/` | Holds the modules that talk to another system: `crawl-hub.ts`, `seed-report.ts`, `sitemap-count.ts`, `auth/tokens.ts`. Components still fetch inline |
| **`GET {GeekAPI}/api/geek-crawler/crawls/{runId}/pages`** | **Already returns `blocks` verbatim** — `GeekCrawlerController.cs:226`, paged, `limit` clamped 1–500 |

So the data is already served and the proxy pattern already exists. Nothing new is needed in
GeekAPI or in the crawler's own `src/api/server.ts`.

## Changes

### 1. Proxy route — `web/src/app/api/crawls/[runId]/pages/route.ts`

Has to live here: Next's file-system routing means the path **is** the URL. This file is the only
part that cannot sit in `services/`.

Mirror `urls/route.ts` exactly — same `geekApiUrl()` + `geekApiHeaders()`, same `limit`/`offset`
clamping, same error passthrough. Target
`{GeekAPI}/api/geek-crawler/crawls/{runId}/pages?limit=&offset=`.

Default `limit` low — **25** — and **strip `html` from each record before returning it**. Page HTML
is the bulk of corpus size and this view renders `blocks`, not markup; the browser should never be
handed megabytes it does not display.

**Auth is already solved by the pattern.** `geekApiHeaders()` sends `X-API-Key` +
`X-Geek-User-Id`; GeekAPI's `ApiKeyMiddleware` validates the key against `GEEK_BACKEND_API_KEY` and
builds a `ClaimsPrincipal` from the user id, so `_user.IsAuthenticated` is true and `OwnsRunAsync`
has a user to compare against. Nothing new to configure.

**But visibility is scoped to `GEEK_USER_ID`, not the signed-in operator.** That env var is a single
fixed id, so the UI acts as one user on every GeekAPI call — a run owned by anyone else returns
**404**, not 403. That is the existing behaviour of every sibling route, not something this change
introduces; it just needs saying, so a 404 here is read as "not that user's run" rather than a bug in
the view.

### 2. Service layer — `web/src/services/crawler-api.ts`

`web/src/services/` exists; `run-live-view.tsx` still calls `fetch("/api/crawls/…")` inline three
times, so the URLs, the response shapes and the error handling are spread through a component.
content-creator-v2 does it the right way in `src/services/gcc-api.ts`, and this should match.

Put the typed browser client there:

- `listRunPages(runId, limit, offset)` → the proxy route above, returning typed
  `CrawlRunPage[]` with `blocks`
- Block and page types alongside it. Type `blocks` loosely — GeekAPI carries them through as opaque
  JSON, so a strict type here would assert a contract no hop enforces.

Components import from `@/services/crawler-api` and hold no URLs.

**Follow-on, not this plan:** move `run-live-view.tsx`'s three inline fetches
(`/api/crawls/{runId}`, `/report`, `/urls`) into the same file. Worth doing once the directory
exists, but it is a refactor of working code and does not belong in a change about site structure.

### 3. Component — `web/src/components/site-structure.tsx`

Build the heading tree from `blocks`:

- Walk blocks in order; a `heading` block opens a node at its `level`, popping the stack while the
  top is at the same level or deeper. Non-heading blocks attach to the open node.
- Per node show `H{level} {text}` indented by depth, plus an anchor count where blocks carry
  `anchors`.
- Per page show url, status, block-kind counts and total anchors — the two numbers that prove levels
  and anchors survived extraction.

Three states, each said plainly, none of them a placeholder:

| State | Show |
|---|---|
| No pages stored / GeekAPI 404s | "No pages stored for this run" |
| Pages present, `blocks` empty or absent | **"Pages have no blocks"** — an extraction failure, red, not an empty tree |
| Blocks present, no `heading` block | "No headings on this page" under the page row |

That middle row is the point of the view. A page stored with `html` and no `blocks` is exactly the
drift that emptied the corpus before, and it currently shows up nowhere.

### 4. Render — `web/src/app/runs/[runId]/page.tsx`

Add `<SiteStructure runId={runId} />` below `RunLiveView`. Collapsed by default; a run can be
thousands of pages and this is a spot-check, not a report.

## The backend split this sits inside

GeekAPI is the intended public surface, and the endpoints that were only reachable through this
repo's `src/api/server.ts` are moving there. The web UI is mid-move, so its BFF routes currently
forward to **two different backends**:

| → `geekApiUrl()` | → `crawleeApiUrl()` |
|---|---|
| `crawls/[runId]` | `crawls` (list + submit) |
| `crawls/[runId]/urls` | `crawls/[runId]/cancel` |
| `crawls/indexed-report` | `crawls/[runId]/delete` |
| | `crawls/[runId]/resume` |
| | `crawls/resume-by-url`, `crawls/resume-running` |
| | `crawls/failures` |

Four things still exist **only** on this repo's API and have no GeekAPI equivalent: the three
**resume** routes, **`DELETE /crawls/{id}`** (GeekAPI has `cancel`, not delete), **`/failures`** and
`/failures/{id}`, and **`POST /maintenance/sweep-scratch`**. Everything else already has a GeekAPI
route — including `GET /crawls/{runId}/pages`, which is what this view uses.

**So the new route goes to `geekApiUrl()`, never `crawleeApiUrl()`.** It is on the side of the split
that is already where it should end up, and adding it to the other side would be one more strand to
untangle later.

## Not in this plan

- **No GeekAPI change.** The route exists and returns blocks.
- **No `src/api/server.ts` change.** Its `GET /crawls/{runId}/pages` reads `pages.jsonl` off the
  crawl box; the web UI talks to GeekAPI, and one source is enough.
- **No second block→text projection.** This renders the typed blocks directly. Joining them into a
  string is `Geek-Crawler-Rag/block_text.py`'s job and must not be reimplemented here.
- **Nothing in `content-creator-v2`.** That app passes a Run ID and displays generated results; it is
  not where you inspect a crawl.

## Open — decide before building

1. **`services/` vs `lib/`.** The plan says `web/src/services/crawler-api.ts`. This app's existing
   convention is `lib/`, which already holds the server-side callers (`seed-report.ts`,
   `sitemap-count.ts`, `crawl-hub.ts`) while every client-side fetch sits inline in a component.
   `services/` matches content-creator-v2 and is the better name; `lib/` matches this repo. **Jeff is
   deciding this separately** — build against whichever he lands on, and do not split the difference
   by adding a third location.

2. **How much of the run to show.** The route asks for 25 pages and the view says so. A project-site
   run can be thousands of pages, so 25 is a spot-check: enough to prove levels and anchors survived,
   not a report. If a real audit of a whole run is wanted, that is a different feature with different
   performance characteristics — say so rather than quietly raising the limit, which puts page HTML
   volumes through the browser.

## Verify

1. `npm run typecheck` at the repo root and in `web/`
2. `npm run web:dev`, open `/runs/{runId}` for a completed project-site run
3. **Passes if:** headings nest by level, anchor counts are non-zero on pages that link out, and
   block-kind counts match what the page plainly contains
4. Open a run crawled before typed blocks landed — it must say "Pages have no blocks", not render an
   empty tree
