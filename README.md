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
# → http://127.0.0.1:3000
```

If Geek-Crawler v1 already owns `:3000`, use another port:

```bash
npm run web:dev -- -- -p 3001
# → http://127.0.0.1:3001
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
  → GeekAPI (/api/geek-crawler/ingest/*)
    → GeekRepository (X-Repo-Key)
      → Hostinger MongoDB (db geek_crawler)
```

Without those env vars, data stays under `./data/` only.

Do **not** point this crawler at GeekRepository (`REPO_*`) — that bypasses GeekAPI.

Response includes `persistMode`: `api` | `local` | `both`.

Ingest runs use status `external` so GeekAPI’s .NET worker does not claim them.

## Operator UI (`web/`) — phased

Localhost Next.js app. Does **not** replace Geek-Crawler v1. Start commands: see **How to start** above.

### Phase 2 (current)

- `POST /crawls` returns `runId` immediately (HTTP 202); crawl continues in background
- `GET /crawls` lists local run stubs
- GeekAPI: `GET /api/geek-crawler/crawls/{runId}/page-urls` (no HTML); ingest pushes `GeekCrawlerEvent`
- UI BFF wired; SignalR needs `GEEK_USER_ACCESS_TOKEN` in `web/.env.local`

```bash
npm run serve          # :8787
npm run web:dev        # :3000 (or -p 3001)
```

### Deferred

- Resume / reopen Seagate queue for a killed run
- Locale + 403/5xx politeness pass
- Vercel deploy of operator UI
