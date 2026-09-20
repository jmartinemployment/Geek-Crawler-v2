# Geek-Crawler v2 operator UI

Localhost Next.js App Router UI. See root [README.md](../README.md).

Two upstreams, and they are not interchangeable. **Reads are GeekAPI's** — runs, pages, page URLs,
links, index status — reached through the `app/api/crawls/*` route handlers, which exist only to
keep `GEEK_API_URL` and the access token out of the browser. **Control is the crawler's private
`serve` API** on `127.0.0.1:8787`, called over loopback because this UI is co-located with the crawl
box. No other product may call that API. See **API surface** in the root README.

```bash
cp .env.example .env.local   # GEEK_* + NEXT_PUBLIC_APP_URL / AUTH_URL / OAUTH_CLIENT_ID
npm run dev                  # http://localhost:3000
```

Or from repo root: `npm run web:dev`.

## Live status (SignalR) is optional

Crawls, reports, and CSV export work fully without signing in. Only the
**live progress panel** on the run page needs a token.

`/api/auth/hub-token` mints that token from one of two sources, in order:

1. **Session cookies** — visit **Sign in** in the nav (or `/api/auth/start`).
   Sets access + refresh cookies; the access token then renews silently until
   the *refresh* token dies, at which point both cookies are cleared and you
   must sign in again.
2. **`GEEK_USER_ACCESS_TOKEN`** (or `GEEK_ACCESS_TOKEN`) in `web/.env.local` —
   a local-dev bypass so no login is needed. Not in `.env.example`; it is a
   JWT, so it expires and must be replaced.

With neither, the route returns **401** and the run page shows
`Live updates off — no hub token`. That is expected and harmless — the crawl
is unaffected and progress is still visible on refresh.

The client probes the endpoint **once** and skips SignalR entirely when it
401s, rather than opening a connection that cannot authenticate. A 401 is
terminal, not transient; retrying it previously produced a console full of
stack traces (fixed in `26db07e`).

GeekAPI's hub is `[Authorize]` and only `JwtBearer` is registered, so
`GEEK_BACKEND_API_KEY` **cannot** authenticate the hub — a user JWT is the
only accepted credential.
