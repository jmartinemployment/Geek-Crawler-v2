# REQUIRED: Locale filter + Resume sitemap-as-map + URL-first report

Status: **done**

## MUST SHIP #1 — Locale filter on sitemap

Sitemap map, request budget, and report sitemap columns filter locales.

### Filter rules

| Path | Action |
|------|--------|
| `/fr/...`, `/de/...`, `/pt-br/...`, etc. | **DROP** |
| `/en/...`, `/en-us/...`, `/en-gb/...` | **STRIP** prefix (collapse with bare path) |
| `/foo` (no locale) | **KEEP** |

```text
loc → same-site → DROP non-English → STRIP en/en-* → add to map / counts / budget
```

### Implementation

1. `src/crawl/locale-path.ts` — `isNonEnglishLocalePath` + `stripEnglishLocalePrefix` + `localeNormalizeForMap`; wired from `links.ts`.
2. `src/crawl/sitemap.ts` — DROP + STRIP before map add; budget = filtered size; enqueue normalized URLs.
3. `web/src/lib/locale-path.ts` + `web/src/lib/sitemap-count.ts` — same DROP + STRIP for report columns (keep in sync).
4. README — documents locale filter on map/budget/report.

---

## MUST SHIP #2 — Resume + sitemap-as-map

Resume uses the locale-filtered sitemap like a new crawl:

1. `loadSiteMapIndex`
2. `initialCrawlUrls(seeds, siteMap)`
3. `crawler.run(startUrls)` — not bare `crawler.run()`
4. Crawlee skips handled keys; missing map URLs enqueue
5. `maxRequestsPerCrawl` = filtered map size

(`src/crawl/cheerio-runner.ts`)

---

## MUST SHIP #3 — URL-first run report

- `/runs`: seed URL primary; runId secondary
- Seed report + CSV: `seedUrl` first; link by URL
- No silent dedupe

---

## Todos

- [x] **REQUIRED locale filter:** extract helpers; DROP non-English; STRIP `en`/`en-*` on crawl sitemap + report counts
- [x] Resume: enqueue full (filtered) sitemap map like new crawl
- [x] URL-first `/runs` + seed report/CSV
- [x] README

## Out of scope

- Lifting `MAX_SITEMAPS` / `MAX_URLS`
- Persisting sitemap counts on the run record
- `xhtml:link` hreflang beyond `<loc>`
