# Geek-Crawler v2 — product plan (summary)

**Hard boundary:** Implement only in this repo. Do **not** change Geek-Crawler v1, GeekBackend Playwright crawler, or sibling apps so v1 keeps working.

Full phased design lives in the Cursor plan `Crawlee Cheerio v2`. Delivery:

| Phase | Working outcome |
|-------|-----------------|
| 1 | CLI Cheerio crawl + raw filesystem sink |
| 2 | Mobile Client Hints, robots, adaptive throttle |
| 3 | Viability → Playwright pool, unified `fetchMode` sink |
| 4 | HTTP API + `EGRESS_MODE=proxy` / ngrok |
| 5 | Railway Option B Tailscale home exit node |

Bot: `geekatyourspotbot` / `jeffm@geekatyourspot.com` / `https://geekatyourspot.com`
