# Tomorrow: backfill markdown on saved crawl pages

**Goal:** Reprocess existing Mongo pages that only have HTML so they match the new clean ingest shape — without re-crawling.

## Prerequisites

1. Apply Backend patch: [`plans/backend-markdown-backfill/APPLY.md`](backend-markdown-backfill/APPLY.md)
2. Deploy/restart GeekAPI + GeekRepository
3. Crawler `serve` restarted so **new** pages also send Title/Markdown

## Run (this repo)

```bash
# Dry-run one run (extract + counts, no writes)
npm run backfill-markdown -- --run-id <guid> --dry-run

# Write
npm run backfill-markdown -- --run-id <guid>

# All recent runs for the authenticated user
npm run backfill-markdown -- --all-runs --dry-run
npm run backfill-markdown -- --all-runs
```

Env: `GEEK_API_URL`, `GEEK_BACKEND_API_KEY`, `GEEK_USER_ID`

## Behavior

- Reuses [`src/crawl/extract-content.ts`](../src/crawl/extract-content.ts)
- Skips locale dirt via [`shouldExcludeLocalePath`](../src/crawl/locale-path.ts) (keep `/us/`)
- Skips robots-disallowed, empty HTML, already-has-markdown
- Idempotent Backend update only when Markdown empty; sets `MarkdownBackfilledAt`

## After

Confirm samples look clean, then Rag Phase B1 prefers Markdown on index (separate repo).
