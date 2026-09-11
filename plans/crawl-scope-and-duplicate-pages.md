# Fix crawl scope drift and duplicate page rows

Status: **Not started**
Found: **2026-09-11** while auditing why n8n produced 482 chunks/page vs clickup's 160

## Objective

Two independent crawler defects put off-seed and duplicated content into the
corpus, which then costs embedding spend and pollutes retrieval. Both are
bookkeeping bugs in the BFS, not extraction problems.

## Defect 1 — crawl scope drifts after a redirect

`extractHrefs($, finalUrl)` anchors the same-site check to the **page currently
being crawled**, and `finalUrl` is the URL *after* redirects:

```ts
// playwright-pool.ts:66, cheerio-runner.ts:219
const finalUrl = page.url();                 // post-redirect
const links = extractHrefs($, finalUrl);     // scope anchored here
isSameOrigin: isSameSite(pageUrl, linkUrl)   // links.ts:69 — pageUrl === finalUrl
```

`isSameSite` itself is strict (exact hostname, `www.` stripped, protocol must
match), so no single check is wrong. The problem is the **anchor moves**: one
redirect off-host and every link on the landing page is "same site" relative to
the new host, and the crawl adopts it.

Observed on run `b51485e9` — seed `["https://www.leadsquared.com/us/"]`,
31,682 pages, origins:

```
m.youtube.com, ms.cnbctv18.com, www.cnbctv18.com, www.deccanherald.com,
www.forbesindia.com, www.zeebiz.com, page.leadsquared.com,
pages.leadsquared.com, www.leadsquared.com
```

The comment above `isSameSite` shows the intent — it was loosened to survive
`make.com → www.make.com` redirects. Correct goal, wrong lever: the *check*
became tolerant instead of the *anchor* staying fixed.

**Fix.** Thread the run's seed origin through and compare links against it:

```ts
extractHrefs($, finalUrl, { scopeUrl: seedUrl })   // isSameSite(scopeUrl, linkUrl)
```

Five call sites: `playwright-pool.ts:87,112` and `cheerio-runner.ts:236,250,273`,
plus the signature in `links.ts:38` and the comparison at `links.ts:69`. Keep
`isSameSite`'s tolerance (it correctly handles `www.` and the seed's own
redirect); only change what it is measured against.

## Defect 2 — the same page is stored many times per run

Dedup happens on the **pre-redirect request URL**; storage happens on the
**post-redirect final URL**; nothing dedups after the redirect resolves.

`filterEnqueueUrls` (`sitemap.ts:204`) already normalizes via `normalizeCrawlUrl`
and dedups against a local `seen`, but `normalizeCrawlUrl` (`sitemap.ts:95`) only
strips the hash and `TRACKING_PARAMS` (utm_*, gclid, …). Any other query param
survives, so `?a=1` and `?a=2` are distinct requests. Both are fetched, both
redirect or canonicalize to the same page, and `savePage` (`persist.ts:235`)
writes a row for each — it generates a fresh `randomUUID()` per call with no
lookup on the final URL.

Observed on run `a8ee85a3` (n8n.io, 443 rows):

```
distinct Url:      358      17 urls duplicated      85 redundant rows (19%)
x6  /integrations/set/              2,998,914 chars total
x6  /integrations/webhook/          2,524,500
x6  /integrations/split-in-batches/ 2,376,792
```

The six copies of `/integrations/set/` are byte-identical, stored 15:24, 15:28,
15:32, 15:35, 15:38, 15:41 — re-enqueued over 17 minutes, not a burst.

**Fix.** Dedup on the resolved final URL at persist time. In `savePage`, before
creating a row, skip when `(runId, normalizeCrawlUrl(finalUrl))` has already been
saved this run — an in-memory `Set` in the persist closure is sufficient and
matches how `recordReject` already tracks state. Reuse `normalizeCrawlUrl` rather
than adding a second normalizer.

Optionally also widen `normalizeCrawlUrl` to drop non-tracking params for enqueue
purposes, but persist-time dedup is the durable fix because it catches redirects
too, which no pre-fetch normalization can.

## Defect 3 — pages truncated at exactly 500,000 chars

Several n8n pages store markdown of exactly `500000`, and mean page size (111,751)
is 6x the median (17,893). Worth confirming whether that cap is intentional and
whether those pages are real content or unbounded SPA/nav output being captured.
Investigate before changing anything — this one is a question, not a known bug.

## Files to change

- `src/crawl/links.ts` — `extractHrefs` signature and the `isSameSite` anchor
- `src/crawl/playwright-pool.ts`, `src/crawl/cheerio-runner.ts` — pass seed scope
  at the five `extractHrefs` call sites
- `src/storage/persist.ts` — final-URL dedup in `savePage`
- reuse `normalizeCrawlUrl` / `TRACKING_PARAMS` from `src/crawl/sitemap.ts`

## Verification

1. **Unit — scope.** Given a page on `evil.com` reached via redirect from the
   seed, `extractHrefs` with `scopeUrl` = seed returns zero same-origin links.
   Given `make.com` → `www.make.com`, links still resolve as same-site.
2. **Unit — dedup.** Two `savePage` calls whose `finalUrl` differs only by
   tracking params, or which resolve to the same normalized URL, create one row.
3. **Regression.** Existing `reject.test.ts` and `viability-reject.test.ts` green.
4. **End-to-end.** Re-crawl leadsquared.com and assert every stored `Origin`
   equals the seed origin (run `b51485e9` had nine). Re-crawl n8n.io and assert
   `distinct Url == page row count` (443 rows / 358 distinct today).
5. **Corpus audit.** After fixing, check other runs for drift with a distinct
   `Origin` count per run — any run with more than one origin has off-seed
   content already indexed and needs a re-crawl.

## Out of scope

- Re-crawling or re-indexing existing affected runs. Identify them first; the
  `b51485e9` leadsquared run in particular should not be indexed as-is, since it
  would put YouTube and Indian news content into the partner corpus.
