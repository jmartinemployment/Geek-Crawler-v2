# RAG content writing pipeline (Crawler-v2 scope)

Status: **Phase A extract + backfill CLI implemented** (Backend patch must be applied for Mongo writes).

## This repo owns

- Crawlee + Playwright crawl
- Clean **markdown + title** at ingest (Readability + Turndown)
- Locale/region filters (keep `/us/`)
- Markdown backfill CLI for existing HTML-only pages

## Phase A

| Piece | Location |
|-------|----------|
| Extract helper | `src/crawl/extract-content.ts` |
| Cheerio + Playwright | `savePage` includes title/markdown/excerpt |
| Persist + GeekAPI client | optional fields on batch ingest |
| Backfill CLI | `npm run backfill-markdown` |
| Backend patch | `plans/backend-markdown-backfill/` |

## Tomorrow data mirror

See `plans/rag-markdown-backfill-tomorrow.md`.
