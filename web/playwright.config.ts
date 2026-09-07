import { defineConfig, devices } from '@playwright/test';

const servicePort = 8899;
const appPort = 3100;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${appPort}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: `E2E_SERVICE_PORT=${servicePort} node e2e/fake-services.mjs`,
      url: `http://127.0.0.1:${servicePort}/crawls`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: `CRAWLEE_API_URL=http://127.0.0.1:${servicePort} GEEK_API_URL=http://127.0.0.1:${servicePort} NEXT_PUBLIC_GEEK_API_URL=http://127.0.0.1:${servicePort} NEXT_PUBLIC_GEEK_CRAWLER_HUB_URL=http://127.0.0.1:${servicePort}/hubs/geek-crawler-realtime GEEK_BACKEND_API_KEY=e2e-key GEEK_USER_ID=e2e-user npx next dev --turbopack -p ${appPort}`,
      url: `http://localhost:${appPort}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
  outputDir: 'test-results',
});
