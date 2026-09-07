# RAG content writing pipeline (Crawler-v2 scope)

Status: **Phase A in this repo — implemented** (restart `serve` to pick up).  
Siblings: `Geek-Crawler-Rag/plans/rag-content-writing-pipeline.md`, `content-creator-v2/plans/rag-content-writing-pipeline.md`, GeekBackend generate route.

## This repo owns

- Crawlee + Playwright crawl
- Clean **markdown + title** at ingest (Readability + Turndown)
- Locale/region filters (existing `/us/` keep)
- Passing pages to GeekAPI ingest (HTML + new fields)

## Phase A — Done here

| Piece | Location |
|-------|----------|
| Extract helper | `src/crawl/extract-content.ts` |
| Cheerio + Playwright | `savePage` includes `title` / `markdown` / `excerpt` |
| Persist + GeekAPI client | optional fields on batch ingest |
| Local bodies | `.html` + sibling `.md` when `persistMode` is `local` or `both` |

**Note:** GeekBackend `IngestPageItem` must add Title/Markdown (and store them) before Mongo retains clean text. Extra JSON is safe to send early; ignored until Backend is updated.

## Tomorrow — data mirror

See **`plans/rag-markdown-backfill-tomorrow.md`**: reprocess existing HTML → markdown in Mongo (no full re-crawl). Apply locale filter when deciding what to keep.

## Not this repo

- Qdrant / hybrid / parent-child (Geek-Crawler-Rag)
- `/api/rag/generate` (GeekBackend)
- Content Creator UI (content-creator-v2)
