# Speed up RAG indexing

**Status: TIER 1 AND TIER 2 SHIPPED 2026-09-29** — Geek-Crawler-Rag `bbbda16` and `fb436be`,
275 tests passing. Tier 3 remains (ops, no code). Original plan text below; the Tier 2 design was
revised before implementation, see that section.

**Superseded status line:** NOT STARTED. Tier 1 is four contained changes in Geek-Crawler-Rag; Tier 2 is a separate
structural change. Measurements and file:line references verified 2026-09-29 against that repo's
working tree.**

**Owner: Geek-Crawler-Rag.** Filed here because this repo's operators are the ones waiting on the
queue, and `docs/audit-geek-crawler-rag.md` holds the related findings.

## Context

Indexing is the bottleneck before any more crawling. Ten crawled runs are unindexed, and the two
that did index took ~10 min (348 pages) and ~19 min (897 pages).

The rate-limit theory is wrong, and the repo already says so. `README.md` measured mid-run on the
VPS: the api container at **86% of one core against a 3.0-core limit**, Qdrant 0.17%, Mongo 0.6% —
*"the indexer is latency-bound on serialized round trips."* 86% of one core with two idle is a
single-threaded event loop doing blocking work, not a throttled one.

Two supporting facts: `rateLimitRetries` is **never incremented** anywhere (initialised at
`embedding_throttle.py:42`, read at `llama_engine.py:128`, structurally always 0), and
`total_wait_seconds` counts only time blocked by the throttle's own rolling window — not OpenAI
latency, not lock contention. So the usual "check /health" would have told us little.

The cost is **fixed overhead paid per flush**, and per-node work done per node that should be per
page.

**SPLADE is out of scope, and not because it is expensive.** Sparse retrieval was built
deliberately in `448b25c` - *"built rather than flipped on"* - after an earlier change turned
`enable_hybrid=True` on with none of the infrastructure behind it and had to be reverted. It fixes
a real retrieval defect, named by its own test: dense vectors miss exact terms and proper nouns,
and sparse catches them. It is recent, load-bearing, and carries a careful migration behind it.

Do not touch the sparse encoder, its model, its inputs, `MetadataMode`, or
`hybrid_retrieval_enabled`. Changing what SPLADE is fed changes what is indexed sparsely, which
re-opens the defect it was added to close.

---

## Tier 1 — do now. Contained, no effect on retrieval quality or existing vectors.

### 1. Kill the 0.5s sleep after every flush

```
config.py:18              qdrant_upsert_delay_seconds: 0.5  →  0.0
deploy/hostinger-compose.yml:53   QDRANT_UPSERT_DELAY_SECONDS: :-0.5  →  :-0
```

Keep the `if > 0` guard at `indexer.py:680` so the knob survives as backpressure escape hatch.

`README.md` already claims this was removed. It was not — code and both config sources still ship
0.5. This makes the README true.

### 2. One batch size instead of three

```
config.py:73              embed_batch_size: 32  →  64
deploy/hostinger-compose.yml:44   EMBED_BATCH_SIZE: :-56  →  :-64
```

Today config says 32, compose ships 56, README says 64. Pick 64: README calls it "the supported
setting" and `hostinger-compose.yml:82` sizes the container for it (*"EMBED_BATCH_SIZE=64 peaks
near ~3.9 GiB"*). 128 was OOM-killed — that is the ceiling.

Note this value drives three things at once: the indexer flush threshold (`indexer.py:664`), the
OpenAI batch cap (`llama_engine.py:285`), and the Qdrant batch (`llama_engine.py:109`). Memory is
the binding constraint, which is why 128 died.

### 3. Hoist the page digest out of the per-node loop

`llama_nodes.py:206` computes `hashlib.sha256(page.content_html or page.html)` inside `_node()`,
which `page_to_nodes` calls from `for unit in units:` (`llama_nodes.py:70`). **A page producing 50
chunks hashes the entire page HTML 50 times**, on the event loop.

Compute it once per page in `page_to_nodes` and pass it to `_node()`. Same value on every node —
`sourceDigest` is per page by definition.

### 4. Stop pushing the status webhook on every flush

`_persist` (`indexer.py:300-301`) calls `self._webhook.notify(status)`, and `_persist` runs once
per flush (`indexer.py:679`). The comment at `indexer.py:671-678` puts that POST at **~500ms**.

Notify on state transitions and completion rather than every flush. The status stays durable in
Mongo either way — `_persist` writes it before notifying.

**Product tradeoff, needs a decision:** GeekAPI learns of progress less often, so any live
progress UI updates more coarsely. Keeping a cadence (e.g. notify at most every N seconds) is the
middle option.

---

## Tier 2 — the structural win, separate change

### 5. Cross-run embedding reuse

`point_id` is `uuid5(ns, f"{run_id}:{page_id}:{chunk_key}")` (`qdrant_store.py:26`). **`run_id` is
in the key**, so re-crawling a site re-embeds byte-identical text from scratch. The existing cache
(`llama_engine.py:197-229`) is a local `dict` scoped to one flush of ≤64 nodes — it only catches
the parent≡child collapse, not repeats across pages, batches, or runs.

`sourceDigest` is already stored on every node (`llama_nodes.py:206`) and never read back for
reuse.

Given how much of this corpus is re-crawls of the same sites, this is the largest saving available
— and the largest change. Do it after Tier 1, on its own, with its own measurements.

### Revised before implementation — cache the vector, not the point

The first draft of this section said to make the point id content-derived so the existing
`find_existing_point_ids` skip would hit across runs. **That would have broken retrieval.** A point
reused from an earlier run carries that run's `runId` in its payload, and retrieval filters on
`runId` (`qdrant_store.py:315`, `:470`, and the docstring at `:304`). Those chunks would be
invisible to the new run's queries: embedding saved, corpus lost.

What shipped instead separates the two ideas that draft had conflated:

- **Points stay per-run.** `point_id` is unchanged, `runId` filtering is unchanged, retrieval is
  unchanged. An upsert is cheap.
- **Vectors are cached**, keyed on `sha256(model, text)` — the embed call is the expensive thing
  and the only thing reused. `src/geek_crawler_rag/vector_cache.py`, a `rag_vector_cache`
  collection in the existing Mongo, async via motor like everything else in that repo.

Every failure is a miss: an unreadable cache does not stop indexing, a wrong-width vector is
dropped rather than served, and a write that does not land costs a re-embed next time rather than
this run.

---

## Tier 3 — no code

### 6. Lease vs actual run duration

`index_job_lease_seconds = 900`. `indexer.py:387-391` records a **148-page run taking 2,323s**,
which killed ten queued jobs. Pending runs are 250–900 pages. Raise the lease, or confirm it is
not biting.

### 7. OpenAI tier

Account ceiling is 1,000,000 TPM; the local throttle is pinned at 400,000 (40%) because running at
the ceiling on 2026-09-10 produced opaque HTTP 500s rather than clean 429s (`config.py:43-47`).
Raising the tier lifts both without touching code — but per the measurement above, this is
probably **not** the current bottleneck. Do Tier 1 first and re-measure.

---

## Explicitly not doing

- **SPLADE** — see the Context section. It resolves a retrieval defect (dense misses proper
  nouns), landed recently, and its backfill uses `update_vectors` rather than `upsert` precisely
  because upsert would have destroyed 168k dense embeddings beside it. Nothing here goes near it,
  including its inputs. Treating a correctness fix as overhead is how it gets quietly undone.
- **Changing embedding provider** (Gemini/Voyage/Cohere/Jina) — requires re-embedding the whole
  corpus through the very worker being sped up, and `config.py:37-38` warns a model mismatch does
  not error, it *"quietly returns the wrong passages."* A quality-or-cost decision, not a
  throughput one.
- **More workers or engines** — the embed lock (`llama_engine.py:85`) serialises every embed call
  process-wide, and each engine carries its own `EmbeddingThrottle`, so N engines is N×400k against
  a 1M ceiling. Reconstructs the 2026-09-10 incident by another route.

## Noted, not a speed issue

`QdrantVectorStore` defaults `max_retries=3` and is not overridden (`llama_engine.py:105-115`), so
the vector store silently retries `RpcError`/`UnexpectedResponse` — against this repo's
`openai_embedding_max_retries = 0` no-retry stance. Worth a separate decision.

---

## Verification

1. `.venv/bin/pytest tests/ -q` — full suite green (267 currently).
2. Confirm the three batch-size sources agree: `config.py:73`, `hostinger-compose.yml:44`, README.
3. Confirm no `asyncio.sleep` remains on the flush path: `grep -n "sleep" src/geek_crawler_rag/indexer.py`.
4. **Measure a real run before and after.** Index one pending run and compare `startedAtUtc` →
   `finishedAtUtc` against the recorded baselines: geekatyourspot `a53dfcac` 348 pages in ~10 min,
   medius `e9c8066d` 897 pages in ~19 min. Same sites, same page counts, so the comparison is
   clean.
5. ~~There are no per-stage timings anywhere.~~ **Added in `bbbda16`.** Each run now logs
   `Index timing runId=… totalSeconds=… chunkSeconds=… embedSeconds=… persistSeconds=…
   flushes=… batchSize=…`. Read that line on the first run after deploy — it attributes the time
   rather than leaving it to inference, which is what made the earlier diagnosis take three
   attempts.
