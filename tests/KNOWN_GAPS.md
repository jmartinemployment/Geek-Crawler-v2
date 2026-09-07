# Known E2E gaps

## Crawl cancellation

`POST /crawls/:runId/cancel` currently records an in-memory cancellation request, but
the Cheerio and Playwright runners do not observe that flag. An active crawl therefore
continues and ultimately persists `complete` or `failed`, rather than `cancelled`.

The integration suite records the intended behavior with a non-failing `test.todo`.
Turn that case into a normal test when cancellation is wired to Crawlee abort/teardown
and the local/GeekAPI run stores persist the `cancelled` transition.
