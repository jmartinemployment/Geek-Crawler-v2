# Geek-Crawler v2

Standalone **Crawlee** crawler: **CheerioCrawler only**, static HTML, no browser and no JavaScript execution. Does not modify Geek-Crawler v1.

**Normal use is local:** crawl egress comes from your machine (politer than cloud IPs). The operator UI and `serve` API both run on localhost — see **[API surface](#api-surface)** for which endpoints are public and which are not.

## Product overview

Geek-Crawler v2 builds clean, citation-ready research corpora from partner and competitor websites. It gives SEO and content operators a recoverable crawl workflow with live reporting while supplying grounded source material to the wider Geek content platform.

### Capabilities

- Sitemap-first inventory with same-origin discovery when no sitemap applies
- One renderer, one path: static HTML via CheerioCrawler. A page whose content does not exist until JavaScript runs is rejected, not promoted to a browser
- Tracking-parameter normalization and US/English locale filtering
- `robots.txt` handling, configurable concurrency, and durable resume queues (Crawlee request-queue behavior for **source-page fetching** is not GeekAPI ingest retry)
- Cloudflare/challenge, locale, and empty-content rejection before corpus storage
- Deterministic selector-based extraction into title, excerpt, and clean semantic HTML (`<p>`, `<h2>`, `<li>`, `<table>`) plus the same content as typed blocks
- Local storage or authenticated GeekAPI ingestion (**no application-level retries** on `pages/batch` / `links/batch` — fail closed; see sibling Rag `plans/rules.md` §3a)
- Next.js operator UI with OAuth, SignalR progress, coverage reports, and CSV export

### Technology

Node.js, TypeScript, Crawlee, Cheerio, Next.js, React, OAuth 2.0 PKCE, and Microsoft SignalR. No headless browser and no text-format conversion step in the crawl path — the corpus body is clean semantic HTML plus typed blocks.

## Place in the Geek content platform

```text
Geek-Crawler-v2
  → GeekAPI → GeekRepository → MongoDB
  → Geek-Crawler-Rag → Qdrant
  → GeekAPI → Content Creator v2
```

This repository owns external website discovery, fetching, extraction, and crawl reporting. **Geek-Crawler-Rag** owns indexing, retrieval, and citation verification. **Content Creator v2** owns the editorial and publishing experience.

## API surface

**Public methods live in GeekAPI.** Anything another product or a browser must reach is
`{GEEK_API_URL}/api/geek-crawler/*`, authenticated, owner-scoped. There is no second address for
crawl data. Per `.cursor/rules/no-retries-no-fallbacks.mdc`: *GeekAPI only for crawl authority. No
local mirror / failed stub as authority.*

| Public — GeekAPI `api/geek-crawler/…` | |
|---|---|
| `GET crawls` · `GET crawls/latest` · `GET crawls/{runId}` | Run list and snapshot |
| `GET crawls/{runId}/pages` | Pages with `contentHtml` and typed `blocks`, paged, `limit` 1–500 |
| `GET crawls/{runId}/page-urls` | Lightweight URL list for reports — no bodies |
| `GET crawls/{runId}/links` · `GET crawls/{runId}/rag-index` | Links; Geek-Crawler-Rag index status |
| `POST crawls` · `POST crawls/{runId}/cancel` · `POST crawls/{runId}/rebuild-links` | Start, cancel, rebuild |
| `POST seeds/check` · `GET/POST/PATCH/DELETE schedules…` | Seed admission; schedules |

**The crawler service belongs on GeekAPI too.** That is how every other app on the platform does
it — `GccV2ProjectSiteCrawlService` holds a crawl's run lifecycle and crawls in process, with no
external crawler to call. This repo is the egress half: it fetches from the operator's own network,
extracts, ingests, and should expose nothing.

**It does not match that today.** `npm run serve` listens on `:8787` and answers start, cancel,
resume, delete, sweep, health and four reads. Three facts about it, none of them the intended
design:

- `GET /crawls`, `GET /crawls/{runId}` and `GET /crawls/{runId}/pages` answer only here, and
  `GET /failures` is the only home for post-mortems. Those reads belong in GeekAPI.
- `server.listen(port, …)` (`src/api/server.ts:354`) binds **every interface** while logging
  `127.0.0.1`, and the file has no authentication of any kind. Treat the port as exposed.
- `deploy/Dockerfile` has `ENTRYPOINT` → `serve` and `EXPOSE 8787`, so deploying this image
  publishes that unauthenticated surface. No crawler service is deployed today.

Both are tracked in [`plans/move-crawl-reads-to-geekapi.md`](./plans/move-crawl-reads-to-geekapi.md).

## How to run locally

### One-time setup

```bash
# repo root
cp .env.example .env.local
# fill: GEEK_API_URL, GEEK_BACKEND_API_KEY, GEEK_USER_ID, DATA_DIR (optional)

cp web/.env.example web/.env.local
# defaults: CRAWLEE_API_URL=http://127.0.0.1:8787, NEXT_PUBLIC_APP_URL=http://localhost:3000
# plus GEEK_* keys matching root .env.local

npm install
cd web && npm install && npx playwright install chromium && cd ..
# Playwright belongs to the web package only, for UI end-to-end tests.
# The crawler itself has no browser dependency.
```

### Every day (two terminals)

**Terminal 1 — crawler API** (must stay up while crawling):

```bash
npm run serve
# health: http://127.0.0.1:8787/health
```

If port `8787` is already in use:

```bash
kill $(lsof -tiTCP:8787 -sTCP:LISTEN)
# or force: kill -9 $(lsof -tiTCP:8787 -sTCP:LISTEN)
```

**Terminal 2 — operator UI:**

```bash
npm run web:dev
# open http://localhost:3000
```

Then on the home page: enter one seed URL, set max requests / max concurrency, **Start crawl**.

- **One seed URL = one `runId`**
- **Max concurrency** = parallel fetches *for that run* (default 1 in the UI)
- **Request budget** = locale-filtered sitemap URL count when a map exists (no Max requests field), clamped to the per-site cap of **2,500 pages** (`MAX_PAGES_PER_SITE` in `src/crawl/crawl-limits.ts`). Optional API/CLI `--max` / `maxRequestsPerCrawl` overrides are clamped to the same cap. Known low-quality directories carry per-section page quotas (`src/crawl/section-quota.ts`, override with `SECTION_PAGE_QUOTA`).
- **Locale filter on sitemap map** (crawl + report): **keep** `/us/…`; **drop** other region dirt (`/gb/`, `/uk/`, `/au/`, …) and non-English languages (`/fr/`, `/de/`, …); **strip** English language prefixes only (`/en/`, `/en-us/`, …) to the bare path
- **Unusable pages are not stored** — Cloudflare/challenge interstitials, locale-excluded final URLs, and extracts carrying too little prose are **rejected** (counters + capped URL samples on the run / seed report). The floor measures prose, not markup, so a page of pure boilerplate cannot clear it. Corpus content is only saved for viable pages.
- **JavaScript-only pages are out of scope, and so are their links** — a page carrying no prose without JavaScript is reported as `requiresJavascript` under `excludedByPolicy`, beside robots and locale, **not** as a failure: this crawler runs no JavaScript by design, so nothing about such a page is broken. Its links are not enqueued either. There is no browser to promote to, so every URL found on a shell would be fetched and rejected in turn — the crawl would pay for the whole site and store none of it. A shell is a dead end, not a frontier.
- **Sign in** (nav) is only needed for live SignalR; crawls and reports work without it. Without a token the run page shows `Live updates off — no hub token` and skips the connection entirely — no console errors, no retries. Set `GEEK_USER_ACCESS_TOKEN` in `web/.env.local` to get live status without signing in. See [web/README.md](./web/README.md#live-status-signalr-is-optional)
- **Resume by URL** on the home page continues a local `.crawlee/<runId>` queue and re-seeds from the same locale-filtered sitemap map (Crawlee skips already-handled URLs)
- **Resume all running** on the home page re-attaches every local stub still marked `running` (useful after a `serve` restart orphans in-memory workers; skips already in-flight)

If something else owns `:3000`:

```bash
# web/.env.local
NEXT_PUBLIC_APP_URL=http://localhost:3001

npm run web:dev -- -- -p 3001
```

### Without the UI

```bash
# one-shot CLI (omit --max to use sitemap size)
npm run crawl -- --seed https://example.com --type partner
npm run crawl -- --seed https://example.com --type partner --max 10

# or POST to the private serve API — operator-only, loopback, never a consumer endpoint
# (the public equivalent is POST {GEEK_API_URL}/api/geek-crawler/crawls)
curl -sS -X POST http://127.0.0.1:8787/crawls \
  -H 'content-type: application/json' \
  -d '{"seed":"https://www.example.com","crawlType":"partner","maxConcurrency":1}'
```

## Persist path

When `GEEK_API_URL` + `GEEK_BACKEND_API_KEY` + `GEEK_USER_ID` are set:

```text
Crawlee (localhost)
  → Cheerio extraction (title + clean semantic HTML alongside the raw HTML)
  → GeekAPI (/api/geek-crawler/ingest/*)
    → GeekRepository (X-Repo-Key)
      → Hostinger MongoDB (db geek_crawler)
```

Each successful page save sends the raw **HTML**, the clean **contentHtml**, the
typed **blocks**, **title** and optional excerpt.

GeekAPI carries both to Mongo as of `GeekBackend@5561209`: `contentHtml` as text
and `blocks` as a **native BSON array**. Ingest also fails closed on this route —
a robots-allowed page with no failure reason must carry `contentHtml` and a
non-empty `blocks` array or the batch is rejected `400`.

> Until `GeekBackend@5561209` those two fields were discarded on arrival, because
> `IngestPageItem` never declared them and ASP.NET ignores unknown JSON
> properties. Acceptance required raw `Html` **or** a legacy body field, so a page
> whose extraction produced nothing still validated and persisted.
>
> That is how 5,274 pages came to hold no corpus body — and they were then
> **deleted outright, not by any sync or cleanup job**: the Library classified
> every one of them unusable for lacking that legacy field and removed them from
> Mongo together with their Qdrant points. Indexing has been read-only over the
> corpus ever since (`indexer._skip_unusable`) — it counts what it cannot use and
> never mutates it. The crawler owns the reject taxonomy; a consumer
> re-adjudicating that decision is what cost the corpus.

After all page batches flush, successful API-backed crawls send the run-level
`ContentReadyAt` marker, and resumes clear it until the crawl completes again.

`GeekBackend@5561209` added `ContentReadyAt` / `ClearContentReadyAt` to the run
patch as a pg-text timestamp. The legacy readiness field it once sat beside was
removed in `GeekBackend@26f2b47`, along with the legacy page body field and its
backfill timestamp.

> **The Library selects on `ContentReadyAt`** as of
> `Geek-Crawler-Rag@78c143b`, over the covering index
> `ix_crawl_runs_content_ready`. It no longer deletes pages it cannot read —
> a page with no extracted content is counted and left alone.
>
> Indexing is triggered by `POST /v1/index`; the scheduled path is deprecated
> and `INDEX_SCHEDULER_ENABLED` stays `false`. One item is still open:
> the Mongo key casing for `ContentReadyAt` is inferred from GeekAPI's BSON
> class map rather than observed, and
> `Geek-Crawler-Rag/scripts/verify_ingest_fields.py` on the VPS settles it.

Without those env vars, nothing leaves the machine, but note what local mode
actually keeps: run stubs and counters under `DATA_DIR/runs/`, the Crawlee
request queue under `DATA_DIR/.crawlee/<runId>/`, and post-mortems under
`DATA_DIR/failures/`. **Page bodies are not written locally.** The body store
exists (`src/storage/raw-body.ts`, `put` for the raw wire HTML and
`putContentHtml` for the clean fragment) but nothing calls it, and
`CrawlPageMeta.bodyKey` / `contentBodyKey` are set by nothing. Local mode is a
progress ledger, not a corpus.

Do **not** point this crawler at GeekRepository (`REPO_*`) — that bypasses GeekAPI.

Response includes `persistMode`: `api` | `local` | `both`.

Ingest runs use status `external` so GeekAPI’s .NET worker does not claim them.

## Hostinger VPS (Mongo + RAG)

Crawl HTML is ingested through GeekAPI into **MongoDB on the Hostinger VPS**. Seed reports also read run snapshots / `page-urls` from GeekAPI → that same Mongo.

| Resource | Notes |
|----------|--------|
| VPS | `srv1951187.hstgr.cloud` (KVM 2) |
| Docker project `mongodb` | `mongo:7.0` on host port **27017** — required for GeekAPI crawler data |
| Docker project `geek-crawler-rag` | RAG API on **8080** + Qdrant (depends on a healthy stack; restart after Mongo if unhealthy) |

### Symptoms when Mongo is down

- Seed report: **“run not found”** / **“No seed report rows yet”** / refresh hangs
- `curl` to `GEEK_API_URL/api/geek-crawler/crawls/<runId>` times out (while `/health` may still return 200)
- Hostinger hPanel may show **“Your session ended”** after a long disconnect — re-login; the underlying issue is often stopped Docker projects, not only the panel session

### Check

```bash
# GeekAPI still answering HTTP?
curl -sS -o /dev/null -w '%{http_code} %{time_total}\n' --max-time 10 \
  https://api.geekatyourspot.com/health

# Crawl snapshot (needs GEEK_* from .env.local) — should be ~200ms when Mongo is up
set -a && source web/.env.local && set +a
curl -sS -o /dev/null -w '%{http_code} %{time_total}\n' --max-time 15 \
  -H "X-API-Key: $GEEK_BACKEND_API_KEY" \
  -H "X-Geek-User-Id: $GEEK_USER_ID" \
  "$GEEK_API_URL/api/geek-crawler/crawls/<runId>"
```

On the VPS (SSH or Hostinger Docker UI), confirm project state:

- `mongodb` → **running**
- `geek-crawler-rag` → **running** (API health **healthy**, not **unhealthy**)

### Restart (preferred order)

1. **Start Mongo** if stopped  
2. **Restart RAG** if it stayed unhealthy while Mongo was down  
3. Optionally **restart the VPS** only if the whole machine is wedged (last resort)

#### Via Hostinger hPanel

1. Open [hPanel](https://hpanel.hostinger.com/) → **VPS** → `srv1951187`
2. Open **Docker** / project manager (or SSH — below)
3. Start project **`mongodb`**
4. Restart project **`geek-crawler-rag`**
5. Re-check the crawl snapshot curl above, then refresh `/runs`

#### Via SSH on the VPS

```bash
# paths as deployed on this VPS
cd /docker/mongodb && docker compose up -d
cd /docker/geek-crawler-rag && docker compose restart
# or full recreate of RAG after Mongo is healthy:
# cd /docker/geek-crawler-rag && docker compose up -d

docker compose -f /docker/mongodb/docker-compose.yml ps
docker compose -f /docker/geek-crawler-rag/docker-compose.yml ps
```

#### Via Cursor Hostinger MCP (agent)

With the Hostinger MCP connected (VM id **1951187**):

1. `VPS_getProjectListV1` — confirm `mongodb` / `geek-crawler-rag` state  
2. `VPS_startProjectV1` — `projectName=mongodb` if stopped  
3. `VPS_restartProjectV1` — `projectName=geek-crawler-rag` if unhealthy  
4. `VPS_restartVirtualMachineV1` — only if the VM itself is stuck (reboots everything)

### After recovery

Refresh **http://localhost:3000/runs**. Seed reports need GeekAPI + Mongo; local `:8787` stubs alone are not enough when `persistMode` is `api`.

## Operator UI (`web/`)

Localhost Next.js app. Does **not** replace Geek-Crawler v1. Start commands: see **How to run locally** above.

### Phase 2 (current)

- `POST /crawls` (private API) returns `runId` immediately (HTTP 202); crawl continues in background
- `GET /crawls` (private API) lists local run stubs — a duplicate of GeekAPI's public run list, and
  scheduled for removal
- Seed report (URL-first on `/runs`) with sitemap totals; sitemap is the map when present
- Locale filter on sitemap map + report counts (keep `/us/`; drop other regions + non-English; strip `en` / `en-*`)
- GeekAPI `page-urls` + optional SignalR after Sign in

### Deferred

- 403/5xx politeness pass
- Cloud-hosted crawler egress (avoid Vercel/datacenter IPs for crawl)

### Vercel note

An optional UI deploy may exist, but **do not run crawls from Vercel** — shared cloud IPs are easy for bot managers to flag. Keep `npm run serve` on your machine; point the local UI at `CRAWLEE_API_URL=http://127.0.0.1:8787`.

### Resume is forbidden

One seed URL = one `runId`. A run that failed is not resumed — start a new one.

All three resume routes on the private API answer **409 `RESUME_FORBIDDEN`**
(`src/api/server.ts:187`): `POST /crawls/resume-by-url`, `POST /crawls/resume-running`, and
`POST /crawls/{runId}/resume`. This is policy, not a defect —
`.cursor/rules/no-retries-no-fallbacks.mdc`: *No resume of failed runs; start a new run.* There is
no public equivalent in GeekAPI and none is wanted.

The **Resume by URL** and **Resume all running** controls still render on the home page and their
BFF routes still forward. They cannot succeed; they are dead surface awaiting removal.

## Failed and cancelled runs are destroyed

A run that does not end in success leaves nothing behind but its explanation.
On `failed` or `cancelled`, the crawler writes a post-mortem and then purges the
run: GeekAPI pages and links, Qdrant vectors, `DATA_DIR/runs/<runId>/`, and
`DATA_DIR/.crawlee/<runId>/`.

The post-mortem lands at `DATA_DIR/failures/<runId>.json` — reject counters, up
to five sample URLs per reason, `errorSummary`, and what the purge actually
managed to remove. It is written **before** anything is destroyed: if the
archive cannot be written, the purge does not run. Nothing reads this directory
to decide what to crawl, resume, or dedup, so it is diagnostics and never crawl
authority.

Read it at `http://localhost:3000/runs` under **Purged Runs**, or from the API:

```
GET  /failures            # every post-mortem, newest purge first
GET  /failures/:runId     # one, or 404
```

Cancel is destructive. Cancelling a crawl 400 pages in discards those 400 pages;
only the report survives.

Orphaned request queues — `.crawlee/<id>` directories whose run is already gone —
are swept separately, since nothing owns them:

```
POST /maintenance/sweep-scratch   # → { swept: [...], bytesFreed }
```
