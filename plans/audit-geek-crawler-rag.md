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

## F3 — Broad exception handling, unaudited — **low, needs a pass I did not do**

34 `except Exception` sites across `src`. I did not classify them individually, so this is a
flagged area rather than a finding.

It matters here more than elsewhere: this repo's job is **verification**. A broad `except` around
`citation_verify.quote_in_text` that returns "unverified" is correct fail-closed behaviour; one
that returns "verified" or swallows a retrieval error into an empty result set is the failure mode
the whole Library exists to prevent.

**Fix** — one pass over those 34 sites, classifying each as (a) fail-closed, correct;
(b) fail-open, must change; (c) too broad to tell. Only (b) needs work, but (c) needs narrowing so
the next audit can tell.

---

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
