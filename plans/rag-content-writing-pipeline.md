# RAG content writing pipeline (Crawler-v2 scope)

Status: **Phase A in this repo — implemented** (restart `serve` to pick up).  
Siblings: `Geek-Crawler-Rag/plans/rag-content-writing-pipeline.md`, `content-creator-v2/plans/rag-content-writing-pipeline.md`, GeekBackend generate route.

## This repo owns

- Crawlee + Playwright crawl
- Clean **markdown + title** at ingest (**Mozilla Readability → Turndown**) — draft-research cleaning, locked
- Locale/region filters (existing `/us/` keep)
- Passing pages to GeekAPI ingest (HTML + new fields)

## Phase A — Done here (new-crawl cleaning)

| Piece | Location |
|-------|----------|
| Extract helper | `src/crawl/extract-content.ts` — Readability → Turndown; `title` / `markdown` / `excerpt`; ~500k cap |
| Cheerio + Playwright | `savePage` includes clean fields; **full HTML still saved** |
| Persist + GeekAPI client | optional fields on batch ingest |
| Local bodies | `.html` + sibling `.md` when `persistMode` is `local` or `both` |

**Locked:** New crawls always run this cleaning path. Not Firecrawl.

**Note:** GeekBackend must store `Title` / `Markdown` / `Excerpt` on ingest before Mongo retains clean text. Extra JSON is safe to send early; ignored until Backend schema is updated.

## One-time cleanse (existing data — no re-crawl)

See **`plans/rag-markdown-backfill.md`**: Readability-equivalent pass over Mongo pages that have HTML and empty Markdown. Runner: **Geek-Crawler-Rag** script on Hostinger. Same locale keep/drop/strip rules as crawl.

## Not this repo

- Qdrant / hybrid / parent-child / **LlamaIndex** / **GraphRAG** / ad-template **index** (Geek-Crawler-Rag — Phases E + D)
- `/api/rag/generate` + **OpenAI o1/o3** long-form routing (GeekBackend Phase F)
- Content Creator UI / template picker (content-creator-v2 Phase D)
- Markdown backfill **script** execution (Geek-Crawler-Rag); this repo only defines the extract algorithm to mirror
