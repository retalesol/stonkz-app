import { expect, test } from '@playwright/test';
import { acceptConfirmDialogs } from './accept-dialogs.js';
import { installMockWallets, walletRecord } from './mock-wallets.js';

/**
 * Phase B — real wallet integration, driven through mock wallets that
 * implement the real standards (`e2e/mock-wallets.ts` explains why that is
 * the only honest way to test this in CI).
 *
 * The suite has two halves, and the split matters:
 *
 * - **This file** runs in `pnpm test:e2e` against the sim-mode preview
 *   build. It asserts the *negative* security properties of a default build:
 *   practice mode cannot be active, its badge is not shown, and sim mode does
 *   not quietly reach for a real wallet that happens to be installed. Those
 *   are the assertions worth having in every CI run, because they are the
 *   ones that would let a fake signer ship.
 * - **The live half**, `e2e/wallet-live.spec.ts`, is gated on `LIVE_E2E=1`
 *   for the same reason `live.spec.ts` is: the wallet picker only opens in a
 *   live-mode build (`app/wallet.ts`'s `connectWallet`), which needs an API
 *   to sign in against. See `live.spec.ts`'s header for the stack.
 */

test.describe('a default build cannot be practice mode', () => {
  test.beforeEach(async ({ page }) => {
    // A real Solana wallet and a real Robinhood wallet are both "installed"
    // for these, which is the interesting case: the app must not use them.
    acceptConfirmDialogs(page);
    await installMockWallets(page);
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-booted', 'true');
  });

  test('the practice badge is absent before and after connecting', async ({ page }) => {
    const badge = page.locator('#practiceBadge');
    await expect(badge).toBeHidden();

    await page.click('#connectBtn');
    await page.click('[data-net="SOL"]');
    await expect(page.locator('#wchip')).toBeVisible();

    // `VITE_PRACTICE_WALLET` is unset in this build, so `wallet/practice.ts`
    // refuses to construct and `isPracticeSession()` can never be true —
    // there is no sequence of clicks that lights this strip.
    await expect(badge).toBeHidden();
    await expect(page.locator('.mm-bubble', { hasText: 'PRACTICE KEY' })).toBeHidden();
  });

  test('sim mode never prompts an installed wallet', async ({ page }) => {
    await page.click('#connectBtn');
    await page.click('[data-net="SOL"]');
    await expect(page.locator('#wchip')).toBeVisible();

    // The sandbox has no server to authenticate against, so asking a real
    // extension to authorise a fabricated address would be worse than not
    // asking. The picker must not open and the wallet must not be touched.
    await expect(page.locator('#walletScrim')).toBeHidden();
    expect(await walletRecord<string | undefined>(page, '__signedSiws')).toBeUndefined();
    expect(await walletRecord<string[]>(page, '__rpcCalls')).toEqual([]);
    // And it says so, rather than implying a settlement.
    await expect(page.locator('.mm-bubble', { hasText: 'SIMULATED' })).toBeVisible();
  });

  test('a sim trade still fills without a wallet, and says it is simulated', async ({ page }) => {
    await page.click('#connectBtn');
    await page.click('[data-net="SOL"]');
    const card = page.locator('#lane-new .coin').first();
    await card.click();
    await expect(page.locator('#tokenView')).toBeVisible();
    await page.fill('#t-amt', '0.5');
    await page.click('#t-go');
    await expect(page.locator('.mm-bubble', { hasText: /FILLED|was successful/ })).toBeVisible();
    expect(await walletRecord<string[]>(page, '__rpcCalls')).toEqual([]);
  });
});
