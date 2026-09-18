# Corpus rebuild: replace the extractor, delete the corpus, re-crawl

**Status: extractor replaced and verified in the working tree, uncommitted.
Output is clean semantic HTML — Markdown and Turndown are gone. Nothing deleted
yet.**

## Why

The stored corpus is not what the pages say. Measured against the visible prose
of three live pages — extracted text compared to the text the page actually
contains, both stripped of boilerplate:

| Page | Readability returned |
|---|---|
| freshbooks.com | **9%** of the page |
| taxjar.com | **44%** |
| geekatyourspot.com | **175%** |

FreshBooks yielded 885 characters of prose from a 9,749-character page. It is in
the corpus as a successful extraction, because the only guard is a 40-character
floor (`EXTRACT_MIN_TEXT_CHARS`, `src/crawl/reject.ts`) and it cleared that by
twentyfold.

The cause is a mismatch, not a bug. Mozilla Readability is an **article
extractor**; product, pricing, feature and solution pages are the bulk of a
`partner` or `project-site` crawl and are not articles. Every alternative in that
space — defuddle, @extractus, unfluff, article-parser — scores the DOM and
guesses which node holds the article, so swapping one for another keeps the
failure mode.

Guessing is only needed while boilerplate is present. Strip it by selector and
the content root is simply the semantic one.

## 1. Extractor replacement — DONE, uncommitted

`src/crawl/extract-content.ts`. Readability, JSDOM and Turndown all removed;
Cheerio only.

**Removal rules** (every one of them a DOM edit, before anything is emitted):

- **Navbar chrome** — a `header` that wraps a `nav` is removed whole, before the
  `nav` itself goes, or there is no nav left to recognise it by. Logo and CTA
  sitting outside the nav go with it.
- **Boilerplate** — `nav`, `footer`, `aside`, `[role=navigation|banner|contentinfo]`,
  unconditionally, every site, no page-type heuristics.
- **`header` without a nav is kept.** Sites put the H1 and lede in it; removing
  every `header` deletes the hero.
- **Images** — `img` and `picture` stripped with `svg`. Measured on freshbooks.com
  that was 24 nodes and 2,850 chars, 23% of the extract, twelve of them one
  accordion chevron. A file path is not prose and cannot be a verifiable quote.
- **Desktop twins** — matched as class *tokens* under both conventions:
  Tailwind `hidden` + `sm|md|lg|xl|2xl:(block|flex|…)`, and Bootstrap `d-none` +
  `d-(sm|md|lg|xl|xxl)-(block|flex|…)`. A substring test on `"hidden lg:"` misses
  `class="hidden min-h-screen bg-[#0B162A] lg:block"`, which is the real shape of
  the geekatyourspot hero. A **bare** `hidden` or `d-none` with no breakpoint
  override is deliberately kept: hidden at every width is also what a collapsed
  accordion panel looks like without JS.
- **Content root** — `main` → `article` → `[role="main"]` → `body`. Ordered
  preference of a **single** element, no scoring, no candidate rejection.

**Output.** Not Markdown. Markdown marks a block only by a blank line, so every
boundary survives as a whitespace convention each consumer must re-infer, and
nesting is flattened outright. The extractor walks the pruned DOM once and
returns three views of the same content:

- `contentHtml` — clean semantic fragment: `<p>`, `<h1>`–`<h6>`, `<ul>`/`<ol>`,
  `<table>`, `<blockquote>`, `<pre>`, `<dl>`. Escaped on the way out, so a page's
  own `Q&A` or `fees < 1%` cannot emit a malformed fragment.
- `blocks` — the same content typed, in document order, for the chunker.
- `text` — prose only. What a length or fidelity check must measure.

Text is attributed to exactly one block: a `<p>` inside an `<li>` belongs to the
`<p>` alone, and the content root is one element rather than a set, so nested
`<main><article>` is not collected twice. Both of those are how an extractor
silently stores every section twice.

Truncation drops whole blocks, never a byte count, so the fragment always closes
its tags. A single block larger than the entire budget has its prose cut instead
of the page returning empty.

**Measured after the change:**

| Page | Prose vs page | Duplicate prose | Syntax overhead |
|---|---|---|---|
| geekatyourspot.com | 103% | 0 | — |
| freshbooks.com | 101% | **0** chars | **7%** (629 of 8,440) |
| taxjar.com | 100% | 87 chars | 17% (700 of 4,220) |

For comparison, the same FreshBooks page through Turndown was 9,148 chars with
1,510 chars of link syntax (16.5%) and 74 duplicate chars. The duplicate-prose
figure counts blocks of 25 chars or more, so repeated short CTAs sit below it.

**Tests:** 100 unit (27 suites), 3 integration, `typecheck` and
`check:fail-closed` clean.

`cheerio` is a direct dependency. `turndown`, `@mozilla/readability`, `jsdom` and
`playwright` are removed along with their `@types`; the crawler now depends on
cheerio, crawlee and dotenv only.

## 2. Outstanding before anything is deleted

### 2a. `contentRoot` and `blocks` are computed and discarded

`contentRoot` reports which root supplied the content, so a `body`-rooted
extract — taxjar.com is one — is auditable rather than silent. `blocks` is the
typed structure that is the whole reason to emit HTML rather than Markdown.
Neither reaches storage: `cheerio-runner.ts` passes `contentHtml` and `text`
only. Plumb them to the page record and the crawl report, or drop them. A signal
nobody stores is not a signal — and a chunker that cannot read `blocks` gains
nothing from the format change.

### 2b. Fidelity check — partially built

The floor now measures **prose**, not markup: `classifyReject` takes `text`, and
persist treats a body supplied without a prose measurement as empty and rejects
it. That closes the specific hole where 2,850 chars of image markup could clear a
40-character floor with no prose in it.

What is still missing is the **band**. A floor rejects nothing at 9% fidelity,
which is why that extraction passed as a good page 101,975 times. Compare
extracted prose against the page's visible prose and reject outside a band;
rejection is already first-class (`RejectReason`), so this needs a new reason,
not a new mechanism.

**Distribution, measured.** Two ratios, across 11 live pages on four sites
(freshbooks, taxjar, n8n, geekatyourspot — home, pricing, feature and about
pages, the shapes a partner crawl is made of):

`capture` = prose kept / prose still in the DOM after pruning. Asks whether the
block walk drops text that was there.

| Page | capture |
|---|---|
| taxjar.com | 100% |
| freshbooks.com | 101% |
| geekatyourspot.com | 101% |

Clean. The 1% over is a whitespace artifact of joining blocks, not extra
content. This was 95% on taxjar until the table-cell fix.

`share` = prose kept / prose a reader sees on the page (scripts and styles
stripped from both sides — an earlier version of this measurement left inline
JSON in the denominator and reported 1% for freshbooks, which was nonsense).

| | share |
|---|---|
| min | 49% |
| p25 | 50% |
| p50 | 59% |
| p75 | 71% |
| max | 81% |

**What this supports and what it does not.** Every page in the sample is a good
extraction — capture confirms it — so the distribution establishes where *good*
pages live, 49–81%, and says nothing about where bad ones start. It contains no
negative examples.

It is still decisive about the original failure: Readability returning 9% of
freshbooks.com would have scored a share near 9%, forty points below the worst
good page here. A **floor** around 25–30% would have caught it with wide margin.

So the shape of the answer is a floor, not a band. No upper bound is needed —
the 175% on geekatyourspot was Readability duplicating content, and a walk of the
pruned DOM cannot exceed it.

Not implemented. Calibrating a rejection threshold from eleven good pages and
zero bad ones is the guess this section exists to prevent. What it needs is
negative examples, and those come from 2d: the runs whose reject counters show
they were already yielding nothing are exactly the sites that will score below
the floor.

### 2c. Residual duplication — cause identified, was mis-diagnosed

This previously read "non-Tailwind responsive patterns the token rule does not
recognise." That was **wrong**, and measuring it disproved it. freshbooks.com is
pure Tailwind — 18 desktop twins, 16 mobile twins, **zero** Bootstrap, zero
Foundation, zero inline `display:none` — and the twin rule was already working.
The 766 chars were repeated **image markup**: twelve chevron images and two CTA
links. Removing `img` at the DOM layer took FreshBooks to 0 duplicate prose
chars.

taxjar.com still shows 87 chars. Measure that page before adding any selector —
the Tailwind rule was written from evidence, the Bootstrap rule was written from
evidence, and the next one should be too.

### 2c-bis. TaxJar's last 87 duplicate chars: a bespoke `.hide`

Measured. The two repeated CTA blocks are a paired shown/hidden duplicate:

```
div.button-group.ctas_a       < div.content < div.content-row
div.button-group.ctas_b.hide  < div.content < div.content-row
```

Class **`hide`** — neither Tailwind `hidden` nor Bootstrap `d-none`, but the
site's own CSS. Not acted on: one site is not evidence, and a blanket `.hide`
rule carries the same risk as stripping bare `hidden` — it is also what a
JS-toggled panel looks like. 87 chars is not worth that trade. Revisit if more
sites show the same shape.

### 2c-ter. Local body persistence is unwired

Separate from the format change and pre-existing. `persist.ts:138` creates
`rawBodyStore` and never calls it; neither `put` nor `putContentHtml` has a
caller. Local mode records counters only — `recordAcceptedPage(runId, true)`,
with `true` hardcoded, so `pagesWithoutContent` never increments locally either.
`CrawlPageMeta.bodyKey` and `contentBodyKey` are set by nothing.

Either wire it or delete the store, the two `CrawlPageMeta` keys and the
counter argument. Until then `persistMode: local` is a progress ledger, not a
corpus, and the README said otherwise until this commit.

### 2d. Capture the seed list BEFORE deleting

Step 3 re-crawls "the runs deleted in step 2", but deleting a run destroys its
seed URLs. Capture seed URL, crawl type and per-run reject counters for all 56
runs first, to a file outside `DATA_DIR`. The reject counters identify sites that
were already yielding nothing — an SPA shell will re-crawl to zero pages again,
and that is worth knowing before spending the crawl.

### 2e. GeekAPI must accept the renamed fields

The payload is no longer Markdown, so the field names no longer say Markdown.
Until GeekAPI matches, ingest fails closed — no fallback, by design, which means
no crawl persists.

> **Correction, 2026-09-18: this prediction did not hold.** GeekAPI never took
> the rename, and ingest failed *open* rather than closed. Acceptance requires
> `Html` **or** `Markdown` and the crawler still sends `html`, so pages
> validated and persisted while `contentHtml`, `blocks` and `contentReadyAt`
> were silently discarded by model binding. 5,274 pages were stored, reported
> as saved, then deleted by the Library as `no_markdown`. The safety property
> assumed here is the reason nobody looked. See
> `plans/retire-markdown-from-rag.md`. **Resolved in `GeekBackend@5561209`**,
> which carries the fields through all four hops and makes the external ingest
> route fail closed when a page arrives without extracted content.

| Here | Was |
|---|---|
| `contentHtml` | `markdown` (page body) |
| `contentReadyAt` / `clearContentReadyAt` | `markdownReadyAt` / `clearMarkdownReadyAt` |
| `EXTRACT_MIN_TEXT_CHARS` | `EXTRACT_MIN_MARKDOWN_CHARS` (env) |
| `contentLength` | `markdownLength` (dedup ledger, on disk) |
| `bodies/<hash>.content.html` | `bodies/<hash>.md` (local) |

The ledger rename means an existing dedup ledger will not rehydrate its lengths.
That is moot here: the corpus is being deleted anyway.

Content hash and simhash now run over prose rather than over the body. Hashing
the fragment would simhash tag soup — the tags are identical on every page of a
site, so they swamp the signal they are supposed to carry.

## 3. Delete all crawl data

Only after 2a–2e. The corpus is being replaced, not repaired.

| Target | How |
|---|---|
| Pages, links, run documents | `DELETE /api/geek-crawler/ingest/runs/{id}` per run |
| Qdrant vectors | same call — vectors go before the content they cite |
| `rag_index_jobs` rows | same call (fixed in `350b8f0`) |
| `DATA_DIR/runs/`, `DATA_DIR/.crawlee/` | `rm -rf`, only after the authority purge succeeds |

One attempt per run, no retries, authority before local scratch.

**Verification:** `crawl_runs`, `crawl_pages`, `crawl_links`, `rag_index_jobs`
all 0; Qdrant crawler collection empty; both local directories empty.

**Accepted consequence:** zero corpus until the re-crawl completes.

## 4. Re-crawl

From the seed list captured in 2d. `partner` and `project-site` first — the
corpus RAG grounds on. One site first, checked against the fidelity band, before
the rest of the list runs.

## 5. Stale documentation — README done

`README.md` is corrected: CheerioCrawler only, no Playwright backup path, no
Readability or Turndown credit, `contentHtml` and `ContentReadyAt` in the persist
path, `.content.html` local bodies, and the dead
`plans/rag-markdown-backfill.md` link removed. `npx playwright install chromium`
moved into the `web/` step, where the only Playwright left in the tree lives.

Also corrected in code: `src/crawl/viability.ts` no longer claims it promotes
shells to PlaywrightCrawler (it feeds `extract_empty` rejection),
`src/storage/runs.ts` no longer carries an unreachable `'playwright'` member in
its `fetchMode` union, and `src/bot/identity.ts` no longer refers to a Phase 1
browser.

`.cursor/rules/no-retries-no-fallbacks.mdc:19` was already right and needs no
change. One fixture sentence in `tests/fixtures/site.ts` still says "markdown";
cosmetic.

## Renderer: CheerioCrawler, settled

No JavaScript execution. Static HTML, one renderer, one path.

Accepted: content that does not exist until JS runs is not crawled. On
geekatyourspot.com that is the animated hero word — 4 of 8 animated spans are
empty in the HTML the crawler receives. Fixing that is server-rendering it at the
source, not adding a browser here.

Consequences: `aria-hidden` elements are **not** stripped (without JS that ghost
is the only place the headline text exists), and a detected SPA shell stays a
rejected page rather than being promoted.

A shell is also not a frontier. Its links are not enqueued, because following
them spends the whole crawl budget on pages that will each be rejected in turn.
And it is reported as `requires_javascript` under `excludedByPolicy` rather than
as a failed extraction: needing a browser this crawler deliberately does not have
is a fact about scope, not a fault. Only the `empty_or_spa_shell` signal maps
there — `insufficient_text` and `body_too_small` are thin or truncated pages,
which is a different fact and keeps `extract_empty`.

## Known consequence of the HTML output

Inline links keep their label and lose their target: `[Buy Now & Save](/pricing)`
is now `<p>Buy Now &amp; Save</p>`. That is most of the overhead saving, and the
page's own URL is still stored, but a link's destination inside the prose is not
recoverable from the body. Reversible — emit `<a href>` — if a citation ever
needs it.
