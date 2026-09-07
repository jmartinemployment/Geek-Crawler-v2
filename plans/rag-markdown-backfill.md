# One-time markdown backfill (existing crawl pages)

Status: **committed** — no re-crawl; Readability-equivalent cleanse of HTML already in Mongo.  
Supersedes the old “tomorrow” note.

## Goal

For pages with `Html` and empty `Markdown`, write clean `Title` / `Markdown` / `Excerpt` so they match new-crawl Phase A shape.

## Algorithm (mirror Crawler-v2)

Reference: [`src/crawl/extract-content.ts`](../src/crawl/extract-content.ts)

1. Mozilla Readability on HTML (Python: `readability-lxml`)
2. HTML fragment → markdown (`markdownify`, ≈ Turndown)
3. Fallback: `article` / `main` / `body` if Readability fails
4. Cap ~500k chars
5. Set `MarkdownBackfilledAt` (or equivalent) for idempotency

## Runner (locked)

**Geek-Crawler-Rag** one-shot script on Hostinger (next to Mongo). Not a Crawler-v2 re-crawl; not Firecrawl.

## Prerequisites

1. GeekBackend / GeekRepository page docs accept nullable `Title`, `Markdown`, `Excerpt` (+ optional `MarkdownBackfilledAt`)
2. New-crawl ingest already persists those fields
3. Hostinger Mongo (`geek_crawler`) is up

## Locale filter (same as crawl)

Port rules from `locale-path.ts`:

- KEEP `/us/…` and bare English paths
- DROP other region prefixes and non-English language segments
- STRIP `/en/`, `/en-us/`, … when normalizing
- Skip (do not backfill) dropped URLs

Also skip: no HTML, `robotsAllowed: false`, hard `failureReason`, already has Markdown / backfill marker.

## Batching / safety

- Process by `runId` or origin in chunks (50–200)
- Dry-run first (counts only): `scanned`, `updated`, `skipped_no_html`, `skipped_locale`, `skipped_has_markdown`, `extract_failed`
- Then write

## Verification

1. Spot-check 5–10 URLs: title sensible, markdown has headings/paragraphs, nav chrome mostly gone
2. Confirm new crawls land with Markdown after Backend deploy + `serve` restart
3. Reindex selected runs in Rag so Qdrant uses markdown

## Out of scope

- Re-crawling existing seeds
- GraphRAG / LlamaIndex / o1 (separate phases)
- Changing Crawlee → Firecrawl
