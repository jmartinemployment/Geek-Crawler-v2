# Apply GeekBackend markdown fields + backfill API

This agent cannot push to `GeekBackend` (403). Apply locally:

```bash
cd /path/to/GeekBackend
git checkout -b cursor/markdown-page-fields-b950
git am /path/to/Geek-Crawler-v2/plans/backend-markdown-backfill/0001-*.patch
git push -u origin HEAD
```

After deploy: restart GeekAPI + GeekRepository so ingest stores Title/Markdown and
`POST /api/geek-crawler/ingest/runs/{runId}/pages/markdown-backfill` is live.
