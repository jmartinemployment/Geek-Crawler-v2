# Audit — content-creator-v2

**Role:** the live operator frontend. Next.js, 61 `.ts`/`.tsx` files under `src`.
**Audited:** 2026-09-28, working tree. This is the live repo; `GeekContentCreator` (no hyphens) is
the retired one and was not audited.

---

## F1 — A second HTML renderer lives in the frontend — **high**

**Evidence** — `src/services/gcc-api.ts`

- `:537` `function escHtml(s: string): string`
- `:599` `function docToHtml(doc: WireDocument): string`
- `:628` and `:650` — `rows.push(\`<h2>${escHtml(p.title)}</h2>\`)`
- `:646` — `rows.push(\`<p><strong>${escHtml(label)}:</strong> ${escHtml(v)}</p>\`)`

CLAUDE.md §1b is explicit that `SectionHtmlRenderer` is *"The only place tag characters are
produced in the whole pipeline"*, that it builds a DOM node-by-node **rather than concatenating
strings**, and that a second solution which outputs HTML is itself the defect.

This is a second solution that outputs HTML, and it does it by string concatenation — the exact
technique the rule rejects, because balance and nesting stop being structural guarantees and
become the author's problem.

**The mitigating context, stated fairly.** CLAUDE.md already records a "known deviation": the
Create path still returns string bodies (`GccController.cs:667, :674`), so the single-renderer rule
holds on the orchestrator path only. `docToHtml` may exist precisely because the server does not
always hand back rendered HTML. That makes it a **symptom** of the server-side deviation rather
than an independent decision — which changes the fix, not the finding.

**Fix**

1. Establish which is true: does the server return a rendered fragment for every artifact type the
   frontend renders, or only some? That determines whether `docToHtml` is redundant or load-bearing.
2. If redundant — delete it and render the server's fragment.
3. If load-bearing — the gap is server-side. Close `GccController.cs:667/:674` so every path returns
   `SectionHtmlRenderer` output, then delete `docToHtml`.
4. Until one of those lands, CLAUDE.md §1b should say the frontend also produces markup. Right now
   it names one renderer and there are two, which is the documentation defect this audit keeps
   finding.

---

## F2 — The frontend cannot see crawl corpus, by construction — **medium (design question)**

**Evidence.** Every `crawlType` reference in `src` is crawl *management*:

- `gcc-api.ts:764` `startGeekCrawl(crawlType, seeds)` — POST a new crawl
- `gcc-api.ts:791` `listGeekCrawls(crawlType?)` — filter the runs list

Zero hits for `partnerRunId`, `competitorRunId`, `createLibraryDraft`. Endpoints actually called:
`/api/geek-content-creator/creates`, `/project-site/readiness`, `/serp/parse`, `/tools/generate`,
`/api/geek-crawler/crawls`, `/api/rag/hosts-indexed`.

So corpus selection happens entirely server-side, via
`GetLatestRunAsync(ownerUserId, crawlType, seedsJson, ct)`. The operator launching a crawl has no
way to see, choose, or confirm which run grounds a given create.

**Why this is a finding rather than a preference.** It is the reason the pipeline's largest
problem was invisible. If generation reads an empty store (GeekBackend F1), the frontend shows a
normal draft. Nothing in the UI distinguishes grounded from ungrounded output. The operator cannot
detect the failure because the interface does not carry the fact.

**Fix**

1. Surface the resolved run on the create: run id, crawl type, seed, page count, crawl date.
2. Show explicitly when a create resolved **no** run. That single affordance would have surfaced
   GeekBackend F1 and F2 without a five-hop source trace.
3. Longer term, consider whether the operator should choose the run rather than receive "latest".
   `CreateLibraryDraftRequest` already accepts `PartnerRunIds` / `CompetitorRunIds` — the server
   supports it; the frontend never sends it.

---

## F3 — Test coverage is thin for the repo's role — **medium**

3 `.test.ts` files against 61 source files. The tested area is SERP lens / brief catalog logic.
`gcc-api.ts` — which holds the HTTP surface, the wire-format parsing **and** `docToHtml` — has no
direct test.

Given F1 puts markup generation in this file, the untested part is the part producing HTML.

**Fix** — test `docToHtml` against each `WireDocument` shape it claims to handle, including the
fall-through at `:655` (`p.body` pushed raw with the comment *"may already be HTML"*, which is an
unverified assumption about server output). Do this before any refactor of F1, so the refactor has
a baseline.

---

## F4 — Silent catches around parsing — **low**

30 bare `catch {` blocks. Most are defensible and carry a comment explaining the recovery —
`CreateDraftWorkspace.tsx:258` *"the draft is still readable without a score"*,
`:1300` *"a body that will not parse still renders below"*.

Two are not:

- `gcc-api.ts:620` — `JSON.parse` failure returns `null`, and the caller renders nothing. A draft
  whose body will not parse is indistinguishable from a draft with no body.
- `CreateDraftWorkspace.tsx:1226` — `catch { return null; }`, no comment.

**Fix** — for these two, surface the parse failure in the UI rather than rendering emptiness. The
project's silent-failure model is about not throwing; it is not about hiding from the operator that
something failed to load.

**Not a finding:** the 31 `TODO`/`FIXME` grep hits are false positives — `"todo"` is a task-status
domain value (`GccTaskStatus = "todo" | "in_progress" | "done"`). No placeholder comments found.

**Not a finding:** the sole "markdown" hit,
`CreateDraftWorkspace.tsx:1161-1162`, is a comment recording that v1's Markdown rendering was
deliberately not carried over. Compliant.

---

## Plan

| # | action | effort | depends on |
|---|---|---|---|
| 1 | Surface the resolved crawl run (or its absence) on a create | small | — |
| 2 | Test `docToHtml` against every shape it handles | small | — |
| 3 | Determine whether the server returns rendered HTML on all paths | small | — |
| 4 | Delete `docToHtml`, or close the server gap then delete it | medium | 2, 3 |
| 5 | Surface parse failures instead of rendering empty | small | — |
| 6 | Correct CLAUDE.md §1b while two renderers exist | minutes | — |

Item 1 is the highest value in this repo and independent of everything else: it makes the
pipeline's grounding visible to the person who can act on it.
