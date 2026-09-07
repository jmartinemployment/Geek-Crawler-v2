# Geek-Crawler v2

Standalone **Crawlee** crawler (Cheerio primary, Playwright backup). Does not modify Geek-Crawler v1.

## How to start

One-time setup (repo root):

```bash
cp .env.example .env.local   # fill GEEK_API_URL, GEEK_BACKEND_API_KEY, GEEK_USER_ID
npm install
npx playwright install chromium
```

**Crawler HTTP API** (port `8787`) — leave this running while you crawl:

```bash
npm run serve
# health: http://127.0.0.1:8787/health
```

**Operator UI** (Next.js) — separate terminal:

```bash
npm run web:dev
# → http://localhost:3000
```

**Sign in** (required for live SignalR): click **Sign in** in the nav, or open  
`http://localhost:3000/api/auth/start` — GeekOAuth login, then return to the UI.

If something else owns `:3000`, use another port **and** set matching `NEXT_PUBLIC_APP_URL` (that origin must be registered on the `geek-crawler` OAuth client):

```bash
# web/.env.local
NEXT_PUBLIC_APP_URL=http://localhost:3001

npm run web:dev -- -- -p 3001
```

**One-shot CLI crawl** (no UI / no long-lived serve required):

```bash
npm run crawl -- --seed https://example.com --type partner --max 10
```

**Submit a crawl via serve** (curl):

```bash
curl -sS -X POST http://127.0.0.1:8787/crawls \
  -H 'content-type: application/json' \
  -d '{"seeds":["https://www.example.com"],"crawlType":"partner","maxRequestsPerCrawl":20}'
```

## Persist path

When `GEEK_API_URL` + `GEEK_BACKEND_API_KEY` + `GEEK_USER_ID` are set:

```text
Crawlee (localhost)
  → Readability + Turndown (title + markdown alongside HTML)
  → GeekAPI (/api/geek-crawler/ingest/*)
    → GeekRepository (X-Repo-Key)
      → Hostinger MongoDB (db geek_crawler)
```

Without those env vars, data stays under `./data/` only (HTML + sibling `.md` when local).

**Backfill existing HTML-only pages** (after applying Backend patch in `plans/backend-markdown-backfill/`):

```bash
npm run backfill-markdown -- --run-id <guid> --dry-run
npm run backfill-markdown -- --run-id <guid>
```

Do **not** point this crawler at GeekRepository (`REPO_*`) — that bypasses GeekAPI.

Response includes `persistMode`: `api` | `local` | `both`.

Ingest runs use status `external` so GeekAPI’s .NET worker does not claim them.

## Operator UI (`web/`) — phased

Localhost Next.js app. Does **not** replace Geek-Crawler v1. Start commands: see **How to start** above.

### Phase 2 (current)

- `POST /crawls` returns `runId` immediately (HTTP 202); crawl continues in background
- `GET /crawls` lists local run stubs
- GeekAPI: `GET /api/geek-crawler/crawls/{runId}/page-urls` (no HTML); ingest pushes `GeekCrawlerEvent`
- UI BFF wired; **Sign in** via GeekOAuth for SignalR (nav → Sign in)

```bash
npm run serve          # :8787
npm run web:dev        # :3000 (or -p 3001)
```

### Deferred

- Locale + 403/5xx politeness pass
- Vercel deploy of operator UI

### Resume

One seed URL = one `runId` going forward. After the report, resume by URL:

```bash
curl -sS -X POST http://127.0.0.1:8787/crawls/resume-by-url \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.anomalo.com"}'
```

Or use **Resume by URL** on the home page. Requires `DATA_DIR/.crawlee/<runId>` on disk.
Report **# of Pages** = crawled pages for that origin (not a predicted site total).

Legacy multi-seed runs can still be matched by any of their seeds; resume continues the shared queue.
