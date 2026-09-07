import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const isCI = !!process.env['CI'];

/** Point the harness at an already-running server, e.g. the Vite dev server. */
const externalBaseURL = process.env['PW_BASE_URL'];
const baseURL = externalBaseURL ?? `http://127.0.0.1:${PORT}`;

/**
 * Harness only. Phase 0.E owns the real sim journeys
 * (land -> wizard, connect, buy/sell, crate cooldown, Escape stack).
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  ...(isCI ? { workers: 1 } : {}),
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  ...(externalBaseURL
    ? {}
    : {
        webServer: {
          command: `pnpm --filter @stonkz/web preview --port ${PORT} --strictPort`,
          url: baseURL,
          reuseExistingServer: !isCI,
          timeout: 120_000,
        },
      }),
});
