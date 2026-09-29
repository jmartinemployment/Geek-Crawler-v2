# Five-repo audit — Content Creator v2 pipeline

**Date:** 2026-09-28 · **Method:** direct read of each repo's working tree. Every finding below
cites `file:line`. Where I inferred rather than observed, the finding says so.

## Scope, stated honestly

This is a **targeted** audit, not a line-by-line review of five repos. It hunts one family of
defect, the family this pipeline actually keeps producing:

> Code that is fully implemented, passes review, and reads from or writes to the wrong place —
> or documents a property that nothing enforces.

That framing came out of the session that preceded it: a `competitors` crawl profile whose
"thin slice" budget is never consulted, an ingest limit that claimed to mirror a class that did
not exist, and a project-site read path pointed at a store nothing writes. None of those are
stubs. None would be caught by "no placeholders, no TODOs". All of them are live.

What this audit does **not** cover: performance, security posture, dependency CVEs, UI/UX,
accessibility, or exhaustive correctness of business logic. GeekOAuth received the lightest pass
(see its file for what that means).

## The five repos

| repo | role in the pipeline | findings | worst |
|---|---|---|---|
| [GeekBackend](./audit-geekbackend.md) | GeekAPI + GeekRepository: generation, ingest, storage | 5 | **critical** |
| [Geek-Crawler-v2](./audit-geek-crawler-v2.md) | the crawler; writes corpus to Mongo via GeekAPI | 5 | **high** |
| [content-creator-v2](./audit-content-creator-v2.md) | the live operator frontend | 4 | **medium** |
| [Geek-Crawler-Rag](./audit-geek-crawler-rag.md) | Library half: retrieval + quote verification | 3 | **high** (F3, after classification) |
| [GeekOAuth](./audit-geekoauth.md) | OIDC provider CCv2 authenticates against | 2 | **low** |

## Cross-repo findings, ranked

### C0 — A missing config value takes out the entire ContentCreatorV2 context subsystem — **critical, observed in production 2026-09-29**

Not inferred. Reproduced against live GeekAPI, cause read from the Railway deploy log.

**Symptom.** Every route on `GccV2ProjectSiteController` returns `HTTP 500` with
`content-length: 0`. Verified on three: `runs/{id}/pages`, `runs`, `runs/latest`.

**Cause**, from the GeekAPI deploy log at 09:06:48Z and 09:07:17Z:

```
System.InvalidOperationException: ContentCreatorV2:ContextObjectStore:Bucket is required.
   at GccV2S3ContextObjectStore.Required(...)  Context/GccV2ContextObjectStore.cs:175
   at GccV2S3ContextObjectStore..ctor(HttpClient, IConfiguration)  :35
   at DefaultTypedHttpClientFactory`1.CreateClient   <- DI construction, before any handler
```

The constructor validates four required keys (`Bucket`, `Endpoint`, `AccessKeyId`,
`SecretAccessKey`) and throws. Because it is a typed `HttpClient` resolved during DI, **the
controller is never constructed** and the request dies before reaching a single line of handler
code.

**Blast radius** — every consumer of `IGccV2ContextObjectStore`:

- `GccV2ProjectSiteController` (via `GccV2ProjectSiteKnowledgeService`) — confirmed dead
- `GccV2ContextController`
- `GccV2DriveKnowledgeService`, `GccV2GscKnowledgeService`, `GccV2UrlKnowledgeService`,
  `GccV2SharePointKnowledgeService`, `GccV2UrlAttachmentService`, `GccV2ProjectSiteKnowledgeService`
- background workers `GccV2ContextIngestionWorker`, `GccV2ContextRetentionWorker`
  (both `GetRequiredService`, so they throw inside the worker loop)

**Status of the variable.** `ContentCreatorV2__ContextObjectStore__Bucket` **is present** in
Railway production (GeekAPI service, production env). The deployment currently serving is
`2c04465b`, created 2026-09-28T22:29:49Z from commit `f024fe0`. So the name exists and the running
build still throws, which leaves two candidates: **the value is empty/whitespace**, or the value
was changed without a redeploy. Railway returns names only to this client, so the value itself must
be read from the dashboard.

**This blocks C1.** The project-site read path cannot be observed through its controller while the
controller cannot be constructed.

**Fix**

1. Read `ContentCreatorV2__ContextObjectStore__Bucket` in the Railway dashboard. If empty, set it
   and redeploy. If non-empty, redeploy anyway — the running build predates the current value.
2. Re-run `GET /api/geek-content-creator-v2/project-site/runs/{runId}/pages`. A non-500 answer
   unblocks C1 and answers it in the same request.
3. **Structural**: a constructor that throws on missing configuration turns a config gap into
   unrelated 500s at request time. Validate this section **at startup** — the pattern already
   exists in this codebase as `GccV2StubConnectionStartupGuard`. A service that cannot be
   configured should fail the deploy loudly, not fail nine consumers quietly.
4. Return a body with 500s on this path. A bare 500 with `content-length: 0` is exactly the
   signature commit `f024fe0` identified yesterday as undiagnosable: *"Every one a bare 500 with an
   empty body, which is why none were diagnosable from the crawler's archive."* Same shape, second
   instance.


### C1 — Generation reads a store the crawler never writes — **RESOLVED 2026-09-29, GeekBackend@da6a98e**

Removed entirely rather than repointed, because a second rule settled it:

> THE ONLY AUTHORIZED PATH TO POSTGRES IS GEEK-API -> GEEK-REPOSITORY -> SUPABASE.
> UNAUTHORIZED CONNECTIONS ARE TO BE DELETED. — Jeff, 2026-09-29

and crawl data is barred from Postgres outright. So the fix was not "point the flag at Mongo" but
delete the Postgres surface and the second crawler that filled it: the controller, the BFS crawler
and its service, worker, notifier, coordinator and stall recovery, the dead SignalR hub surface,
11 `HttpGccV2Repository` methods, 3 repository controllers, 3 DbSets, 3 entities, and
`GccV2PostgresProjectSitePageSource`. `IGccV2ProjectSitePageSource` binds straight to Mongo with
no flag to get wrong.

`20260929130000_DropProjectSiteCrawlTables` drops the three tables on the next GeekRepository
deploy. `PostgresIsOAuthOnlyTests` is the tripwire that keeps them gone — the enforcement this
audit kept asking for, now a failing test rather than a sentence.

Build clean, 1,192 unit and 51 integration tests passing. Trace count 382 → 191, the remainder
being the surviving Mongo projection DTO, test fakes using it, and `ProjectSiteCrawlRunId`, a Guid
reference that can point at a Geek-Crawler-v2 run.

*Original finding, for the record:*

### C1 (original) — Generation reads a store the crawler never writes (critical)

`ContentCreatorV2:ProjectSitePageSource` defaults to `"postgres"`
(`ServiceRegistration.cs:136-142`) and is set in **no appsettings file in GeekBackend**. So
generation resolves `GccV2PostgresProjectSitePageSource` — the branch whose own doc comment says
*"Reads from the Postgres project-site tables. The path being retired."*

Geek-Crawler-v2 writes corpus to Mongo `geek_crawler`. The Postgres table
`GccV2ProjectSiteCrawlPages` is written by exactly one caller,
`GccV2ProjectSiteCrawlService.cs:142` — GeekAPI's own BFS crawler, a separate crawler from the one
producing your corpus.

**Two crawlers, two stores, and generation reads the one your crawler does not fill.**

Spans GeekBackend (the flag, the default, the two sources) and Geek-Crawler-v2 (the writer that
targets Mongo). Neither repo is wrong on its own.

### C2 — Empty crawl data degrades generation silently (critical)

`GccController.cs:~664`: when a run returns no pages, it logs
*"run {RunId} returned no pages, so this create generates without it"* and returns null.
Generation then proceeds ungrounded.

Combined with C1 this is the whole failure: the read returns empty because it is pointed at the
wrong store, and the empty result is absorbed as a normal condition. The output looks fine. This
directly contradicts the project rule that a boundary fails closed rather than continuing on
absent data.

### C3 — Crawl type is load-bearing in one consumer and invisible to the other (high)

GeekAPI resolves corpus by `GetLatestRunAsync(ownerUserId, crawlType, seedsJson, ct)` and splits
its extractors into `ContentCreatorV2/Partner/` and `ContentCreatorV2/Competitor/`. Crawl type
decides what generation sees.

Geek-Crawler-Rag can filter on a `crawlType` payload key (`qdrant_store.py:461-479`) but
**`app.py` contains zero `crawl_type` references** — no endpoint exposes it. Vector retrieval is
type-blind.

So the same corpus is partitioned by type on one path and pooled on the other. Whether that is
intended is a decision nobody has recorded.

### C4 — Mirrored constants with nothing enforcing the mirror (medium)

`MAX_LINKS_PER_BATCH` / `MAX_PAGES_PER_BATCH` in Geek-Crawler-v2 must equal
`GeekCrawlerIngestLimits.MaxLinksPerBatch` / `.MaxPagesPerBatch` in GeekBackend. Both sides now
say so in prose. **Nothing checks it.** Raising one alone rejects large batches at the boundary
with a 400 the crawler treats as fatal — which is how a netsuite.com crawl died on 2026-09-28.

This was partly repaired during the session (the server class now exists and the controller uses
it at `GeekCrawlerIngestController.cs:746`), but the enforcement gap is unchanged.

## Suggested order of work

1. **C0** — blocks C1 and takes out nine consumers. Start here.
2. **C1** — one config line proves or disproves the whole grounding path. Cheapest, highest value.
3. **C2** — make the empty read fail closed, so C1 can never recur silently.
4. **Geek-Crawler-v2 F1** (profile levers inert) — currently `competitors` and `local` do not do
   what they say.
5. **C4** — a contract test across the two repos.
6. **C3** — a decision to record, then implement either way.
7. Everything else, per-repo.

## The rule that would have caught most of this

Already written down, in this repo's own CLAUDE.md:

> Never document a safety property that no check enforces.

C1 was documented as *"Flag-gated so the read path can move and be proven before GeekAPI stops
writing Postgres at all."* The flag shipped. The proving never happened, and the default stayed on
the retiring path. C4 was documented as a mirror while one side of the mirror did not exist.

"No stubs" would not have caught a single finding in this audit.
