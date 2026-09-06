# Phase 2 — Operator UI live wiring (deferred while crawl ran)

Status: **done** — local Crawlee async API, GeekAPI `page-urls` + ingest SignalR (deployed), `web/` BFF + live run view wired.

Phase 1 (done): `web/` shell, BFF stubs, SignalR helpers, `web:dev`, README.

## Constraint that no longer applies

Previously blocked mid-crawl:

- Restart `npm run serve`
- Deploy / restart GeekAPI
- Change Crawlee runner / persist / API shape

Those are allowed now.

## Scope

### 2a. Local Crawlee API (`Geek-Crawler-v2`)

- `POST /crawls` → create run, return `{ ok, runId, persistMode }` **immediately**; run Cheerio in background
- `GET /crawls` → list `DATA_DIR/runs/*/run.json`
- Restart `serve` after code change

### 2b. GeekAPI (GeekBackend) + deploy

- `GET /api/geek-crawler/crawls/{runId}/page-urls` — URL metadata **without HTML** (paginated)
- On ingest create/patch run (and lightweight progress) → `GeekCrawlerProgressNotifier.PushAsync` / `GeekCrawlerEvent`
- Deploy GeekAPI once

### 2c. Wire `web/`

- BFF proxies to `:8787` + GeekAPI (real env)
- Hub token route for SignalR
- Submit → navigate to `/runs/[runId]`
- One REST snapshot + SignalR live status (**no timer polling**)
- Paginated URL table + CSV export from `page-urls`

## Explicitly deferred (not this Phase 2 pass)

- Resume / reopen Seagate queue for `509c8f25…`
- Locale + 403/5xx politeness (separate pass unless pulled in)
- Concurrency changes
- Vercel deploy of operator UI
- Replacing Geek-Crawler v1

## Architecture

```text
Browser :3000
  → BFF → Crawlee :8787 (start / list / local run stub)
  → BFF → GeekAPI REST (run snapshot, page-urls)
  → SignalR GeekAPI /hubs/geek-crawler-realtime (live status)
```

## Test plan

- [x] `POST /crawls` returns `runId` in &lt;1s while crawl continues
- [x] `GET /crawls` lists local runs
- [x] `page-urls` returns rows without HTML bodies
- [x] Ingest triggers SignalR event (UI updates without refresh polling) — requires `GEEK_USER_ACCESS_TOKEN` in `web/.env.local`
- [x] UI submit → run detail; URL table + CSV work
