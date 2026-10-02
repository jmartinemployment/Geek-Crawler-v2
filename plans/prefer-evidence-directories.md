# Preferring the directories the extraction schema reads

## The ask

Partner extraction fills 22 payload categories, each needing a verbatim quote from a retrieved page.
A tool page is refused unless 3 of 22 are populated plus a capability signal. Observed refusal:
`26 page(s) extracted cleanly; 1 of 22 payload categories populated (need at least 3)`.

Can the crawler be told to prefer the directories those categories live on?

## Yes, and the mechanism already exists

`classify-path.ts` tiers every URL `product` / `other` / `editorial`; `TIER_ORDER` sorts them 0/1/2
and `sectionAdmissionOrder` crawls in that order. Preference is a vocabulary question, not new
machinery.

Measured 2026-10-02, where each category's home directory lands today:

| tier | categories whose home directory has it |
|---|---|
| `product` | featureInventory, pricingCatalog, integrations, comparisons, alternatives, useCasePlaybooks |
| `editorial` | caseStudies (`/customers`, `/case-studies`), faqBank (`/faq`), awards (`/press`) |
| `other` | testimonials, icp, technicalConstraints, freshnessLog, battlecardSlices, demoBeats, complianceSnippets |

Only 6 of 21 sit in the tier that gets crawled first. Three are `editorial`, which is worse than
last — they compete for the `EDITORIAL_SHARE` 20% budget against blog posts. Seven are `other`.

**Correction, measured 2026-10-02 after this was first written.** The ordering argument was weaker
than stated here. It assumed the 2,500-page cap runs out before the `other` tier is reached. It does
not: across 47 runs, **zero** hit the cap. The largest is ramp.com at 2,010 (80%), the next stripe.com
at 1,750, and the median crawl is 176 pages — 7% of the budget. Crawls end because they run out of
in-scope links or because quotas and the share gate suppress enqueues, not because the budget is
spent. On a 176-page crawl every in-scope page is fetched whatever the tier order, so TIER_ORDER
decides sequence, not inclusion.

What survives the correction is the `editorial` placement, which is an *exclusion* rather than an
ordering: `/customers`, `/case-studies` and `/faq` are suppressed by the 20% share on a crawl of any
size. That is the piece costing categories, and item 3 below is the whole of it. The reordering in
items 1, 2 and 4 is cheap and harmless but should not be expected to change what gets crawled until
a site is large enough to exhaust 2,500 — ramp.com is the only one that has come close, and 54% of
its 2,010 pages were a generated page farm.

## But the yield is small, and this is the part that matters

Tier distribution across the five partners (881 pages, 2026-10-02):

```
partner            pages  product  evidence  editorial   other
dext.com             181       41        10         49      81
melio.com             88        6         5         15      62
bill.com             183       72        14         17      80
avidxchange.com      198      109        17          9      63
stampli.com          231        2        29         20     180
TOTAL                881      230        75        110     466
share                        26%        9%        12%     53%
```

**53% of pages match no vocabulary at all**, and a new evidence tier would reorder 9%.

The unclassified pages are not junk. They are the product pages, under names no vocabulary reaches:

* **Flat structure.** stampli serves `/advanced-vendor-management/`, `/accounts-payable/`,
  `/advanced-search/` directly at the root. No `/features/` or `/product/` parent exists, which is
  why a 231-page site scores 2 product pages.
* **Compound segments.** dext has `/smb-testimonials/` — the testimonials category's home directory,
  invisible because of the `smb-` prefix.

No vocabulary extension classifies `/advanced-vendor-management/`. URL shape is simply not a reliable
signal of page purpose on these sites, and widening the patterns to catch them would catch everything
else too.

## Blogs are not the problem

Asked directly, and the answer is no. Editorial is **12%** of the partner set — the `EDITORIAL_SHARE`
0.2 cap is already holding, and it was added when crawls ran 72–76% editorial. Deprioritising blogs
further gains nothing here: the competition for budget is the 53% unclassified bucket, not blog posts.

Blogs also carry the one category that lives *anywhere* — `citables`, an isolated factual claim plus
its quote. Pushing them below `other` would cost that for no measured gain.

## What actually causes the refusal

Not crawl order. `GccGenerateService` hands extraction
`GccResearchFetchService.Deserialize(create.ResearchJson)?.Quoteables` — a retrieval result, not the
partner's crawl. Its own comment says several partners' pages land in one create's research until
per-partner pages ship. 26 quoteables split across five partners is ~5 pages each, and five pages
cannot populate three categories.

The corpus is not short: avidxchange has 73 integration pages, bill.com 55 feature pages and 8
comparisons, dext 5 pricing and 13 integration pages. 881 pages and 11,355 quotable paragraphs across
the five. None of it reaches extraction.

**So the high-yield fix is `content-creator-v2/plans/tool-page-per-partner.md`, not this plan.**

## If this is done anyway

Worth doing on its own merits, as a cheap reordering that helps sites with conventional structure
(avidxchange: 109 product + 17 evidence of 198) and is neutral elsewhere.

1. Add an `evidence` tier to `PageTier` and `TIER_ORDER` at weight 1, pushing `other` to 2 and
   `editorial` to 3.
2. Move to it, as whole-segment patterns: `customers`, `case-stud(y|ies)`, `success-stories`,
   `testimonials`, `faq`, `security`, `trust`, `compliance`, `changelog`, `release-notes`,
   `whats-new`, `demo`, `product-tour`, `docs`, `limits`, `press`, `awards`.
3. **Exempt `evidence` from `EDITORIAL_SHARE`.** This is the half that matters: `/customers` and
   `/faq` currently ration against blog posts for one 20% budget, and caseStudies and faqBank are two
   of the three categories a tool page needs.
4. Allow a leading qualifier on those segments the way `blog` already does
   (`^(?:[a-z0-9]+-)?testimonials$` catches `smb-testimonials`).

Do not widen beyond whole segments. `/blog/how-to-build-a-sitemap` and `sitemapping-guide` are the
standing reminder that a prefix match deletes articles.

## Verification

Re-run the tier distribution above and require `evidence` to rise on avidxchange and bill.com without
`product` falling. Then re-crawl one partner and check the populated-category count moves off 1 —
though per the section above, expect that number to stay low until extraction is given the partner's
own pages.
