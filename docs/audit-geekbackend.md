# Audit — GeekBackend (GeekAPI, GeekRepository, GeekApplication, GeekSa2Read)

**Role:** generation, crawl ingest, and the storage boundary for the whole pipeline.
**Audited:** 2026-09-28, working tree. **Note:** the solution does not currently build, so every
finding here is from source, never from a running system.

---

## F1 — Generation reads project-site pages from Postgres; the crawler writes Mongo — **critical**

**Status, 2026-10-04: resolved** in GeekBackend `da6a98e` (2026-09-29). The Postgres page source,
`GccV2ProjectSiteCrawlService` with its BFS crawler and worker, the three repository controllers and
the tables are gone; project-site pages are read from Mongo only, and
`GeekBackend.Tests/PostgresIsOAuthOnlyTests.cs` keeps Postgres out. Geek-Crawler-v2 is the only
crawler. The finding is kept as written.

**Evidence**

`GeekAPI/Services/ContentCreatorV2/ServiceRegistration.cs:136-142`

```csharp
var source = sp.GetRequiredService<IConfiguration>()
    .GetValue("ContentCreatorV2:ProjectSitePageSource", "postgres");
return string.Equals(source, "mongo", StringComparison.OrdinalIgnoreCase)
    ? sp.GetRequiredService<ProjectSite.GccV2MongoProjectSitePageSource>()
    : sp.GetRequiredService<ProjectSite.GccV2PostgresProjectSitePageSource>();
```

`ContentCreatorV2:ProjectSitePageSource` appears in **no `.json` file anywhere in GeekBackend**
(verified by grep across the repo). The default therefore applies on every environment.

The selected branch documents itself as dead:

- `ProjectSite/GccV2ProjectSitePageSource.cs:33` — *"Reads from the Postgres project-site tables.
  The path being retired."*
- The registration comment above it — *"Mongo is the shared geek_crawler store every other crawl
  type already uses. Flag-gated so the read path can move and be proven before GeekAPI stops
  writing Postgres at all."*

**The full chain, five hops:**

1. `GccV2Controller.cs:403` — `_researchResolver.MergeExternalResearchAsync(...)` inside the create path
2. `IGccV2ProjectSitePageSource` — DI default `"postgres"`
3. `GccV2PostgresProjectSitePageSource` → `HttpGccV2Repository.ListProjectSiteCrawlPagesAsync`
4. `HttpGccV2Repository.cs:231-238` → `GET repo/content-creator-v2/project-site/pages`
5. `GeekRepository/Controllers/ContentCreatorV2/GccV2ProjectSiteCrawlPagesController.cs:32` →
   `_db.GccV2ProjectSiteCrawlPages` (EF, Postgres)

**Who writes that table:** exactly one caller —
`GeekAPI/Services/ContentCreatorV2/ProjectSite/GccV2ProjectSiteCrawlService.cs:142`, GeekAPI's own
BFS crawler (`GccV2ProjectSiteBfsCrawler`), driven by `GccV2ProjectSiteCrawlWorker` and
`GccV2ProjectSiteController`. That is a **different crawler** from Geek-Crawler-v2, which posts
corpus to Mongo `geek_crawler`.

**What I did not verify:** a row count on `GccV2ProjectSiteCrawlPages`. The trace predicts an empty
read for any Geek-Crawler-v2 run; it does not observe one. **Do this first — it is one query and it
settles the finding either way.**

**Also telling:** the only test on this seam,
`GeekBackend.Tests/ContentCreatorV2/GccV2ProjectSitePageSourceTests.cs`, exercises
`GccV2MongoProjectSitePageSource`'s projector — the branch that is **not** selected. The used path
has no test; the unused path is proven lossless.

**Fix**

1. Run the row count. If empty, F1 is confirmed and everything below follows.
2. Set `ContentCreatorV2:ProjectSitePageSource = "mongo"` in appsettings for every environment.
   One line, immediately reversible.
3. Add a test that asserts which concrete type the container resolves under default configuration.
   The current test proves a projection; it does not prove a selection.
4. Decide the fate of `GccV2ProjectSiteCrawlService` and its BFS crawler. Two crawlers writing two
   stores is the root cause, not the flag. Either it is retired, or its purpose is written down.
5. Only once 2-4 hold, remove the flag and the Postgres source together. A flag that is never
   flipped is worse than no flag: it reads as a migration that happened.

---

## F2 — Absent crawl data degrades generation silently — **critical**

**Evidence** — `GeekAPI/Controllers/ContentCreator/GccController.cs:~664`

```
"Site structure: run {RunId} returned no pages, so this create generates without it."
... return null;
```

and immediately below,

```
"Site structure: nothing on the site matches \"{Topic}\", so this create generates without it."
```

An empty read is absorbed as a normal condition. Generation proceeds without grounding and the
resulting draft carries no marker distinguishing it from a grounded one.

**Why it matters.** This is what makes F1 invisible. Point the read at an empty store and nothing
fails — you get content, it just is not grounded in your corpus. It contradicts the project's own
rule: abort on a failed primary path, never continue on absent data.

**Fix**

1. Distinguish *"this create was not configured for site structure"* from *"it was configured and
   the store returned nothing."* The first is normal; the second is a failure.
2. On the second, fail the create rather than logging past it.
3. If ungrounded generation must remain possible, stamp the output so provenance records that no
   corpus was used. A draft that silently lost its grounding is the defect; a draft that says it
   has none is a choice.

---

## F3 — The ingest-limits mirror is prose on both sides, enforced on neither — **medium**

**Evidence**

- `GeekAPI/Services/GeekCrawler/GeekCrawlerIngestLimits.cs` — `MaxLinksPerBatch = 10_000`,
  `MaxPagesPerBatch = 100`, with remarks requiring they equal Geek-Crawler-v2's constants
- `Controllers/GeekCrawler/GeekCrawlerIngestController.cs:608, 746` — correctly uses the constants
  (no bare `2000` remains anywhere in the GeekCrawler controllers or services)
- Geek-Crawler-v2 `src/storage/ingest-limits.ts:38` — `MAX_LINKS_PER_BATCH = 10_000`

Both sides now say the numbers must match. Nothing verifies it. The class's own remarks state the
consequence: *"if it lags, every large batch is rejected at the boundary with a 400 the crawler
treats as a hard failure."* That is not hypothetical — it is what killed a netsuite.com crawl on
2026-09-28 under the previous value.

**Fix** — a contract test. Cheapest form: GeekAPI exposes the limits on an unauthenticated
`GET /api/geek-crawler/ingest/limits`, and Geek-Crawler-v2's suite asserts its constants equal
what that endpoint returns. Drift then fails a test run instead of a production crawl.

---

## F4 — Legacy Markdown names persist in the EF schema — **low**

**Evidence** — `.cs` files still containing "markdown", excluding `bin`/`obj`:

- `GeekRepository/Data/Migrations/GeekCrawler/20260907120000_AddGeekCrawlerPageMarkdownFields.cs`
- `GeekRepository/Data/Migrations/GeekCrawler/20260908123100_AddGeekCrawlerRunMarkdownReadyAt.cs`
- `GeekBackend.Tests/ContentCreator/GccReviseTests.cs`
- `GeekAPI/Services/ContentCreator/GccGenerateService.cs:1489-1490` — **compliant**: a comment
  explaining that Markdown is banned end to end. Not a violation; listed so a future grep does not
  re-flag it.

Applied migrations are history and should not be rewritten. But per this project's own doctrine —
*"the test for an occurrence is not 'does this execute', it is 'can this be read as evidence'"* —
migration filenames are exactly what someone greps and misreads.

**Fix** — a short note in the crawler's `plans/retire-legacy-corpus-format.md` recording that
`crawl_pages.Markdown`, `MarkdownBackfilledAt` and `crawl_runs.MarkdownReadyAt` remain as undropped
columns in a deprecated schema, that this is deliberate, and that the migrations are history.
Nothing to change in code.

---

## F5 — Markup discipline holds — **no action**

Grepping `GeekAPI/Services` for string-concatenated tags (`Append("<`, `+ "<x`, `$"<x`) outside
`SectionHtmlRenderer` returns **nothing**. The single-renderer rule of CLAUDE.md §1b is intact on
the server. Recorded because it is the rule most likely to erode quietly, and because
content-creator-v2 does **not** hold it (see that repo's F1).

---

## Plan

| # | action | effort | unblocks |
|---|---|---|---|
| 1 | Row count on `GccV2ProjectSiteCrawlPages` for a recent runId | minutes | F1 |
| 2 | Set `ProjectSitePageSource = "mongo"` in appsettings | minutes | F1 |
| 3 | Container-resolution test for the default source | small | F1 regression |
| 4 | Make the empty-pages path fail closed | small | F2 |
| 5 | `GET ingest/limits` + cross-repo contract test | small | F3 |
| 6 | Decide and record the fate of `GccV2ProjectSiteCrawlService` | discussion | F1 root cause |
| 7 | Note the undropped Markdown columns as deliberate | minutes | F4 |

Items 1-2 are reversible and answer the largest open question in the pipeline. Item 6 is the only
one that is a decision rather than a task.
