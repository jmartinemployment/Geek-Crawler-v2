# Audit — GeekOAuth

**Role:** the OIDC provider content-creator-v2 authenticates against. 76 `.cs` files under `src`.
**Audited:** 2026-09-28 — **lightest pass of the five.**

---

## Scope warning, read this first

This repo received a **connectivity and configuration** pass, not a security review. I confirmed
how it relates to Content Creator v2 and looked for the failure class this audit targets. I did
**not** review token lifetimes, signing key handling, PKCE enforcement, redirect-URI validation
strictness, scope escalation, session fixation, or any other authentication-specific concern.

**An identity provider deserves a dedicated security review by someone treating it as the subject,
not the fifth item on a list.** Do not read "2 findings" as "this repo is in good shape" — read it
as "this repo was not examined for the things that matter most in it."

---

## F1 — Client registration is seeded in code across three hosts — **low, verify intent**

**Evidence** — `src/GeekOAuth.Server/Infrastructure/OidcPublicClientSeeds.cs`

- `:213` — `const string clientId = "geek-content-creator"`
- `:216` — redirect `https://geek-content-creator.geekatyourspot.com/auth/callback`
- `:217` — redirect `https://geek-content-creator.vercel.app/auth/callback`
- `:16` — *"Granted to geek-content-creator-v2 only. GeekAPI requires it on every project route"*
- `:20` — `const string ContentCreatorManageScope = "content-creator.manage"`
- `:30` — `await SeedContentWriterV3Client(appManager, ct)`

Two observations, neither confirmed as a problem:

1. The client id is `geek-content-creator` while the comment describes the grant as
   *"geek-content-creator-v2 only"*. Given that a **retired** repo named `GeekContentCreator` still
   exists on this machine, an id without the `-v2` suffix is at minimum ambiguous. Worth confirming
   the id maps to the live frontend and that the retired app cannot still authenticate.
2. A `vercel.app` redirect sits alongside the production host. Legitimate for preview deployments;
   worth confirming it is intended to be registered in the same environment as production, since
   preview URLs are widely accessible.

**Fix** — confirm both, then record the answer in the seed file's comments. If the retired app can
still obtain tokens, revoke its registration.

---

## F2 — Seeded configuration has the same enforcement gap as the rest of the pipeline — **low**

Client ids, redirect URIs and scopes are constants in a seeder. GeekAPI independently requires
`content-creator.manage` on project routes; content-creator-v2 independently requests scopes.

That is a **third** instance of the pattern this audit keeps finding: values that must agree across
repos, agreeing only because someone maintains them by hand. The ingest-limits mirror (index C4)
had the same shape and drifted until a crawl died.

Lower severity here only because scope mismatches fail loudly at sign-in rather than silently
returning empty data.

**Fix** — no code change proposed. When the ingest-limits contract test (index C4) is built,
consider whether the same technique covers scope names: one side publishes, the other asserts.

---

## Plan

| # | action | effort |
|---|---|---|
| 1 | **Commission a real security review of this repo** | — |
| 2 | Confirm `geek-content-creator` maps to the live app; revoke the retired one if registered | small |
| 3 | Confirm the `vercel.app` redirect is intended in this environment | minutes |
| 4 | Fold scope names into the cross-repo contract test, if it is built | small |

Item 1 is the real recommendation. Items 2-4 are what a non-security pass can honestly offer.
