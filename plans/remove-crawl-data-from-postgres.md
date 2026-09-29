# Remove crawl data from Postgres

**Status: NOT STARTED. Surface mapped 2026-09-29 from GeekBackend's working tree.
Owned by GeekBackend — filed here because the audit that found it is in this repo's `docs/`.**

> CRAWL DATA DOES NOT EVER BELONG IN POSTGRES, PERIOD. — Jeff, 2026-09-29

The `geek_crawler` Postgres layer was removed on 2026-09-29 (`GeekCrawlerDbContext`, its
migrations, the seed-key backfill). **That did not cover this.** Three crawl-shaped tables live in
a *different* context, `ContentCreatorV2DbContext`, and are still read and written today.

## Why, and the order

The rule is the reason. Crawl data does not belong in Postgres, so it goes — that does not wait on
a cost analysis, and no measurement makes it acceptable to leave.

Order still matters, because deleting code neither stops writes nor removes rows:

1. Stop the writes (§2) — otherwise the data comes back
2. Drop the data (§5) — code removal alone leaves the rows in place
3. Remove the code (§3, §4) — so nothing recreates or re-reads it

Doing 3 without 2 and 5 leaves crawl rows in Postgres, which is the thing the rule forbids.

## 1. The surface, complete

| what | where | count |
|---|---|---|
| Entities | `GeekRepository/Data/Entities/ContentCreatorV2/GccV2ProjectSiteCrawl{Run,Page,Link}.cs` | 3 |
| DbSets | `ContentCreatorV2DbContext.cs:24-26` | 3 |
| Repository controllers | `GeekRepository/Controllers/ContentCreatorV2/GccV2ProjectSiteCrawl{Runs,Pages,Links}Controller.cs` | 3 |
| GeekAPI client methods | `HttpGccV2Repository.cs:194-266` | 11 |
| Read adapter | `GccV2PostgresProjectSitePageSource` + the DI selector at `ServiceRegistration.cs:136-142` | 1 |
| Writer | `GccV2ProjectSiteCrawlService` + `GccV2ProjectSiteBfsCrawler` + `GccV2ProjectSiteCrawlWorker` | 3 |
| Migrations naming these tables | `GeekRepository/Data/Migrations/` | 11 files |

## 2. Stop the writes — retire GeekAPI's own crawler

`GccV2ProjectSiteCrawlService:83` creates a run and `:142` batches pages into Postgres. It drives
`GccV2ProjectSiteBfsCrawler` — **a second crawler**, separate from Geek-Crawler-v2.

That duplication is the root cause, not the storage choice. Geek-Crawler-v2 already crawls
project-site: run `a53dfcac` took geekatyourspot.com to 348/348 pages on 2026-09-28 and landed in
Mongo. Two crawlers writing two stores is why generation could read a store the crawler never
filled.

Retire the service, its BFS crawler, and its worker. `POST project-site/crawl` then either
forwards to Geek-Crawler-v2 or goes away — that is a product decision, not a cleanup.

## 3. Stop the reads — one line, immediately reversible

`ServiceRegistration.cs:136-142` selects the page source and **defaults to `"postgres"`**, with no
appsettings entry anywhere in GeekBackend setting it. Set
`ContentCreatorV2:ProjectSitePageSource = "mongo"` and redeploy.

`GccV2MongoProjectSitePageSource` already exists and its projection is covered by
`GccV2ProjectSitePageSourceTests` — which today tests the branch that is *not* selected.

Do this first. It is one config value, it proves the Mongo path serves real traffic, and it is
undone by changing the value back.

## 4. Remove the code

Once §2 and §3 hold, in this order so nothing is left pointing at something gone:

1. `GccV2PostgresProjectSitePageSource` and the DI selector — `IGccV2ProjectSitePageSource` binds
   straight to the Mongo implementation, no flag
2. The 11 `HttpGccV2Repository` methods
3. The 3 repository controllers
4. The 3 DbSets, then the 3 entity classes

Add a container-resolution test asserting which concrete type `IGccV2ProjectSitePageSource`
resolves to. The current test proves a projection; it never proved a selection, which is how the
default went unnoticed.

## 5. Drop the data

Needs a migration that drops the three tables, or a manual drop against the database — a decision
about whether an already-migrated schema gets a drop migration, which CLAUDE.md notes was
deliberately avoided for the `geek_crawler` leftovers.

Difference here: those were unreachable once the code went, so leaving them broke no rule. **These
are crawl data in Postgres**, which the rule forbids outright. Removing the code without dropping
the rows does not satisfy it.

## 6. Verify

1. `GET api/geek-content-creator-v2/project-site/runs/{runId}/pages` for a Geek-Crawler-v2
   project-site run returns its pages — proves the Mongo read path serves what the crawler wrote
2. No EF entity, DbSet, controller or client method names a crawl table
3. The three tables no longer exist; no crawl rows remain in Postgres
4. A generation run still grounds on project-site content

## Not in this plan

- **The Mongo crawl store.** Untouched; it is where crawl data belongs.
- **`GccV2ProjectSiteKnowledgeService`.** Consumes the source interface, not the store, so it
  needs no change.
- **The context object store (C0).** A separate GeekBackend defect, in `docs/audit-00-index.md`.
