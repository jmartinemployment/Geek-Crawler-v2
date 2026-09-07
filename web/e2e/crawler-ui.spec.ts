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

test('run detail falls back to the local crawler snapshot when GeekAPI is unavailable', async ({
  page,
}) => {
  await page.goto('/runs/local-run');
  await expect(page.locator('section').filter({ hasText: 'Status' }).locator('pre')).toContainText(
    '"source": "crawlee"',
  );
  await expect(page.getByRole('cell', { name: /fixture\/local/ })).toBeVisible();
  await expect(page.getByText(/GeekAPI unavailable|503/)).toBeVisible();
});
