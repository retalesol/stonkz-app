import { expect, test } from '@playwright/test';

/**
 * Phase 1.D live-mode journeys (plan steps 62-70).
 *
 * Everything in `journeys.spec.ts` runs against `api/sim.ts` and stays
 * meaningful after the live swap, which is the point of that file. This file
 * instead asserts the one thing sim mode cannot: that the board, the token
 * page and a net switch are backed by the real API and WS, not `COINS`'
 * hardcoded seed. `net switch changes the visible board set` in particular
 * has no sim equivalent — the sim's `RAW` coins carry no `net` at all.
 *
 * Not part of the default `pnpm test:e2e` run: there is no Postgres/Redis/
 * API/indexer to spin up inside that harness, so every test here is skipped
 * unless `LIVE_E2E=1` is set. To run for real:
 *
 *   docker compose up -d postgres redis   # or point DATABASE_URL/REDIS_URL elsewhere
 *   pnpm --filter @stonkz/api migrate
 *   DATABASE_URL=postgres://stonkz:stonkz@localhost:5432/stonkz \
 *     REDIS_URL=redis://localhost:6379 pnpm --filter @stonkz/api start &
 *   DATABASE_URL=postgres://stonkz:stonkz@localhost:5432/stonkz \
 *     REDIS_URL=redis://localhost:6379 pnpm --filter @stonkz/indexer start &
 *   VITE_API_MODE=live VITE_API_URL=http://localhost:8787 VITE_WS_URL=ws://localhost:8787 \
 *     pnpm --filter @stonkz/web dev &
 *   LIVE_E2E=1 PW_BASE_URL=http://127.0.0.1:5173 pnpm test:e2e e2e/live.spec.ts
 *
 * The fixture scenario (`apps/indexer/src/fixtures/producer.ts`) is small —
 * a couple of tokens per net — so these assert shape and wiring, not scale.
 */

test.skip(
  process.env['LIVE_E2E'] !== '1',
  "live-mode journeys need LIVE_E2E=1 and a running live-mode stack — see this file's header",
);

test.describe.configure({ mode: 'serial' });

// Two local-only-testing wrinkles, neither of which is a production concern:
//
// 1. `index.html`'s CSP is `connect-src 'self' ws: wss: https:` — right for a
//    real deployment (`VITE_API_URL` is `https://api.ston.kz`), but this
//    harness's API runs over plain `http://localhost` with no cert to give
//    it. Patch the meta tag on the served document only.
// 2. Chrome's Private/Local Network Access checks treat `127.0.0.1:5173`
//    fetching `localhost:8787` as a cross-address-space request and block it
//    without a permission prompt Playwright cannot answer. Disabling the
//    feature flags is the documented workaround for automated testing.
test.use({
  launchOptions: {
    args: [
      '--disable-features=PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessForWorkers',
    ],
  },
});

test.beforeEach(async ({ page }) => {
  await page.route('**/*', async (route) => {
    const req = route.request();
    if (req.resourceType() !== 'document') return route.continue();
    const res = await route.fetch();
    const body = await res.text();
    const patched = body.replace(
      /<meta http-equiv="Content-Security-Policy"[^>]*>/,
      "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src *; base-uri 'self'; form-action 'self'; object-src 'none'\">",
    );
    await route.fulfill({ response: res, body: patched });
  });

  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-booted', 'true');
});

test('land on the board and see real fixture coins with no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-booted', 'true');
  await expect(page.locator('.coin').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('opening a shareable /t/:sym URL cold loads real candles, trades and holders', async ({
  page,
}) => {
  const card = page.locator('.coin').first();
  const sym = (await card.getAttribute('data-sym')) as string;

  // A fresh navigation, not a client-side route change: this is what a
  // pasted link actually does.
  await page.goto(`/t/${sym}`);
  await expect(page.locator('#tokenView')).toBeVisible();
  await expect(page.locator('.tk-id h1')).toContainText(sym);
  await expect(page.locator('#tabbody')).toBeVisible();

  await page.click('[data-tab="holders"]');
  await expect(page.locator('#tabbody tr').first()).toBeVisible();
});

test('back returns to the board from a live token page', async ({ page }) => {
  const card = page.locator('.coin').first();
  const sym = (await card.getAttribute('data-sym')) as string;
  await card.click();
  await expect(page).toHaveURL(new RegExp(`/t/${sym}$`));

  await page.click('#tk-back');
  await expect(page.locator('#boardView')).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test('the tape opens a token on click', async ({ page }) => {
  const print = page.locator('#tape .tx').last();
  await expect(print).toBeVisible({ timeout: 10_000 });
  const sym = (await print.getAttribute('data-sym')) as string;
  // Hovering (part of Playwright's default click sequence) pins a frozen
  // clone on top of the original print, which then never un-pins on a live
  // (mostly static) tape — Playwright's actionability check sees that clone
  // covering the target and refuses to click through it. `force: true` is
  // safe here: clone and original carry the same `data-sym` and both sit
  // under the tape's one delegated click listener.
  await print.click({ force: true });
  await expect(page.locator('#tokenView')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/t/${sym}$`));
});

test('sort chips reorder the live board', async ({ page }) => {
  await page.click('.filters .chip[data-sort="mc"]');
  await expect(page.locator('.filters .chip[data-sort="mc"]')).toHaveClass(/on/);
  await expect(page.locator('.coin').first()).toBeVisible();
});

test('the KOTH crown opens its coin on click', async ({ page }) => {
  const koth = page.locator('#koth');
  const sym = (await koth.getAttribute('data-sym')) as string;
  await koth.click();
  await expect(page.locator('#tokenView')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/t/${sym}$`));
});

test('a net switch reloads the board from the other chain', async ({ page }) => {
  const solSyms = await page
    .locator('.coin')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-sym')));
  expect(solSyms.length).toBeGreaterThan(0);

  await page.click('#connectBtn');
  await page.click('[data-net="RH"]');
  await expect(page.locator('#wchip')).toBeVisible();
  await expect(page.locator('#wNetName')).toHaveText('ROBINHOOD');

  // `GET /tokens?net=RH` replaced `COINS` — a different set than SOL's, not
  // just a relabelled copy of the same one.
  await expect(page.locator('.coin').first()).toBeVisible();
  const rhSyms = await page
    .locator('.coin')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-sym')));
  expect(rhSyms.length).toBeGreaterThan(0);
  expect(rhSyms).not.toEqual(solSyms);
  for (const sym of rhSyms) expect(solSyms).not.toContain(sym);
});
