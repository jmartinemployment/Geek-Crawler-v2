# RAG Query Points — Plan

**Give consumers a way to see what's actually in the corpus, without inventing a fake semantic query.**

Scope: Geek-Crawler-Rag (new endpoints) + GeekAPI (thin proxy) + this repo's dashboard
(consumer). Filed here because the dashboard (`web/src/app/runs/[runId]`) is the concrete
consumer that motivated it, even though most of the new code lands in Geek-Crawler-Rag.

Every technical claim below was checked directly against source on 2026-09-19 — file/line cited
inline — not taken on trust from a research pass. Where a claim is still exactly as reported by
an earlier subagent, it's marked **[re-verified]**.

---

## Why

Triggered by trying to answer "what did a project-site crawl actually collect" from this repo's
dashboard. Chain: GeekAPI → GeekRepository → Hostinger Mongo/Qdrant → Geek-Crawler-Rag. Every hop
either exposes only aggregate counters, requires a semantic query string to see anything, or is
currently broken:

| Hop | What you can get today | Gap |
|---|---|---|
| GeekAPI `crawls/{runId}` | Run status + reject counters | No page-level detail |
| GeekAPI `crawls/{runId}/page-urls` | Flat `{origin,url,hasHtml}` list | No title, no content, no chunk info |
| GeekAPI `crawls/{runId}/rag-index` | Index job counters (pages, chunks, timing) | No content, just numbers |
| GeekAPI `crawls/{runId}/pages` | (meant to be full page docs) | **Broken — bare empty 500**, confirmed live, see below |
| Geek-Crawler-Rag `/v1/query` | Real chunk text + score | Requires a `need` string, min length 1 — no filter-only browse mode |
| Geek-Crawler-Rag `/v1/pages` | Full page plaintext + title | Requires knowing a `page_id` or exact `url` up front — nothing lists them |
| Qdrant | Everything, actually | No HTTP surface exposes list/count by `runId` without embedding a query |

A caller who has nothing but a `runId` cannot see one page of real content or one indexed chunk
without already knowing a URL, a page_id, or writing a query string a human would type. That's
the gap this plan closes.

---

## Scope

| In | Out |
|----|-----|
| New read-only "browse" endpoints on Geek-Crawler-Rag, keyed by `runId` alone | Changing the index/embed pipeline |
| GeekAPI thin-proxy routes for the above (mirrors the existing `rag-index` pattern) | Rewriting `/v1/query`'s ranking/rerank logic |
| Flagging + shape of the fix for the GeekRepository `/pages` 500 | Actually implementing the GeekRepository fix (different repo/language, separate PR) |
| Wiring this repo's dashboard to the new endpoints | Redesigning the dashboard UI |
| Documenting the current auth/trust boundary + a decision on tightening it | Building a full per-tenant API-key system (unless option B below is chosen) |

---

## New query points (Geek-Crawler-Rag)

### 1. `GET /v1/runs/{run_id}/pages?limit=&offset=`

Verified directly (`src/geek_crawler_rag/mongo.py:215-230`, `indexer.py:445`): `MongoCorpus.iter_pages(run_id, batch_size=25)` already exists as an async-generator paginator over a run's pages, projecting `Id/RunId/Origin/Url/FinalUrl/Html/ContentHtml/Blocks/...`. Its **only** caller anywhere in `src/` is the indexer — no HTTP route wraps it today.

- New route wraps it with limit/offset (same convention `/v1/index` etc. use), returns
  `page_id, url, final_url, title, content_ready` (derived: has usable `blocks`/`content_html`),
  `crawled_at`.
- Not full text — that stays behind `/v1/pages/{page_id}` on purpose; dumping full text for
  300+ pages in one call is a bad idea.
- Direct fix for "is that all that's collected" — a real page list with titles, not just bare
  URLs.

### 2. `GET /v1/runs/{run_id}/chunks?limit=&offset=&host=`

Verified directly (`qdrant_store.py:559-618`): `search_text` already builds exactly this shape —
`self.build_filter(run_id=..., owner_id=..., visibility=..., host=..., ...)` to a Qdrant
`Filter`, then `self._client.scroll(collection_name=..., scroll_filter=query_filter, limit=...,
with_payload=True, with_vectors=False)`. The only thing making it a *search* instead of a
*listing* is the extra `should=[MatchText(...)]` clause layered on top for the `need` string.

- New route: same `build_filter` + `scroll` call, **without** the text-match clause — a real
  browse mode, not a hidden feature of `/v1/query`.
- Returns the same fields `/v1/query` already returns per hit (`chunkId, pageId, url, title,
  chunkIndex, sectionTitle, text` as a bounded excerpt, `parserId`, `embeddingModel`), ordered by
  `chunkIndex`/insertion instead of relevance.
- Answers "how many chunks, of what, for this run" beyond the aggregate `chunksUpserted` count
  `/v1/index/{run_id}` already returns.

### 3. `GET /v1/runs/{run_id}/chunks/count?host=`

Not backed by an existing wrapper — `qdrant_store.py` has no `count()` method today, only
`scroll`-based reads. To build: the same `build_filter(...)` plus the qdrant-client SDK's native
`count()` call, no payload fetch. Cheap version of #2 for dashboards that just want a number.

### 4. (Lower priority) Loosen `/v1/query`'s `need` requirement

Verified directly (`models.py:67`): `QueryRequest.need: str = Field(..., min_length=1)` —
required, no default. Allowing `need: null` → "no semantic ranking, just filter+paginate" would
cover the same need as #1/#2 through one endpoint, but #1/#2 are simpler to reason about (no
ranking code involved) and already close the actual gap. Optional polish, not required.

---

## Auth — a decision to make, not just a bug

Every one of these reads (existing and proposed) trusts the caller-supplied `runId`/`ownerId`
behind one shared `X-Api-Key` (`require_api_key`, `app.py`, `secrets.compare_digest` against a
single configured secret — no per-caller keys). GeekAPI enforces per-user ownership before it
proxies to Geek-Crawler-Rag — verified directly
(`GeekAPI/Controllers/GeekCrawler/GeekCrawlerController.cs:285-290`):

```csharp
private async Task<bool> OwnsRunAsync(Guid runId, CancellationToken ct)
{
    var run = await _repo.GetRunAsync(runId, ct).ConfigureAwait(false);
    return run is not null
           && string.Equals(run.OwnerUserId, _user.UserId.ToString("D"), StringComparison.Ordinal);
}
```

So today that's fine as long as GeekAPI is the only caller. It stops being fine the moment
anything else holds that shared API key and calls Geek-Crawler-Rag directly — nothing on the RAG
side checks that the `ownerId` a caller supplies is actually theirs.

Pick one:

- **(A) Keep it.** Geek-Crawler-Rag stays a trusted-internal-service-only surface; ownership
  enforcement lives entirely in GeekAPI's proxy layer (`OwnsRunAsync`, above). Document that
  explicitly in `architecture.md` — a one-line note would have preempted this question entirely.
- **(B) Push ownership down.** New endpoints (and ideally `/v1/pages*`, `/v1/query`) verify the
  caller-supplied `ownerId` against something GeekAPI signs and forwards — the same
  manifest-signature pattern `/v1/context/assets/*` already uses. Real defense in depth, more
  work.

**Recommendation: (A) now** — nothing today calls Geek-Crawler-Rag except GeekAPI, and (B) is a
materially bigger change than "add three read endpoints."

---

## GeekAPI wiring (thin proxy, mirrors `rag-index`)

Same shape as the existing `GET /api/geek-crawler/crawls/{runId}/rag-index` passthrough
(`GeekCrawlerController.cs:167-197`, calls `_rag.GetIndexStatusAsync` behind the same
`OwnsRunAsync` check):

- `GET /api/geek-crawler/crawls/{runId}/rag-pages` → proxies §1
- `GET /api/geek-crawler/crawls/{runId}/rag-chunks` → proxies §2 / §3

Both go through the existing `OwnsRunAsync` check already on this controller, so option (A) above
holds end to end without new auth code.

---

## Blocker to flag, not fix here: GeekRepository `/pages` 500

Root cause confirmed directly by reading the live handler
(`GeekRepository/Controllers/GeekCrawler/GeekCrawlerPagesController.cs:21-36`):

```csharp
[HttpGet]
public async Task<ActionResult<IReadOnlyList<GeekCrawlerPage>>> ListByRun(...)
{
    var pages = await _mongo.ListPagesByRunAsync(runId, limit, offset, ct);
    return Ok(pages);   // raw entity, no DTO projection
}
```

`GeekCrawlerPage.Blocks` is declared `public BsonArray? Blocks { get; set; }` (confirmed,
`Data/Entities/GeekCrawler/GeekCrawlerPage.cs`). Confirmed directly: no `JsonConverter<BsonArray>`
or `JsonConverter<BsonValue>` exists anywhere in the GeekRepository project (`Program.cs:19` calls
`AddJsonOptions` with camelCase naming only, no BSON converter registered). `System.Text.Json` has
no built-in support for MongoDB.Bson types, so serializing a non-null `Blocks` throws mid-response
— after status/headers are already committed, which is exactly the bare-empty-500 symptom this
endpoint produces. Legacy pages with `Blocks == null` serialize fine (null is trivial), which is
why this wasn't caught immediately — only pages ingested through the blocks-based extractor break.

The **reverse** conversion already exists in the same file (`CreateBatch`, lines 149-156):

```csharp
private static BsonArray? ToBsonArray(JsonElement? blocks)
{
    if (blocks is not { ValueKind: JsonValueKind.Array } element) return null;
    var raw = element.GetRawText();
    return string.IsNullOrWhiteSpace(raw) ? null : BsonSerializer.Deserialize<BsonArray>(raw);
}
```

Fix shape (GeekRepository, separate PR, different repo/language — not part of this plan's
checklist): mirror that conversion in the outbound direction — project to a DTO that serializes
`Blocks` back to raw JSON via `BsonSerializer`, or register a `JsonConverter<BsonArray>` globally.
Same class of bug affects `ListBySeeds` (line 38-59) for the same reason — it returns the same
entity type.

This doesn't block the plan above — the new query points live entirely on the Geek-Crawler-Rag /
Qdrant / Mongo(direct-read) side and never call this endpoint. It's noted here because it's the
same landmine the ContentCreatorV2 Mongo-backed project-site page source
(`GccV2MongoProjectSitePageSource`) would hit if that read path is active. **Do not state which
page source is live from this repo** — `ServiceRegistration.cs:131-143` only shows a code
fallback (`GetValue("ContentCreatorV2:ProjectSitePageSource", "postgres")`); the actual value is
set by deployed environment config outside this checkout and was not confirmed. The surrounding
comment says Postgres is "the path being retired" in favor of Mongo, so treat the live selection
as unknown, not as `postgres` by default.

---

## Dashboard follow-up

Once §1/§2/§3 exist and are proxied, `web/src/app/runs/[runId]` and `RunLiveView` in this repo
gain a real "Pages" and "Chunks" tab instead of the current bare-URL-list-only view.

---

## Checklist

- [ ] `GET /v1/runs/{run_id}/pages` (Geek-Crawler-Rag)
- [ ] `GET /v1/runs/{run_id}/chunks` (Geek-Crawler-Rag)
- [ ] `GET /v1/runs/{run_id}/chunks/count` (Geek-Crawler-Rag)
- [ ] Document the auth trust boundary in Geek-Crawler-Rag's `architecture.md` (decision A above)
- [ ] `GET /api/geek-crawler/crawls/{runId}/rag-pages` proxy (GeekAPI)
- [ ] `GET /api/geek-crawler/crawls/{runId}/rag-chunks` proxy (GeekAPI)
- [ ] Dashboard: Pages + Chunks tabs on the run detail page (this repo)
- [ ] *(Separate repo/PR, not this plan)* GeekRepository `Blocks` BsonArray → JSON fix

---

## Effort

~3–5 days: 3 new Geek-Crawler-Rag endpoints + tests (read-only wraps of existing internal
methods/patterns, ~1–2 days), 2 GeekAPI proxy routes (~half day), dashboard wiring (~1 day), doc
note (~1 hour).
