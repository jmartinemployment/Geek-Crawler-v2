# REQUIRED: Reject unusable pages at crawl (no persist) + report

Status: **done**  
Owner: Geek-Crawler-v2  
Related: [`sitemap-locale-filter.md`](./sitemap-locale-filter.md) (locale DROP already shipped), Geek-Crawler-Rag index/backfill delete (sweeper, not source of truth)

## Problem

Unusable pages still land in Mongo/`crawl_pages` and burn storage:

| Class | Today | Wanted |
|-------|--------|--------|
| **Locale mirrors** | Mostly prevented at sitemap/link enqueue (`locale-path.ts`) | Keep prevent; if a locale URL is ever fetched, **do not persist** page body |
| **Cloudflare / challenge** | Cheerio path **saves full HTML** + `failureReason: challenge_page` ([`cheerio-runner.ts`](../src/crawl/cheerio-runner.ts)) | **Do not save** HTML/markdown page docs; **count + report** only |
| **Extract-empty** | `extractCleanContent` returns nulls but caller often still saves HTML ([`extract-content.ts`](../src/crawl/extract-content.ts)) | **Do not persist** corpus bodies; enqueue links then discard |

RAG/index delete is a safety net. **Crawl must stop creating junk.**

## Goals

1. **Identify** unusable outcomes at fetch/extract time.
2. **Prevent persist** of page bodies for those outcomes (no `Html` / `Markdown` worth keeping).
3. **Report** per-run (and seed report / GeekAPI) so ops can see leak rates without storing corpses.

## Non-goals

- Cloudflare bypass / captcha solving
- Changing locale DROP/STRIP rules (already done in [`sitemap-locale-filter.md`](./sitemap-locale-filter.md))
- One-shot historical Mongo purge (Geek-Crawler-Rag / ops — separate)
- Deleting Qdrant chunks (RAG indexer responsibility)

## Decision locks

1. **Extract-empty:** enqueue same-origin locale-filtered links from the DOM, then **discard the body** (no Mongo/API page HTML).
2. **Challenge / locale / extract-empty:** counters + capped log samples only — **no page body persist**.
3. **`failedRequestHandler` / network errors:** metadata-only is OK only when there is no HTML; never store challenge or empty-extract HTML under a soft failure reason.
4. Historical purge: out of scope here.

---

## MUST SHIP #1 — Shared reject taxonomy

Single reason enum used by cheerio + playwright + persist + reports:

| Reason | Detect | Persist page body? |
|--------|--------|-------------------|
| `locale_excluded` | `shouldExcludeLocalePath(finalUrl)` before/after fetch | No |
| `challenge_page` | existing [`viability.ts`](../src/crawl/viability.ts) markers (`cf-browser-verification`, “just a moment…”, etc.) | No |
| `extract_empty` | after `extractCleanContent`, `markdown` null/blank (optional min-length floor) | No |
| (existing) `robots_disallowed`, network errors | keep current behavior unless product says otherwise | metadata-only OK; **no HTML** for pure failures |

---

## MUST SHIP #2 — Stop saving Cloudflare / challenge HTML

**Current policy miss:** on `challenge_page`, runner still `savePage({ html: rawHtml, failureReason: 'challenge_page', ... })`.

**Change:**

1. On `challenge_page` (cheerio **and** playwright if applicable):
   - **do not** call `savePage` with HTML/markdown
   - increment run counter `pagesRejectedChallenge`
   - do not enqueue links scraped from challenge interstitial HTML
2. Do **not** promote challenge pages to Playwright just to save another challenge shell.
3. Tests: fixture CF interstitial → zero `createPagesBatch` HTML / zero local raw body put; counter ≥ 1.

---

## MUST SHIP #3 — Stop saving extract-empty corpus pages

After viable HTML + `extractCleanContent`:

1. If markdown empty (and no meaningful title/body fallback): classify `extract_empty`.
2. **Do not persist** HTML for corpus (login pages, `/_components/` fragments, empty shells).
3. **Enqueue links then drop body:** extract same-origin URLs, run existing locale/`siteMap` enqueue filters, enqueue, then discard — no Mongo page.
4. Counter: `pagesRejectedExtractEmpty`.
5. Tests: wp-login / empty-article fixtures → no page body persist; counters bump; allowed links still enqueue.

---

## MUST SHIP #4 — Locale: belt and suspenders

Sitemap + `links.ts` already DROP. Add:

1. Final-URL guard in requestHandler: if `shouldExcludeLocalePath(finalUrl)` → reject, no persist, `pagesRejectedLocale++`.
2. Ensures redirects into `/fr/`, `/de/`, etc. never write pages.

---

## MUST SHIP #5 — Reporting (keep counts, not corpses)

Surface on run completion + operator UI / seed report / GeekAPI patch:

| Field | Meaning |
|-------|---------|
| `pagesRejectedLocale` | locale guard hits |
| `pagesRejectedChallenge` | Cloudflare / challenge |
| `pagesRejectedExtractEmpty` | Readability/Turndown empty |
| `pagesSaved` | successful corpus pages (unchanged) |

Also:

- Log capped sample URLs per reason (e.g. 5/run) — not full HTML.
- Seed report / CSV: rollup so “why is this host thin?” is visible.
- GeekAPI: extend run patch / stats DTO; **do not** store rejected page documents for reporting.

---

## Implementation sketch

1. `src/crawl/reject.ts` (or extend `viability.ts`) — `classifyReject({ url, html, $, markdown, viability })`.
2. Wire [`cheerio-runner.ts`](../src/crawl/cheerio-runner.ts) + [`playwright-pool.ts`](../src/crawl/playwright-pool.ts) — reject path → counters only.
3. [`persist.ts`](../src/storage/persist.ts) / GeekAPI — bump in-memory counters + `patchRun` stats; no HTML write on reject.
4. `web/` seed report — show reject totals.
5. README — document “unusable pages are not stored; see run stats”.

```text
fetch → viability / locale / extract
      → reject? → count + sample log → (extract_empty: enqueue links) → return
      → ok? → savePage(html, markdown, title, …)
```

---

## Success criteria

- [x] Challenge fixture crawl: **0** pages with HTML for CF interstitial; `pagesRejectedChallenge` ≥ 1
- [x] Extract-empty fixture: **0** corpus page bodies; `pagesRejectedExtractEmpty` ≥ 1; links still enqueue when present
- [x] Locale redirect/final URL: **0** persisted `/de|fr|…/` pages; `pagesRejectedLocale` ≥ 1
- [x] Run report / GeekAPI shows the three reject counts
- [x] Happy-path crawl still saves Title/Markdown/Html as today
- [x] Unit tests for classify + runner tests for no-persist

## Out of scope

- Mass delete of existing Mongo junk
- RAG index-time delete (Geek-Crawler-Rag)
- Raising crawl success via CF bypass
- Lifting sitemap URL caps
