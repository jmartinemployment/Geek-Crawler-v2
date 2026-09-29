import { expect, test } from '@playwright/test';

test('submit validates input, surfaces backend errors, and opens a live run', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Start crawl' }).click();
  const seed = page.getByLabel('Seed URL (one URL = one run)');
  await expect(seed).toBeFocused();
  expect(await seed.evaluate((input: HTMLInputElement) => input.validity.valueMissing)).toBe(true);

  await seed.fill('http://backend-error.test');
  await page.getByRole('button', { name: 'Start crawl' }).click();
  await expect(page.getByText('422: deterministic backend rejection')).toBeVisible();

  await seed.fill('http://127.0.0.1:8899/fixture/article');
  await page.getByLabel('Crawl type').selectOption('local');
  await page.getByRole('button', { name: 'Start crawl' }).click();
  await expect(page).toHaveURL(/\/runs\/run-123$/);
  await expect(page.getByRole('heading', { name: 'Run run-123' })).toBeVisible();
  await expect(page.locator('section').filter({ hasText: 'Status' }).locator('pre')).toContainText(
    '"source": "geekapi"',
  );
  await expect(page.getByRole('cell', { name: /fixture\/article/ })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Run run-123' })).toBeVisible();
  await expect(page.locator('section').filter({ hasText: 'Status' }).locator('pre')).toContainText(
    '"status": "complete"',
  );
});

test('completed report paginates URL rows and downloads both CSV exports', async ({ page }) => {
  await page.goto('/runs/run-123');
  await expect(page.getByRole('heading', { name: 'URLs (100 loaded)' })).toBeVisible();

  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(page.getByRole('heading', { name: 'URLs (101 loaded)' })).toBeVisible();
  await expect(page.getByRole('cell', { name: /page-101$/ })).toBeVisible();

  const urlDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download URL CSV' }).click();
  expect((await urlDownload).suggestedFilename()).toBe('crawl-run-123-urls.csv');

  const reportDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download report CSV' }).click();
  expect((await reportDownload).suggestedFilename()).toBe('crawl-run-123-report.csv');
});

test('resume-all reports mixed outcomes and resume-by-URL redirects', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Resume all running' }).click();
  await expect(page.getByText('Resumed 1, skipped 1, failed 1 (of 3 running stubs).')).toBeVisible();
  await expect(page.getByText(/skipped[\s\S]*already in flight/)).toBeVisible();
  await expect(page.getByText(/failed[\s\S]*missing queue/)).toBeVisible();

  await page.getByLabel('Seed URL to resume').fill('http://127.0.0.1:8899/fixture/article');
  await page.getByRole('button', { name: 'Resume by URL' }).click();
  await expect(page).toHaveURL(/\/runs\/run-123$/);
});

/**
 * The local crawler snapshot is not a substitute for the authoritative one.
 * This test asserted the opposite until 2026-09-29, and had failed on every CI
 * run since the fallback was deleted in d1a2df3: the route is GeekAPI only, by
 * design, so an unavailable upstream must be reported rather than papered over
 * with whatever the local stub happens to hold.
 */
test('run detail reports the upstream failure and substitutes nothing when GeekAPI is unavailable', async ({
  page,
}) => {
  await page.goto('/runs/local-run');

  const status = page.locator('section').filter({ hasText: 'Status' }).locator('pre');
  await expect(status).toContainText('No run snapshot loaded.');
  // No source key at all: neither the GeekAPI snapshot nor a local stand-in.
  await expect(status).not.toContainText('"source"');

  // The operator is told what failed, which upstream status caused it, and the
  // correlation id that finds the same request in the server log.
  const failure = page.getByText(/UPSTREAM_UNAVAILABLE/);
  await expect(failure).toBeVisible();
  await expect(failure).toContainText('upstream 503');
  await expect(failure).toContainText(/correlation [0-9a-f-]{36}/);

  // The URL table stays empty rather than showing the local crawler's pages.
  await expect(page.getByRole('cell', { name: /fixture\/local/ })).toHaveCount(0);
});
