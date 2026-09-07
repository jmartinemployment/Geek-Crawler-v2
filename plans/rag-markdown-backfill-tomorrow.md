# Tomorrow: backfill markdown on saved crawl pages

**When:** next session (after Phase A crawler is shipping `title`/`markdown` on new pages).  
**Goal:** Reprocess existing Mongo pages that only have HTML so they match the new clean ingest shape — without re-crawling.

## Prerequisites

1. **GeekBackend** accepts and stores on ingest (and preferably a dedicated backfill endpoint):
   - `Title` / `title`
   - `Markdown` / `markdown`
   - optional `Excerpt` / `excerpt`
2. **GeekRepository** Mongo page documents have those fields (nullable for old rows until filled).
3. Hostinger Mongo (`geek_crawler`) is up; GeekAPI can read page HTML blobs.

Until Backend stores the fields, crawler already **sends** them on `createPagesBatch` (ASP.NET ignores unknown JSON until schema is updated).

## Approach (preferred)

Do **not** re-crawl. For each page with `Html` and empty `Markdown`:

1. Load HTML from Mongo (same body GeekAPI already serves).
2. Run the same algorithm as crawler: Readability → Turndown  
   - Reference implementation: `Geek-Crawler-v2/src/crawl/extract-content.ts`
3. Write `Title`, `Markdown`, `Excerpt` back onto the page document.
4. Mark `markdownBackfilledAt` (or similar) so the job is idempotent.

### Where to run it

| Option | Pros |
|--------|------|
| **A. Geek-Crawler-Rag one-shot script** | Already on Hostinger next to Mongo/Qdrant; Python Readability+markdownify |
| **B. GeekBackend admin job** | Same process as ingest; typed models |
| **C. Local CLI in this repo** | Reuse `extractCleanContent` via GeekAPI list/get/patch — needs Backend patch API |

**Recommendation:** A or B once Backend can PATCH page markdown. Mirror extract rules so crawler and backfill stay aligned.

## Scope filters (important)

Apply the **same locale/region rules** as live crawl (`locale-path.ts`):

- KEEP `/us/…` and bare English paths
- DROP other region prefixes and non-English language segments
- Prefer deleting or skipping dropped URLs rather than backfilling them into RAG

Optional: only backfill pages for seeds still in the active entity list.

## Batching / safety

- Process by `runId` or origin in chunks (e.g. 50–200 pages).
- Skip pages with `robotsAllowed: false` or hard `failureReason`.
- Cap markdown length (~500k chars) like the crawler.
- Log counts: `scanned`, `updated`, `skipped_no_html`, `skipped_locale`, `extract_failed`.
- Dry-run mode first (counts only).

## Verification

1. Spot-check 5–10 URLs: title sensible, markdown has headings/paragraphs, nav chrome mostly gone.
2. Confirm new crawls already land with markdown after `serve` restart.
3. Only then run Rag Phase B indexing against markdown (not raw HTML).

## Out of scope for tomorrow

- Re-embedding / Qdrant rebuild (Rag Phase B)
- GraphRAG
- Changing Crawlee → Firecrawl
