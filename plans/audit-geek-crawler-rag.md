# Audit — Geek-Crawler-Rag

**Role:** the Library half — retrieval and quote verification against the crawler's corpus.
It never generates.
**Audited:** 2026-09-28, working tree.

---

## F1 — Retrieval cannot be filtered by crawl type; extraction is filtered by it — **medium**

**Evidence**

- `src/geek_crawler_rag/qdrant_store.py:226` indexes a `crawlType` payload key
- `:461-479` — `search(..., crawl_type: str | None = None)` builds
  `qm.FieldCondition(key="crawlType", match=qm.MatchValue(value=crawl_type))`
- `:645`, `:682` — the parameter is threaded through further entry points
- **`app.py` contains zero occurrences of `crawl_type` or `crawlType`** — no endpoint, `/query`
  included, accepts it

The only caller that supplies a value is `graph_retrieve.py:47,66`, passing `crawl_type=best.crawl_type`
— propagating the type of a hit already found during graph expansion, not a caller's filter.

So the capability is built, indexed and unreachable. Meanwhile GeekAPI resolves corpus **by**
crawl type (`GetLatestRunAsync(ownerUserId, crawlType, seedsJson, ct)`) and splits its extractors
into `ContentCreatorV2/Partner/` and `ContentCreatorV2/Competitor/`.

The same corpus is partitioned by type on one consumption path and pooled on the other. A partner
query can retrieve competitor pages. That may be intended — retrieval by meaning across all
evidence is a legitimate design — but no record says so, and the half-built filter suggests it was
not a decision.

**Fix**

1. Record the decision. Either "retrieval is deliberately type-blind" goes in the repo's plans
   directory, or it does not.
2. If type-blind is right: remove `crawl_type` from the public `search` signature, keeping whatever
   `graph_retrieve` needs internally. An unreachable parameter on a public function reads as a
   supported feature.
3. If filtering is right: expose it on `/query`, and have GeekAPI pass the type it already knows.

---

## F2 — Stale bytecode for a deliberately removed module — **low**

**Evidence**

- `src/geek_crawler_rag/generate.py` — **absent**, correct
- `src/geek_crawler_rag/__pycache__/generate.cpython-310.pyc` and `generate.cpython-313.pyc` —
  **present on disk**
- `__pycache__/` is in `.gitignore:2`, and `git ls-files` shows **0** tracked `.pyc`

CLAUDE.md §1 is categorical: `POST /v1/generate` and `rag-generate.*` were deliberately removed and
must never be revived. The source is gone. The compiled artifacts of the removed module are not.

Not executable — Python will not import from `__pycache__` without the source — and not in version
control, so this is local hygiene rather than a repo defect. It is listed because of this project's
own standard: *"The test for an occurrence is not 'does this execute' — it is 'can this be read as
evidence.'"* A `generate.*.pyc` in the RAG library is readable as evidence of a generate path.

**Fix** — `find . -name '__pycache__' -type d -exec rm -rf {} +` on the working copy. If the repo
ever adds a cleanliness check, include stale bytecode for removed modules.

---

## F3 — Broad exception handling, classified — **one fail-open, high**

The pass the earlier draft of this file said it had not done. 34 `except Exception`
sites across `src`. Four were read in full; the remaining 30 were classified from the
handler body, which is where the fail-open/fail-closed distinction actually lives.

### Fail open — fix

**`rerank.py:65` — fabricated relevance scores. High.**

```python
except Exception:
    logger.exception("Cohere rerank failed; using dense/hybrid order")
    return [(i, float(len(documents) - i)) for i in range(top_n)]
```

On any rerank failure this returns synthetic scores descending by input position.
That is not "no rerank applied" — it is a scored list the caller cannot distinguish
from a real one, built from data no reranker ever saw. Rule 2 names this exactly:
never default to unverified data to salvage the operation.

It matters more here than it would elsewhere. Rerank order decides which chunks reach
the model as grounding evidence, so a silent degradation to positional order changes
what gets cited, with nothing in the response saying so.

*Fix:* return a clean failure the caller can see. `query.py` already has the vocabulary
for it — see below — so this can report unranked rather than invent ranking.

### Fail closed, and the pattern to copy

**`query.py:145` is the model.** It distinguishes two things most of this codebase
collapses:

```python
retrieval="error"    # with warning: "Query failed due to an internal retrieval error."
retrieval="empty"    # genuinely no chunks for this runId
```

An empty result and a broken search are different answers and it says which. Every
other site in this list that returns `[]` or `None` on failure should be measured
against this one.

### Worth narrowing, low risk

| site | behaviour | why it is tolerable, and what to tighten |
|---|---|---|
| `qdrant_store.py:732` | scroll failure → `[]` | An empty search result reads as "no matches". Logged, but the caller cannot tell. Give it the `query.py` treatment |
| `qdrant_store.py:779` | host lookup failure → `None` | Same shape. `/v1/index/hosts` resolves a host to a runId, so "not found" and "lookup broke" have different consequences |
| `unusable.py:93` | any exception → `False` | False means "not locale-excluded", i.e. keep the page. Consistent with the function's own default for a URL with no path segment, so a malformed URL is kept rather than dropped. Narrow to the parse error rather than `Exception` |
| `mongo.py:264` | load failure → default entity | The value returned is computed unconditionally above and is also the legitimate no-match answer, so this is a default rather than a backup path. The word "fallback" in the message is misleading. A failed load should still be distinguishable from no match |
| `extract.py:29` | `continue` | Skips one item silently during extraction. Bounded, but a dropped item leaves no trace |
| `ad_templates.py:186` | → empty response | Empty and failed are indistinguishable to the caller |
| `indexer.py:440` | `pass` | Bare swallow, no log |

### Correct as written — no action

`app.py:246,252,271` report each health failure into an `errors` list rather than
hiding it. `indexer.py:295,355,376,715` log and fail the index. `indexer.py:462` raises
`LeaseLostError` once the failure limit is passed. `llama_engine.py:135-147` ignore
client-close errors during shutdown, which is the one place ignoring is right.
`llama_engine.py:332,360` feed quarantine logic. `qdrant_store.py:129,196,216,258,272`
are idempotent index and collection setup. `qdrant_store.py:330` is deliberately broad
and documents why, narrowing immediately via `_is_missing_collection`. `scheduler.py:101`
keeps the loop alive after a failed tick; `:162` records and re-raises. `webhook.py:48`
states its reason outright: never fail the indexer because GeekAPI is down.
`ad_templates.py:86` skips one payload index field at debug level.

### Plan for F3

1. `rerank.py:65` — stop returning fabricated scores. The only genuine fail-open.
2. Give `qdrant_store.py:732` and `:779` the `query.py` error/empty distinction.
3. Narrow `unusable.py:93` to the parse error it is actually guarding.
4. Reword the `mongo.py:264` message so it stops describing a default as a fallback.
5. Add a log line at `indexer.py:440`; a bare `pass` leaves nothing to find.

Only item 1 changes behaviour that could affect what gets cited. The rest make failures
legible without changing outcomes.

## Confirmed clean

Checked directly, matching what CLAUDE.md claims — the claims hold:

- **Zero** case-insensitive `markdown` hits across every `.py` file in `src`
- No `generate.py`; no `/v1/generate` route in `app.py`
- Corpus handling is block-based: `extract.py`, `block_text.py`,
  `citation_verify.quote_in_text`, `unusable.py`

This is the repo whose stated migration status survived a fresh check without qualification.

---

## Plan

| # | action | effort |
|---|---|---|
| 1 | Record whether retrieval is deliberately type-blind | discussion |
| 2 | Remove or expose `crawl_type` on the public search surface, per 1 | small |
| 3 | Clear stale `__pycache__` | minutes |
| 4 | Classify the 34 `except Exception` sites; fix any that fail open | medium |

Item 4 is the one with real risk behind it. Items 1-2 are a decision plus a small edit.
